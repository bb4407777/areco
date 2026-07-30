#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qoder-llm-shim: 把 qoder CLI 包成 OpenAI 兼容 endpoint 供 Hermes 直连。

监听 127.0.0.1:8644, 暴露:
  GET  /v1/models            -> OpenAI models 列表
  POST /v1/chat/completions  -> 流式(SSE) / 非流式 chat.completion

每个请求 spawn:
  qoderclicn -p <prompt> -f stream-json -q -w <workdir> --tools "" \
             --permission-mode bypass_permissions -m <model>
把 qoder 的 stream-json 事件转成 OpenAI 格式。

为什么存在:
  qoder 没有 qclaw 那种现成的 OpenAI 兼容端点, 对外只有 CLI 子进程; 且 qoder 自身是
  agent(会调工具/改文件), 而 Hermes 要的是纯 chat completion model。故:
    --tools ""            禁全部内置工具, qoder 退化为纯 LLM(消除双重 agent)
    无状态拼 prompt       每次 messages 拼单 prompt, 不 resume(历史由 Hermes 管)
    累积式 text diff      qoder stream-json 的 assistant text 是同 msg id 累积前缀,
                          去 prev 取增量(逻辑搬自 ~/Code/cc-connect/agent/qoder/session.go)

红线: 本服务自测只打 127.0.0.1:8644, 不经 Hermes; 会话内不重启 Hermes gateway。
启用 qoder 由管理者会话外 `hermes-switch-model.py qoder` 执行。
"""
import json
import os
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

QODER_BIN = '/Users/gao/.local/bin/qoderclicn'
WORKDIR = '/Users/gao/.qclaw-hermes/qoder-shim-ws'
LISTEN = ('127.0.0.1', 8644)
DEFAULT_MODEL = 'Qwen3.8-Max-Preview'
MODELS = [
    'Auto', 'Qwen3.8-Max-Preview', 'Qwen3.7-Max', 'Qwen3.7-Plus', 'Qwen3.6-Flash',
    'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'GLM-5.2', 'Kimi-K2.7-Code', 'MiniMax-M2.7',
]
MAX_CONCURRENCY = 3      # qoder 冷启动重, 微信并发低
REQUEST_TIMEOUT = 180    # 单次推理上限, 防卡死
_sem = threading.Semaphore(MAX_CONCURRENCY)

ROLE_TAG = {'system': '系统指令', 'user': '用户', 'assistant': '助手', 'tool': '工具结果'}


def build_prompt(messages):
    """OpenAI messages 数组 -> qoder -p 单 prompt 字符串(role 标注拼接)。"""
    parts = []
    for m in messages or []:
        role = m.get('role', 'user')
        content = m.get('content', '')
        # 多模态 content(list) 只取 text 段(qoder CLI 不支持图)
        if isinstance(content, list):
            content = '\n'.join(
                c.get('text', '') for c in content
                if isinstance(c, dict) and c.get('type') == 'text'
            )
        if not isinstance(content, str):
            content = str(content)
        tag = ROLE_TAG.get(role, role)
        parts.append(f'[{tag}]\n{content}')
    return '\n\n'.join(parts)


class QoderRun:
    """spawn 一次 qoder, 逐块 yield 增量文本; 结束后属性存 final/rc/stderr。"""

    def __init__(self):
        self.final = None        # result 事件的最终文本(兜底)
        self.any_chunk = False   # 是否流式吐过任何文本
        self.rc = None
        self.stderr = ''

    def stream(self, prompt, model):
        args = [
            QODER_BIN, '-p', prompt, '-f', 'stream-json', '-q',
            '-w', WORKDIR, '--tools', '', '--permission-mode', 'bypass_permissions',
        ]
        if model:
            args += ['-m', model]

        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=WORKDIR,
        )

        stderr_buf = []

        def drain_stderr():
            try:
                for line in proc.stderr:
                    stderr_buf.append(line)
            except Exception:
                pass

        threading.Thread(target=drain_stderr, daemon=True).start()

        prev_by_id = {}   # message_id -> 已吐累积文本(去重用)
        deadline = time.time() + REQUEST_TIMEOUT
        try:
            for line in proc.stdout:
                if time.time() > deadline:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = ev.get('type')
                if t == 'assistant':
                    msg = ev.get('message') or {}
                    mid = msg.get('id', '')
                    items = msg.get('content') or []
                    if isinstance(items, list):
                        for it in items:
                            if not (isinstance(it, dict) and it.get('type') == 'text'):
                                continue
                            text = it.get('text', '')
                            if not text:
                                continue
                            chunk = self._diff(mid, text, prev_by_id)
                            if chunk:
                                self.any_chunk = True
                                yield chunk
                elif t == 'result':
                    self.final = self._extract_final(ev)
        finally:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            self.rc = proc.returncode
            self.stderr = ''.join(stderr_buf).strip()

    @staticmethod
    def _diff(mid, text, prev_by_id):
        """qoder 同 msg id 的 text 是累积前缀, 去前缀取增量(搬 session.go emitAssistantText)。"""
        prev = prev_by_id.get(mid, '')
        if text == prev:
            return ''
        if prev and text.startswith(prev):
            chunk = text[len(prev):]
            prev_by_id[mid] = text
            return chunk
        if prev:
            # 偶发的独立片段: 吐出片段, 记录拼接文本
            prev_by_id[mid] = prev + text
            return text
        prev_by_id[mid] = text
        return text

    @staticmethod
    def _extract_final(ev):
        ft = ''
        msg = ev.get('message')
        if msg:
            for it in (msg.get('content') or []):
                if isinstance(it, dict) and it.get('type') == 'text' and it.get('text'):
                    ft = it['text']
        if not ft and ev.get('result'):
            ft = ev['result']
        return ft or None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'qoder-llm-shim/1.0'

    # ---- helpers ----
    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, message, code='upstream_error'):
        self._send_json(status, {'error': {'message': message, 'type': code}})

    def _read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    # ---- routes ----
    def do_GET(self):
        path = self.path.split('?')[0].rstrip('/')
        if path in ('', '/health', '/'):
            self._send_json(200, {'status': 'ok'})
        elif path.endswith('/models'):
            self._send_json(200, {
                'object': 'list',
                'data': [{'id': m, 'object': 'model', 'owned_by': 'qoder'} for m in MODELS],
            })
        else:
            self._send_error(404, f'not found: {self.path}', 'not_found')

    def do_POST(self):
        path = self.path.split('?')[0].rstrip('/')
        if not path.endswith('/chat/completions'):
            self._send_error(404, f'not found: {self.path}', 'not_found')
            return
        self._handle_chat()

    def _handle_chat(self):
        body = self._read_body()
        if body is None:
            self._send_error(400, 'invalid JSON body')
            return
        messages = body.get('messages') or []
        if not messages:
            self._send_error(400, 'messages is required')
            return
        stream = bool(body.get('stream'))
        model = body.get('model') or DEFAULT_MODEL
        if model not in MODELS:
            model = DEFAULT_MODEL
        prompt = build_prompt(messages)

        if not _sem.acquire(timeout=30):
            self._send_error(503, 'qoder shim busy (max concurrency reached)', 'busy')
            return
        try:
            run = QoderRun()
            if stream:
                self._respond_stream(run, prompt, model)
            else:
                self._respond_full(run, prompt, model)
        finally:
            _sem.release()

    def _respond_stream(self, run, prompt, model):
        cid = 'chatcmpl-' + uuid.uuid4().hex
        created = int(time.time())

        def write_sse(delta, finish=None):
            chunk = {
                'id': cid, 'object': 'chat.completion.chunk',
                'created': created, 'model': model,
                'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
            }
            self.wfile.write(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode('utf-8'))
            self.wfile.flush()

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()

        started = False
        try:
            for text in run.stream(prompt, model):
                if not started:
                    write_sse({'role': 'assistant', 'content': ''})
                    started = True
                write_sse({'content': text})
        except Exception as e:
            self.wfile.write(('data: ' + json.dumps(
                {'error': {'message': f'stream error: {e}', 'type': 'server_error'}},
                ensure_ascii=False) + '\n\n').encode('utf-8'))
            self.wfile.flush()
            return

        # 流式中没吐过文本但 result 给了最终文本 -> 补吐
        if not started and run.final:
            write_sse({'role': 'assistant', 'content': run.final})
            started = True

        if not started:
            err = run.stderr or f'qoder produced no output (rc={run.rc})'
            self.wfile.write(('data: ' + json.dumps(
                {'error': {'message': err, 'type': 'upstream_error'}},
                ensure_ascii=False) + '\n\n').encode('utf-8'))
            self.wfile.flush()
            return

        write_sse({}, finish='stop')
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()

    def _respond_full(self, run, prompt, model):
        collected = []
        try:
            for text in run.stream(prompt, model):
                collected.append(text)
        except Exception as e:
            self._send_error(500, f'qoder run error: {e}')
            return

        content = ''.join(collected) or (run.final or '')
        if not content:
            err = run.stderr or f'qoder produced no output (rc={run.rc})'
            self._send_error(502, err)
            return

        self._send_json(200, {
            'id': 'chatcmpl-' + uuid.uuid4().hex,
            'object': 'chat.completion',
            'created': int(time.time()),
            'model': model,
            'choices': [{
                'index': 0,
                'message': {'role': 'assistant', 'content': content},
                'finish_reason': 'stop',
            }],
            'usage': {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0},
        })

    def log_message(self, fmt, *args):
        print('%s %s' % (self.address_string(), fmt % args), flush=True)


def main():
    os.makedirs(WORKDIR, exist_ok=True)
    print(f'qoder-llm-shim listening on {LISTEN[0]}:{LISTEN[1]} '
          f'-> {QODER_BIN} (workdir {WORKDIR}, default {DEFAULT_MODEL})', flush=True)
    ThreadingHTTPServer(LISTEN, Handler).serve_forever()


if __name__ == '__main__':
    main()
