#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qclaw-reasonix-shim: 把 QClaw model pool 包成 OpenAI 兼容 endpoint 供 Reasonix 直连。

监听 127.0.0.1:8645, 暴露:
  GET  /v1/models            -> OpenAI models 列表(来自 QClaw model pool)
  POST /v1/chat/completions  -> 流式(SSE) / 非流式 chat.completion

底层架构:
  - /v1/models 从 http://127.0.0.1:19000/proxy/llm/models 获取真实模型池列表
  - /v1/chat/completions 转发到 OpenClaw Gateway (127.0.0.1:<GW_PORT>),
    注入 auth token, 并将 Reasonix 传的 model id 映射为 x-openclaw-model header

环境变量:
  QCLAW_REASONIX_PORT      (默认 8645)
  QCLAW_GATEWAY_TOKEN      (默认从 ~/.qclaw/openclaw.json 读取)
  QCLAW_GATEWAY_PORT       (默认 63547)
  QCLAW_MODELS_API_URL     (默认 http://127.0.0.1:19000/proxy/llm)

红线: 本服务只监听 127.0.0.1, 不经 Heremes; 会话内不重启 Hermes gateway。
"""
import json
import os
import re
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import URLError

# ── 默认配置 ──

_CONFIG_HOME = os.path.expanduser("~/.qclaw")

def _read_gateway_token():
    """从 ~/.qclaw/openclaw.json 读取 gateway auth token。"""
    path = os.path.join(_CONFIG_HOME, "openclaw.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
        tok = cfg.get("gateway", {}).get("auth", {}).get("token")
        if tok:
            return tok
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass
    return None

DEFAULT_PORT = int(os.environ.get("QCLAW_REASONIX_PORT", "8645"))
GATEWAY_PORT = int(os.environ.get("QCLAW_GATEWAY_PORT", "63547"))
GATEWAY_TOKEN = os.environ.get("QCLAW_GATEWAY_TOKEN") or _read_gateway_token()
MODELS_API = os.environ.get("QCLAW_MODELS_API_URL", "http://127.0.0.1:19000/proxy/llm").rstrip("/")

LISTEN = ("127.0.0.1", DEFAULT_PORT)

# ── 工具名前缀映射（2026-07-25）──
# OpenClaw gateway 会把与自身保留名冲突的工具（实测 bash/grep/ls/web_fetch，集合会动态变化）
# 判为 invalid tool configuration。这里在请求侧给所有工具名加 rx__ 前缀，
# 响应侧（含 SSE 流）再把 "name":"rx__ 还原为 "name":"，对 Reasonix 完全透明。
TOOL_PREFIX = "rx__"

def _rename_tools_in_request(body):
    """结构化改写请求体里的工具名：tools[] 与历史 messages 里的 tool_calls/tool 消息。"""
    for t in body.get("tools") or []:
        fn = t.get("function") or {}
        name = fn.get("name")
        if name and not name.startswith(TOOL_PREFIX):
            fn["name"] = TOOL_PREFIX + name
    for m in body.get("messages") or []:
        name = m.get("name")
        if name and not name.startswith(TOOL_PREFIX):
            m["name"] = TOOL_PREFIX + name
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            name = fn.get("name")
            if name and not name.startswith(TOOL_PREFIX):
                fn["name"] = TOOL_PREFIX + name
    # tool_choice 指定具体工具时也要改
    tc = body.get("tool_choice")
    if isinstance(tc, dict):
        fn = tc.get("function") or {}
        name = fn.get("name")
        if name and not name.startswith(TOOL_PREFIX):
            fn["name"] = TOOL_PREFIX + name

def _restore_tools_in_response(data):
    """非流式响应：把 tool_calls 里的 rx__ 前缀剥掉，还原 Reasonix 认识的工具名。"""
    for ch in data.get("choices") or []:
        msg = ch.get("message") or {}
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            name = fn.get("name")
            if name and name.startswith(TOOL_PREFIX):
                fn["name"] = name[len(TOOL_PREFIX):]

# 流式响应字节级改写（边界安全：保留 pattern 长度-1 的尾部做跨块匹配）
_STREAM_PATTERNS = [
    (f'"name":"{TOOL_PREFIX}'.encode(), b'"name":"'),
    (f'"name": "{TOOL_PREFIX}'.encode(), b'"name": "'),
]
_STREAM_HOLD = max(len(p) for p, _ in _STREAM_PATTERNS) - 1

def _stream_restore_names(body_iter):
    pending = b""
    for chunk in body_iter:
        data = pending + chunk
        if len(data) <= _STREAM_HOLD:
            pending = data
            continue
        head, pending = data[:-_STREAM_HOLD], data[-_STREAM_HOLD:]
        for pat, rep in _STREAM_PATTERNS:
            head = head.replace(pat, rep)
        if head:
            yield head
    if pending:
        for pat, rep in _STREAM_PATTERNS:
            pending = pending.replace(pat, rep)
        yield pending

# ── 模型池缓存 ──

_models_cache = None
_models_cache_at = 0
_MODELS_CACHE_TTL = 300  # 5 min

def fetch_model_pool():
    """从 QClaw auth gateway 获取模型池列表, 缓存的周期 5 分钟。"""
    global _models_cache, _models_cache_at
    now = time.time()
    if _models_cache and (now - _models_cache_at) < _MODELS_CACHE_TTL:
        return _models_cache

    url = f"{MODELS_API}/models"
    try:
        req = Request(url)
        with urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[shim] ⚠️  models fetch failed: {e}", flush=True)
        if _models_cache:
            return _models_cache
        # 兜底: 返回静态模型列表
        body = {"data": []}

    models = []
    for item in body.get("data", []):
        mid = item.get("id", "")
        if not mid:
            continue
        models.append({
            "id": mid,
            "object": "model",
            "created": item.get("created", 0),
            "owned_by": item.get("owned_by", "qclaw"),
            "name": item.get("name", mid),
            "description": item.get("description", ""),
        })

    _models_cache = models
    _models_cache_at = now
    print(f"[shim] models cache refreshed: {len(models)} models", flush=True)
    return models


# ── Gateway 转发 ──

def call_gateway(payload, stream=False):
    """向 OpenClaw Gateway 转发 chat/completions 请求并返回响应。

    把 Reasonix 传入的 model id (如 pool-deepseek-v4-flash) 映射到
    model=openclaw/default + x-openclaw-model header。

    Args:
        payload: dict, 原始 OpenAI 请求 body
        stream: bool, 是否流式
    Returns:
        (status, headers, body_iterable) 其中 body_iterable 是字节块迭代器
    """
    assert GATEWAY_TOKEN, "GATEWAY_TOKEN not set"

    model_id = payload.get("model", "pool-deepseek-v4-flash")
    # 翻译模型名: 把 Reasonix 传的真实模型 ID 放到 x-openclaw-model header
    # model 字段固定用 openclaw/main (当前默认会话 agent)
    
    gateway_payload = dict(payload)
    gateway_payload["model"] = "openclaw/default"

    body_bytes = json.dumps(gateway_payload, ensure_ascii=False).encode("utf-8")

    gate_url = f"http://127.0.0.1:{GATEWAY_PORT}/v1/chat/completions"

    headers = {
        "Authorization": f"Bearer {GATEWAY_TOKEN}",
        "Content-Type": "application/json",
        "x-openclaw-model": model_id,
    }

    req = Request(gate_url, data=body_bytes, headers=headers, method="POST")
    
    try:
        resp = urlopen(req, timeout=600)  # long timeout for thinking models
    except URLError as e:
        # 尝试读取错误 body
        err_body = b""
        if hasattr(e, 'read') and callable(e.read):
            try:
                err_body = e.read()
            except Exception:
                pass
        if hasattr(e, 'code') and e.code:
            return (e.code, {"Content-Type": "application/json"}, [err_body or json.dumps({"error":{"message":str(e)}}).encode()])
        return (502, {"Content-Type": "application/json"}, [json.dumps({"error":{"message":f"Gateway unreachable: {e}"}}).encode()])

    status = resp.status
    resp_headers = dict(resp.headers)

    if stream:
        # 流式: 逐块 yield（先过工具名还原过滤器）
        def _stream():
            try:
                for chunk in _stream_restore_names(iter(lambda: resp.read(4096), b"")):
                    yield chunk
            finally:
                resp.close()
        return (status, resp_headers, _stream())
    else:
        body = resp.read()
        resp.close()
        # 把 model 字段替换回原始 model ID (shim 透明)
        try:
            data = json.loads(body)
            if isinstance(data, dict):
                data["model"] = model_id
                _restore_tools_in_response(data)
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        except (json.JSONDecodeError, TypeError):
            pass
        return (status, resp_headers, [body])


# ── HTTP handler ──

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qclaw-reasonix-shim/1.0"

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, message, code="upstream_error"):
        self._send_json(status, {"error": {"message": message, "type": code}})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    # ---- CORS preflight ----
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    # ---- routes ----
    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path in ("", "/health", "/"):
            self._send_json(200, {"status": "ok", "gateway_port": GATEWAY_PORT, "models_api": MODELS_API})
        elif path == "/v1/models":
            models = fetch_model_pool()
            self._send_json(200, {
                "object": "list",
                "data": models,
            })
        else:
            self._send_error(404, f"not found: {self.path}")

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if not path.endswith("/chat/completions"):
            self._send_error(404, f"not found: {self.path}")
            return
        self._handle_chat()

    def _handle_chat(self):
        body = self._read_body()
        if body is None:
            self._send_error(400, "invalid JSON body")
            return

        # 临时诊断：落盘请求体（2026-07-25 排查 invalid tool configuration）
        try:
            with open("/tmp/shim-dump.jsonl", "a") as df:
                df.write(json.dumps({"ts": time.time(), "body": body}, ensure_ascii=False) + "\n")
        except Exception:
            pass

        # 请求侧工具名前缀映射（绕开 gateway 保留名冲突：bash/grep/ls/web_fetch 等）
        _rename_tools_in_request(body)

        messages = body.get("messages") or []
        if not messages:
            self._send_error(400, "messages is required")
            return

        stream = bool(body.get("stream", False))
        
        # Capture model for response
        model_id = body.get("model", "pool-deepseek-v4-flash")

        # 检查 gateway token
        if not GATEWAY_TOKEN:
            self._send_error(502, "GATEWAY_TOKEN not configured — set QCLAW_GATEWAY_TOKEN env or fix ~/.qclaw/openclaw.json")
            return

        if stream:
            self._handle_stream(body, model_id)
        else:
            self._handle_nonstream(body, model_id)

    def _handle_stream(self, body, model_id):
        status, headers, body_iter = call_gateway(body, stream=True)

        self.send_response(status)
        # 强制 SSE 内容类型
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        # 如果 upstream 返回的不是 200, 按 SSE 格式广播错误
        if status != 200:
            err_body = b"".join(body_iter) if hasattr(body_iter, '__iter__') else b""
            err_text = err_body.decode("utf-8", errors="replace") if err_body else f"upstream returned {status}"
            self.wfile.write(f"data: {json.dumps({'error':{'message':err_text,'type':'upstream_error'}})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        # 转发 SSE 流, 同时替换 model 字段
        raw_model = model_id.encode()
        # 必须写一个缓冲区来匹配事件边界
        try:
            for chunk in body_iter:
                if not chunk:
                    continue
                # SSE 事件是逐行 data: ...\n\n, 替换 model 引用
                # 替换 upstream 返回的 "model":"openclaw/default" -> "model":"<raw_model_id>"
                decoded = chunk.decode("utf-8", errors="replace")
                decoded = decoded.replace('"model":"openclaw/default"', f'"model":"{model_id}"')
                self.wfile.write(decoded.encode("utf-8"))
                self.wfile.flush()
        except BrokenPipeError:
            pass
        except Exception as e:
            print(f"[shim] stream error: {e}", flush=True)

    def _handle_nonstream(self, body, model_id):
        status, headers, body_iter = call_gateway(body, stream=False)
        body_bytes = b"".join(body_iter)

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body_bytes)
        self.wfile.flush()

    def log_message(self, fmt, *args):
        print(f"[shim] {self.address_string()} {fmt % args}", flush=True)


# ── 入口 ──

def main():
    # 预检
    os.makedirs(_CONFIG_HOME, exist_ok=True)

    if not GATEWAY_TOKEN:
        print("[shim] ⚠️  GATEWAY_TOKEN not found — set QCLAW_GATEWAY_TOKEN env", flush=True)
    else:
        print(f"[shim] ✓ gateway token loaded (len={len(GATEWAY_TOKEN)})", flush=True)

    # 预取模型列表
    try:
        models = fetch_model_pool()
        names = [m["id"] for m in models[:8]]
        extra = f"+{len(models)-8} more" if len(models) > 8 else ""
        print(f"[shim] ✓ models prefetched: {', '.join(names)} {extra}".strip(), flush=True)
    except Exception as e:
        print(f"[shim] ⚠️  models prefetch failed (will retry on demand): {e}", flush=True)

    print(f"", flush=True)
    print(f"╔═══════════════════════════════════════════════════╗", flush=True)
    print(f"║  QClaw → Reasonix shim                          ║", flush=True)
    print(f"║  Listening: http://{LISTEN[0]}:{LISTEN[1]}       ║", flush=True)
    print(f"║  Gateway:   http://127.0.0.1:{GATEWAY_PORT}     ║", flush=True)
    print(f"║  Models:    {MODELS_API}/models                  ║", flush=True)
    print(f"╚═══════════════════════════════════════════════════╝", flush=True)
    print(f"[shim] ready", flush=True)

    ThreadingHTTPServer(LISTEN, Handler).serve_forever()


if __name__ == "__main__":
    main()
