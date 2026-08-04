#!/usr/bin/env python3
"""Hermes agent-bridge sidecar（MVP，单 worker 版）。

从零编写，依据 /tmp/bridge-design/design.md 的协议描述（该设计说明不含任何
hermes-studio / frakio-work 代码，可安全用于 Apache-2.0）。只调用 Hermes 的公开
Python API（run_agent.AIAgent 及其回调参数）。

形态：单进程 = 单 worker（MVP 砍掉了多 profile broker 路由，见设计 §4）。
传输：Unix domain socket，换行分隔 JSON（NDJSON），短连接请求-响应——
每次请求新建连接、写一行 JSON、读一行响应、关闭。服务端永不主动推送；
流式输出与事件全部由客户端轮询 get_output 用双游标（cursor / event_cursor）拉走。

MVP 动作集：ping / chat / get_output / get_result / interrupt / steer /
status / list / destroy / shutdown。审批、澄清、压缩协商、后台委派不在 MVP 内。

隔离默认：不指定 --hermes-home 时用 ~/.hermes-agent-bridge，绝不动生产
~/.qclaw-hermes。
"""

import argparse
import hashlib
import json
import os
import queue
import signal
import socket
import sys
import threading
import time
import traceback
import uuid

MAX_REQUEST_BYTES = 16 * 1024 * 1024
PREVIEW_CHARS = 500
IO_TIMEOUT_S = 300  # wait:true 的 chat 最长阻塞

# ---------------------------------------------------------------- 工具


def _json_safe(value, depth=0):
    """把任意值压成可 JSON 序列化的形状。"""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if depth > 6:
        return repr(value)
    if isinstance(value, dict):
        return {str(k): _json_safe(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v, depth + 1) for v in value]
    return repr(value)


def _preview(value, chars=PREVIEW_CHARS):
    if value is None:
        return ""
    if not isinstance(value, str):
        try:
            value = json.dumps(_json_safe(value), ensure_ascii=False)
        except Exception:
            value = repr(value)
    return value if len(value) <= chars else value[:chars] + "…[truncated]"


def _utc_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- 运行记录


class Run:
    """一轮对话。output 是文本总缓冲，events 是结构化事件总缓冲；
    客户端用 cursor / event_cursor 双游标拉增量。"""

    def __init__(self, run_id, session_id):
        self.run_id = run_id
        self.session_id = session_id
        self.status = "running"  # running | complete | error | interrupted
        self.output_parts = []
        self.events = []
        self.result = None
        self.error = None
        self.started_at = _utc_ms()
        self.ended_at = None
        self.done_event = threading.Event()
        self.lock = threading.Lock()

    # ---- 回调侧（跑在 agent 线程上）----

    def append_delta(self, text):
        with self.lock:
            self.output_parts.append(text)

    def append_event(self, event):
        event.setdefault("ts", _utc_ms())
        with self.lock:
            self.events.append(event)

    def finish(self, status, result=None, error=None):
        with self.lock:
            self.status = status
            self.result = result
            self.error = error
            self.ended_at = _utc_ms()
        self.done_event.set()

    # ---- 拉取侧（跑在请求线程上）----

    def snapshot(self, cursor=0, event_cursor=0):
        with self.lock:
            output = "".join(self.output_parts)
            cursor = max(0, min(cursor, len(output)))
            event_cursor = max(0, min(event_cursor, len(self.events)))
            return {
                "run_id": self.run_id,
                "session_id": self.session_id,
                "status": self.status,
                "output": output,
                "delta": output[cursor:],
                "cursor": len(output),
                "events": list(self.events[event_cursor:]),
                "event_cursor": len(self.events),
                "done": self.status != "running",
                "result": self.result if self.status != "running" else None,
                "error": self.error,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
            }


# ---------------------------------------------------------------- 会话


class Session:
    def __init__(self, session_id, agent, model, provider):
        self.session_id = session_id
        self.agent = agent
        self.model = model
        self.provider = provider
        self.created_at = _utc_ms()
        self.last_active = _utc_ms()
        self.busy = threading.Lock()  # 同一会话同时只跑一轮
        self.current_run = None
        self.runs = {}  # run_id -> Run（保留历史，get_result 可查）
        # 跨轮上下文：run_conversation 每轮从 conversation_history 全新起步
        # （turn_context.py:429 messages = list(conversation_history)），agent 内部
        # 不存历史——bridge 必须自己攒，每轮用 result["messages"] 全量替换。
        self.history = []

    def info(self):
        return {
            "session_id": self.session_id,
            "model": self.model,
            "provider": self.provider,
            "created_at": self.created_at,
            "last_active": self.last_active,
            "status": "running" if self.current_run and self.current_run.status == "running" else "idle",
            "run_count": len(self.runs),
        }


# ---------------------------------------------------------------- 桥本体


class Bridge:
    def __init__(self, args):
        self.args = args
        self.sessions = {}
        self.lock = threading.Lock()
        self.started_at = _utc_ms()
        self._shutdown = threading.Event()
        self._provider_cfg = None  # 惰性读 hermes config

    # ---- 配置 ----

    def _load_provider(self, provider_name):
        """从 hermes config.yaml 取 provider 连接参数。凭据只进内存，不打印。"""
        if self._provider_cfg is None:
            import yaml

            with open(self.args.hermes_config, "r", encoding="utf-8") as f:
                self._provider_cfg = yaml.safe_load(f) or {}
        provs = self._provider_cfg.get("providers") or {}
        cfg = provs.get(provider_name)
        if not cfg:
            raise KeyError(f"provider '{provider_name}' 不在 {self.args.hermes_config}")
        return cfg

    # ---- 会话 ----

    def _create_agent(self, session_id, provider_name, model, toolsets, instructions):
        from run_agent import AIAgent

        pcfg = self._load_provider(provider_name)
        return AIAgent(
            base_url=pcfg.get("base_url"),
            api_key=pcfg.get("api_key"),
            provider=provider_name,
            api_mode=pcfg.get("api_mode"),
            model=model,
            session_id=session_id,
            enabled_toolsets=toolsets if toolsets else None,
            quiet_mode=True,
            platform="cli",
            skip_memory=True,
            skip_context_files=True,
            ephemeral_system_prompt=instructions or None,
        )

    def _get_or_create_session(self, req):
        session_id = req.get("session_id") or f"bridge-{uuid.uuid4().hex[:12]}"
        with self.lock:
            sess = self.sessions.get(session_id)
            if sess is None:
                provider_name = req.get("provider") or self.args.provider
                model = req.get("model") or self.args.model
                sess = Session(
                    session_id,
                    self._create_agent(
                        session_id,
                        provider_name,
                        model,
                        req.get("toolsets"),
                        req.get("instructions"),
                    ),
                    model,
                    provider_name,
                )
                self.sessions[session_id] = sess
        return sess

    # ---- 一轮对话 ----

    def action_chat(self, req):
        message = req.get("message")
        if not message:
            return {"ok": False, "error": "chat 需要 message", "error_type": "ValueError"}
        sess = self._get_or_create_session(req)
        if not sess.busy.acquire(blocking=False):
            return {
                "ok": False,
                "error": f"会话 {sess.session_id} 正在跑上一轮；用 steer 插话或 interrupt 打断",
                "error_type": "SessionBusy",
                "session_id": sess.session_id,
            }
        run = Run(f"run-{uuid.uuid4().hex[:12]}", sess.session_id)
        sess.current_run = run
        sess.runs[run.run_id] = run
        sess.last_active = _utc_ms()
        # 首轮可用 conversation_history 播种；之后会话内累积的 history 权威
        if not sess.history and req.get("conversation_history"):
            sess.history = _json_safe(req["conversation_history"])

        t = threading.Thread(
            target=self._run_turn,
            args=(sess, run, message, req.get("instructions")),
            name=f"bridge-{sess.session_id}-{run.run_id}",
            daemon=True,
        )
        t.start()

        if req.get("wait"):
            run.done_event.wait(timeout=req.get("timeout") or IO_TIMEOUT_S)
            snap = run.snapshot()
            return {"ok": True, **snap}
        return {"ok": True, "run_id": run.run_id, "session_id": sess.session_id, "status": "running"}

    def _run_turn(self, sess, run, message, instructions):
        agent = sess.agent

        # --- 回调 → 事件/文本缓冲（设计 §0：服务端不推，全进缓冲等拉）---
        def on_stream_delta(delta):
            if delta:  # None 表示一段结束，忽略
                run.append_delta(delta)

        def on_tool_start(tool_call_id, name, args):
            run.append_event({
                "type": "tool.started",
                "tool_call_id": tool_call_id,
                "name": name,
                "args_preview": _preview(args, 200),
            })

        def on_tool_complete(tool_call_id, name, args, result):
            is_error = False
            if isinstance(result, dict):
                is_error = bool(result.get("is_error") or result.get("error"))
            run.append_event({
                "type": "tool.completed",
                "tool_call_id": tool_call_id,
                "name": name,
                "result_preview": _preview(result),
                "is_error": is_error,
            })

        def on_status(kind, msg):
            run.append_event({"type": f"lifecycle.{kind}", "message": _preview(msg, 300)})

        def on_event(name, payload):
            run.append_event({"type": name, **(_json_safe(payload) if isinstance(payload, dict) else {"data": _preview(payload)})})

        agent.stream_delta_callback = on_stream_delta
        agent.tool_start_callback = on_tool_start
        agent.tool_complete_callback = on_tool_complete
        agent.status_callback = on_status
        agent.event_callback = on_event

        try:
            result = agent.run_conversation(
                message,
                system_message=instructions or None,
                conversation_history=sess.history or None,
            )
            # 每轮结束用 result["messages"] 全量替换会话历史（见 Session.history 注释）
            if isinstance(result, dict):
                msgs = result.get("messages")
                if isinstance(msgs, list) and msgs:
                    sess.history = _json_safe(msgs)
                interrupted = bool(result.get("interrupted"))
                failed = bool(result.get("failed"))
            else:
                interrupted = False
                failed = False
            # is_interrupted 是 @property 不是方法（run_agent.py:3797），别加括号
            attr = getattr(agent, "is_interrupted", False)
            interrupted = interrupted or bool(attr() if callable(attr) else attr)
            status = "interrupted" if interrupted else ("error" if failed else "complete")
            run.finish(status, result=_json_safe(result))
        except Exception as exc:  # agent 内部异常不能弄死 worker
            run.append_event({"type": "run.error", "error": str(exc)})
            run.finish("error", error=f"{type(exc).__name__}: {exc}")
            traceback.print_exc(file=sys.stderr)
        finally:
            sess.busy.release()

    # ---- 拉取 ----

    def _find_run(self, run_id):
        with self.lock:
            for sess in self.sessions.values():
                run = sess.runs.get(run_id)
                if run:
                    return run
        return None

    def action_get_output(self, req):
        run = self._find_run(req.get("run_id") or "")
        if not run:
            return {"ok": False, "error": "未知 run_id", "error_type": "NotFound"}
        snap = run.snapshot(int(req.get("cursor") or 0), int(req.get("event_cursor") or 0))
        return {"ok": True, **snap}

    def action_get_result(self, req):
        run = self._find_run(req.get("run_id") or "")
        if not run:
            return {"ok": False, "error": "未知 run_id", "error_type": "NotFound"}
        snap = run.snapshot(0, 0)
        return {"ok": True, **snap}

    # ---- 控制 ----

    def action_interrupt(self, req):
        sess = self.sessions.get(req.get("session_id") or "")
        if not sess:
            return {"ok": False, "error": "未知 session_id", "error_type": "NotFound"}
        run = sess.current_run
        if not run or run.status != "running":
            return {"ok": True, "interrupted": False, "reason": "没有正在跑的轮次"}
        sess.agent.interrupt(req.get("message"))
        return {"ok": True, "interrupted": True, "run_id": run.run_id}

    def action_steer(self, req):
        sess = self.sessions.get(req.get("session_id") or "")
        if not sess:
            return {"ok": False, "error": "未知 session_id", "error_type": "NotFound"}
        text = req.get("text")
        if not text:
            return {"ok": False, "error": "steer 需要 text", "error_type": "ValueError"}
        accepted = sess.agent.steer(text)
        return {"ok": True, "steered": bool(accepted)}

    def action_status(self, req):
        sess = self.sessions.get(req.get("session_id") or "")
        if not sess:
            return {"ok": True, "exists": False}
        out = {"ok": True, "exists": True, **sess.info()}
        if sess.current_run:
            out["current_run"] = {
                "run_id": sess.current_run.run_id,
                "status": sess.current_run.status,
                "started_at": sess.current_run.started_at,
            }
        return out

    def action_list(self, _req):
        with self.lock:
            return {"ok": True, "sessions": [s.info() for s in self.sessions.values()]}

    def action_destroy(self, req):
        session_id = req.get("session_id") or ""
        with self.lock:
            sess = self.sessions.pop(session_id, None)
        if not sess:
            return {"ok": True, "destroyed": False, "reason": "未知 session_id"}
        try:
            if sess.current_run and sess.current_run.status == "running":
                sess.agent.interrupt("session destroyed")
                sess.current_run.done_event.wait(timeout=10)
            sess.agent.close()
        except Exception:
            pass
        return {"ok": True, "destroyed": True}

    def action_ping(self, _req):
        with self.lock:
            infos = [s.info() for s in self.sessions.values()]
        return {
            "ok": True,
            "pong": True,
            "pid": os.getpid(),
            "uptime_ms": _utc_ms() - self.started_at,
            "sessions": len(infos),
            "running": sum(1 for i in infos if i["status"] == "running"),
        }

    def action_shutdown(self, _req):
        threading.Thread(target=self._do_shutdown, daemon=True).start()
        return {"ok": True, "shutting_down": True}

    def _do_shutdown(self):
        self._shutdown.set()

    # ---- 派发 ----

    HANDLERS = {
        "ping": action_ping,
        "chat": action_chat,
        "get_output": action_get_output,
        "get_result": action_get_result,
        "interrupt": action_interrupt,
        "steer": action_steer,
        "status": action_status,
        "list": action_list,
        "destroy": action_destroy,
        "shutdown": action_shutdown,
    }

    def handle(self, req):
        action = req.get("action")
        handler = self.HANDLERS.get(action)
        if not handler:
            return {"ok": False, "error": f"未知 action: {action}", "error_type": "UnknownAction"}
        try:
            return handler(self, req)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "error_type": type(exc).__name__}


# ---------------------------------------------------------------- socket 服务


def _read_line(conn, cap=MAX_REQUEST_BYTES):
    buf = bytearray()
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf.extend(chunk)
        nl = buf.find(b"\n")
        if nl >= 0:
            return bytes(buf[:nl])
        if len(buf) > cap:
            raise ValueError("请求超过大小上限")
    return bytes(buf)


def serve(bridge, endpoint):
    if endpoint.startswith("ipc://"):
        path = endpoint[len("ipc://"):]
    else:
        path = endpoint
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(64)
    srv.settimeout(0.5)
    os.chmod(path, 0o600)

    # 就绪握手：manager 监听子进程 stdout 的这一行
    print(json.dumps({"event": "ready", "endpoint": f"ipc://{path}", "pid": os.getpid()}), flush=True)

    def handle_conn(conn):
        try:
            conn.settimeout(IO_TIMEOUT_S)
            raw = _read_line(conn)
            if not raw:
                return
            req = json.loads(raw.decode("utf-8"))
            resp = bridge.handle(req)
        except Exception as exc:
            resp = {"ok": False, "error": str(exc), "error_type": type(exc).__name__}
        try:
            conn.sendall(json.dumps(resp, ensure_ascii=False).encode("utf-8") + b"\n")
        except OSError:
            pass
        finally:
            conn.close()

    while not bridge._shutdown.is_set():
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=handle_conn, args=(conn,), daemon=True).start()

    srv.close()
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------- 入口


def main():
    ap = argparse.ArgumentParser(description="Hermes agent-bridge sidecar (MVP)")
    ap.add_argument("--endpoint", help="ipc:///path/to.sock；缺省按 key 派生")
    ap.add_argument("--key", default="default", help="派生 endpoint 用的键")
    ap.add_argument("--hermes-config", default=os.path.expanduser("~/.qclaw-hermes/config.yaml"))
    ap.add_argument("--hermes-home", default=os.path.expanduser("~/.hermes-agent-bridge"),
                    help="隔离的 HERMES_HOME；不要指向生产 ~/.qclaw-hermes")
    ap.add_argument("--provider", default="qclaw")
    ap.add_argument("--model", default="pool-deepseek-v4-flash")
    args = ap.parse_args()

    # HERMES_HOME 必须在 import run_agent 之前落地
    os.environ["HERMES_HOME"] = args.hermes_home
    os.makedirs(args.hermes_home, exist_ok=True)

    endpoint = args.endpoint
    if not endpoint:
        digest = hashlib.sha256(args.key.encode()).hexdigest()[:16]
        endpoint = f"ipc:///tmp/hermes-agent-bridge-{digest}.sock"

    try:
        import run_agent  # noqa: F401 —— 探测依赖，失败趁早
    except ImportError as exc:
        print(json.dumps({"event": "error", "error": f"找不到 run_agent: {exc}"}), flush=True)
        sys.exit(2)

    bridge = Bridge(args)
    signal.signal(signal.SIGTERM, lambda *_: bridge._shutdown.set())
    signal.signal(signal.SIGINT, lambda *_: bridge._shutdown.set())
    serve(bridge, endpoint)


if __name__ == "__main__":
    main()
