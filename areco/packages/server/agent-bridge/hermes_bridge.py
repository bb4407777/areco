#!/usr/bin/env python3
"""Hermes agent-bridge sidecar（broker/worker 双角色）。

从零编写，依据 /tmp/bridge-design/design.md 的协议描述（该设计说明不含任何
hermes-studio / frakio-work 代码，可安全用于 Apache-2.0）。只调用 Hermes 的公开
Python API（run_agent.AIAgent 及其回调参数）。

形态：双角色单入口（设计 §0）——不带 --worker-profile 启动是 broker（只做
多 profile 路由：按需 Popen 派生 worker、维护路由表按 id 转发，本身不 import
run_agent、不实例化 AIAgent）；带 --worker-profile <名> 启动是 worker（跑真实
对话，一个 profile 一个独立进程，hermes-home 按 profile 隔离）。
传输：Unix domain socket，换行分隔 JSON（NDJSON），短连接请求-响应——
每次请求新建连接、写一行 JSON、读一行响应、关闭。服务端永不主动推送；
流式输出与事件全部由客户端轮询 get_output 用双游标（cursor / event_cursor）拉走。

MVP 动作集：ping / chat / get_output / get_result / interrupt / steer /
approval_respond / clarify_respond / context_estimate / title_generate /
background_poll / status / list / destroy / shutdown。
压缩协商不在内：hermes-studio 的压缩协商靠 monkeypatch 私有面实现，不是公开
API——Hermes 自带的 conversation_compression 本来就工作，不装私有补丁。

隔离默认：不指定 --hermes-home 时用 ~/.hermes-agent-bridge，绝不动生产
~/.qclaw-hermes。
"""

import argparse
import hashlib
import json
import os
import queue
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid

MAX_REQUEST_BYTES = 16 * 1024 * 1024
PREVIEW_CHARS = 500
IO_TIMEOUT_S = 300  # wait:true 的 chat 最长阻塞
FORWARD_TIMEOUT_S = 310  # broker 转发超时：要盖住 worker 端 wait:true chat 的 300s
WORKER_READY_TIMEOUT_S = 15  # broker 等 worker stdout 就绪行的上限

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


def _approval_timeout_ms():
    """审批等待上限读 approval.py 的口径（config approvals.timeout，默认 60s）。"""
    try:
        from tools.approval import _get_approval_timeout

        return int(_get_approval_timeout()) * 1000
    except Exception:
        return 60_000


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
        # 审批/澄清阻塞：approval_id/clarify_id → Queue（maxsize=1）。
        # 回调在 agent 线程上 queue.get(timeout) 阻塞；approval_respond/clarify_respond
        # 在请求线程上 put 解阻塞（设计 §3）。超时按 deny/提示继续收尾，绝不永久挂死。
        self.pending_approvals = {}   # approval_id -> {"queue": Queue, "allowed": [...]}
        self.pending_clarifies = {}   # clarify_id -> Queue

    def info(self):
        return {
            "session_id": self.session_id,
            "model": self.model,
            "provider": self.provider,
            "created_at": self.created_at,
            "last_active": self.last_active,
            "status": "running" if self.current_run and self.current_run.status == "running" else "idle",
            "run_count": len(self.runs),
            "pending_approvals": len(self.pending_approvals),
            "pending_clarifies": len(self.pending_clarifies),
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

        def on_approval_notify(approval_data):
            """gateway 式审批通知（agent 线程上调用，**非阻塞**）：登记 + 事件进缓冲。
            真正的阻塞在 approval.py 的 _await_gateway_decision 里（等 entry.event），
            approval_respond 动作经 resolve_gateway_approval 解阻塞——与微信 gateway
            同一套机制。choices 契约照 approval.py：smart_denied 只 once/deny；
            非永久 once/session/deny；allow_permanent 才出现 always。"""
            if os.environ.get("BRIDGE_DEBUG"):
                print(f"[bridge-debug] notify fired: {str(approval_data)[:120]}", file=sys.stderr, flush=True)
            approval_id = f"appr-{uuid.uuid4().hex[:12]}"
            allow_permanent = bool(approval_data.get("allow_permanent", True))
            smart_denied = bool(approval_data.get("smart_denied", False))
            if smart_denied:
                allowed = ["once", "deny"]
            elif allow_permanent:
                allowed = ["once", "session", "always", "deny"]
            else:
                allowed = ["once", "session", "deny"]
            sess.pending_approvals[approval_id] = {"allowed": allowed}
            run.append_event({
                "type": "approval.requested",
                "approval_id": approval_id,
                "command": _preview(approval_data.get("command", ""), 500),
                "description": _preview(approval_data.get("description", ""), 300),
                "choices": allowed,
                "allow_permanent": allow_permanent,
                "smart_denied": smart_denied,
                "timeout_ms": _approval_timeout_ms(),
            })

        def on_clarify(question, choices=None):
            """澄清阻塞（自有 queue，300s 超时）。超时不返空串——clarify_tool 会 str() 后
            原样回给 agent，给一句明确的「继续」指令比空回答有用。"""
            clarify_id = f"clar-{uuid.uuid4().hex[:12]}"
            q = queue.Queue(maxsize=1)
            sess.pending_clarifies[clarify_id] = q
            run.append_event({
                "type": "clarify.requested",
                "clarify_id": clarify_id,
                "question": _preview(question, 500),
                "choices": [_preview(c, 100) for c in (choices or [])],
                "timeout_ms": 300_000,
            })
            try:
                response = q.get(timeout=300)
                run.append_event({"type": "clarify.resolved", "clarify_id": clarify_id})
                return response
            except queue.Empty:
                run.append_event({"type": "clarify.timeout", "clarify_id": clarify_id})
                return "（等待 300 秒未获回答）按你的最佳判断继续，不要再问。"
            finally:
                sess.pending_clarifies.pop(clarify_id, None)

        agent.stream_delta_callback = on_stream_delta
        agent.tool_start_callback = on_tool_start
        agent.tool_complete_callback = on_tool_complete
        agent.status_callback = on_status
        agent.event_callback = on_event
        agent.clarify_callback = on_clarify

        approval_mod = None
        session_key_token = None
        try:
            # 审批走 gateway 机制：notify 回调按 session_key 注册（agent 线程收到通知），
            # 阻塞/解阻塞都在 approval.py 的会话队列里。session_key 经 contextvar 绑定，
            # 并发工具线程由 propagate_context_to_thread 带上同一份。
            from tools import approval as _ap
            approval_mod = _ap
            session_key_token = _ap.set_current_session_key(sess.session_id)
            _ap.register_gateway_notify(sess.session_id, on_approval_notify)
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
            if approval_mod is not None:
                # unregister 会顺带 set() 该会话所有挂起审批的 event——
                # 轮次结束/被打断时不留僵尸阻塞线程
                approval_mod.unregister_gateway_notify(sess.session_id)
                if session_key_token is not None:
                    approval_mod.reset_current_session_key(session_key_token)
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
        # 销毁时解掉所有挂起的审批/澄清——否则 agent 线程干等满超时。
        # 审批走 approval.py：unregister 会 set() 该会话全部挂起 entry（按 deny 类收场）；
        # 澄清是桥自有 queue，直接 put。
        try:
            from tools import approval as approval_mod

            approval_mod.unregister_gateway_notify(sess.session_id)
        except Exception:
            pass
        sess.pending_approvals.clear()
        for q in sess.pending_clarifies.values():
            try:
                q.put_nowait("（会话已销毁）")
            except queue.Full:
                pass
        return {"ok": True, "destroyed": True}

    # ---- 审批 / 澄清解阻塞（设计 §3）----

    def _find_pending(self, mapping, key):
        with self.lock:
            for sess in self.sessions.values():
                entry = mapping(sess).get(key)
                if entry is not None:
                    return sess, entry
        return None, None

    def action_approval_respond(self, req):
        approval_id = req.get("approval_id") or ""
        choice = req.get("choice") or ""
        sess, entry = self._find_pending(lambda s: s.pending_approvals, approval_id)
        if not entry:
            return {"ok": False, "resolved": False, "error": "未知或已超时的 approval_id", "error_type": "NotFound"}
        allowed = entry["allowed"]
        if choice not in allowed:
            return {"ok": False, "resolved": False, "error": f"choice 必须是 {allowed} 之一", "allowed_choices": allowed}
        # 解阻塞走 approval.py 的会话队列（FIFO 解最老一条；同会话 busy 锁保证
        # 同时只有一条阻塞审批，FIFO 即我们这条）
        from tools import approval as approval_mod

        n = approval_mod.resolve_gateway_approval(sess.session_id, choice)
        if n > 0:
            sess.pending_approvals.pop(approval_id, None)
            if sess.current_run:
                sess.current_run.append_event({"type": "approval.resolved", "approval_id": approval_id, "choice": choice})
        return {"ok": True, "resolved": n > 0, "allowed_choices": allowed}

    def action_clarify_respond(self, req):
        clarify_id = req.get("clarify_id") or ""
        response = req.get("response")
        if response is None:
            return {"ok": False, "resolved": False, "error": "clarify_respond 需要 response", "error_type": "ValueError"}
        _sess, q = self._find_pending(lambda s: s.pending_clarifies, clarify_id)
        if q is None:
            return {"ok": False, "resolved": False, "error": "未知或已超时的 clarify_id", "error_type": "NotFound"}
        q.put(str(response))
        return {"ok": True, "resolved": True}

    # ---- 无状态工具动作 ----

    def action_context_estimate(self, req):
        """估算一组 messages 的 token 占用（会话创建边界用）。公开工具函数，无状态。"""
        from agent.model_metadata import estimate_messages_tokens_rough

        messages = req.get("messages") or []
        if not isinstance(messages, list):
            return {"ok": False, "error": "messages 必须是数组", "error_type": "ValueError"}
        return {
            "ok": True,
            "tokens": estimate_messages_tokens_rough(_json_safe(messages)),
            "message_count": len(messages),
        }

    def action_title_generate(self, req):
        """无状态生成会话标题（hermes 自带 title_generator；无 auxiliary 配置时返回 None，调用方回落自命名）。"""
        from agent.title_generator import generate_title

        user_message = req.get("user_message") or ""
        assistant_response = req.get("assistant_response") or ""
        if not user_message:
            return {"ok": False, "error": "title_generate 需要 user_message", "error_type": "ValueError"}
        title = generate_title(user_message, assistant_response)
        return {"ok": True, "title": title}

    def action_background_poll(self, req):
        """后台委派状态（只读 HERMES_HOME 的 async_delegations 表）。
        delegation 未配置时表为空——如实返回空，不假装有机制在跑。"""
        import sqlite3

        db = os.path.join(os.environ.get("HERMES_HOME", ""), "state.db")
        if not os.path.exists(db):
            return {"ok": True, "pending_count": 0, "delegations": []}
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            cols = [r[1] for r in con.execute("PRAGMA table_info(async_delegations)")]
            rows = con.execute("SELECT * FROM async_delegations ORDER BY rowid DESC LIMIT 50").fetchall()
            items = [dict(zip(cols, row)) for row in rows]
            for it in items:  # 长字段截断，防一条委派结果撑爆响应
                for k, v in it.items():
                    if isinstance(v, str) and len(v) > 500:
                        it[k] = v[:500] + "…[truncated]"
            pending = sum(1 for it in items if str(it.get("status", "")) not in ("completed", "delivered", "failed"))
            return {"ok": True, "pending_count": pending, "delegations": _json_safe(items)}
        except sqlite3.OperationalError:
            return {"ok": True, "pending_count": 0, "delegations": []}  # 表不存在 = 没委派过
        finally:
            con.close()

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
        "approval_respond": action_approval_respond,
        "clarify_respond": action_clarify_respond,
        "context_estimate": action_context_estimate,
        "title_generate": action_title_generate,
        "background_poll": action_background_poll,
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


# ---------------------------------------------------------------- broker（多 profile 路由层）


class WorkerProc:
    """broker 眼里的一个 worker 子进程。"""

    def __init__(self, profile, endpoint, proc):
        self.profile = profile
        self.endpoint = endpoint
        self.proc = proc

    @property
    def running(self):
        return self.proc.poll() is None


class Broker:
    """只做路由：维护 worker 进程表 + id 路由表，把请求转发到对应 worker。
    不 import run_agent、不实例化 AIAgent——broker 进程本身不碰 Hermes 依赖。"""

    def __init__(self, args):
        self.args = args
        self.started_at = _utc_ms()
        self._shutdown = threading.Event()
        self.lock = threading.Lock()          # 护 workers / routes 两张表
        self._spawn_lock = threading.Lock()   # 派生 worker 串行化（就绪等待最长 15s，别用表锁陪绑）
        self.workers = {}  # profile -> WorkerProc
        self.routes = {}   # run_id/session_id/approval_id/clarify_id -> profile

    # ---- worker 进程表 ----

    def _worker_endpoint(self, profile):
        # 用 broker 自己的 endpoint 做派生键而不是 --key：manager 只传 --endpoint
        # 不传 --key，多个 broker（e2e / 生产）key 都是 default，用 endpoint 才互不撞车
        digest = hashlib.sha256(f"{self.args.endpoint}:{profile}".encode()).hexdigest()[:16]
        return f"ipc:///tmp/hermes-agent-bridge-{digest}.sock"

    def _purge_profile_locked(self, profile):
        """worker 死亡后的善后：摘进程表 + 清掉指向它的全部路由（锁内调用）。"""
        self.workers.pop(profile, None)
        self.routes = {k: v for k, v in self.routes.items() if v != profile}

    def _read_ready(self, proc, profile):
        """读 worker stdout 直到就绪行（select 限时，防 worker 挂死把 broker 拖死）。"""
        deadline = time.time() + WORKER_READY_TIMEOUT_S
        buf = b""
        while time.time() < deadline:
            r, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.time()))
            if not r:
                break  # 超时
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break  # EOF：worker 没打印就绪行就退了
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    msg = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    continue  # 非 JSON 行（依赖告警之类）忽略
                if msg.get("event") == "error":
                    raise RuntimeError(f"worker '{profile}' 启动失败: {msg.get('error')}")
                if msg.get("event") == "ready":
                    return msg
        proc.kill()
        raise RuntimeError(f"worker '{profile}' 就绪超时（{WORKER_READY_TIMEOUT_S}s，exit={proc.poll()}）")

    def _ensure_worker(self, profile):
        """查进程表，没有或已死就 Popen 派生并等就绪行；worker 是同一脚本带
        --worker-profile 启动，hermes-home 按 profile 隔离。"""
        with self.lock:
            w = self.workers.get(profile)
            if w and w.running:
                return w
        with self._spawn_lock:
            with self.lock:  # 双重检查：等 spawn 锁期间别的线程可能已经开好了
                w = self.workers.get(profile)
                if w and w.running:
                    return w
            endpoint = self._worker_endpoint(profile)
            home = os.path.join(self.args.hermes_home, "profiles", profile)
            os.makedirs(home, exist_ok=True)
            proc = subprocess.Popen(
                [sys.executable, os.path.abspath(__file__),
                 "--worker-profile", profile,
                 "--endpoint", endpoint,
                 "--hermes-config", self.args.hermes_config,
                 "--hermes-home", home,
                 "--provider", self.args.provider,
                 "--model", self.args.model],
                stdout=subprocess.PIPE,  # stderr 继承 → 汇进 broker 的 stderr，manager 看得到
            )
            try:
                self._read_ready(proc, profile)
            except Exception:
                with self.lock:
                    self._purge_profile_locked(profile)
                raise
            # 就绪后持续排干 stdout，防管道缓冲写满把 worker 憋死
            threading.Thread(target=self._drain, args=(proc,), daemon=True).start()
            w = WorkerProc(profile, endpoint, proc)
            with self.lock:
                self._purge_profile_locked(profile)  # 旧尸体（如有）的路由一并清
                self.workers[profile] = w
            return w

    @staticmethod
    def _drain(proc):
        try:
            while os.read(proc.stdout.fileno(), 65536):
                pass
        except (OSError, ValueError):
            pass

    # ---- 路由表 ----

    def _scan_register(self, profile, node):
        """递归扫响应 JSON，把出现的 run/session/approval/clarify id 都登记进路由表
        （锁内调用）——approval_id/clarify_id 是在 get_output 的 events 里半路冒出的。"""
        if isinstance(node, dict):
            for k, v in node.items():
                if k in ("run_id", "session_id", "approval_id", "clarify_id") and isinstance(v, str) and v:
                    self.routes[v] = profile
                else:
                    self._scan_register(profile, v)
        elif isinstance(node, list):
            for v in node:
                self._scan_register(profile, v)

    def _route_to(self, key):
        """按 id 查路由表 → (profile, worker)。worker 已死则清表返空——
        id 对应的运行状态随 worker 一起没了，重生也救不回，如实 NotFound。"""
        with self.lock:
            profile = self.routes.get(key)
            w = self.workers.get(profile) if profile else None
        if profile and (w is None or not w.running):
            with self.lock:
                self._purge_profile_locked(profile)
            return None, None
        return profile, w

    # ---- 转发 ----

    def _forward(self, worker, req, timeout=FORWARD_TIMEOUT_S):
        """与客户端同形状的短连接：新建连接 → 写一行请求 → 读一行响应 → 关闭。"""
        path = worker.endpoint[len("ipc://"):] if worker.endpoint.startswith("ipc://") else worker.endpoint
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(timeout)
        try:
            conn.connect(path)
            conn.sendall(json.dumps(req, ensure_ascii=False).encode("utf-8") + b"\n")
            conn.shutdown(socket.SHUT_WR)  # 半关，与 Node client 同形状
            raw = _read_line(conn)
            if not raw:
                raise ConnectionError("worker 空响应")
            return json.loads(raw.decode("utf-8"))
        finally:
            conn.close()

    def _forward_and_register(self, profile, worker, req):
        try:
            resp = self._forward(worker, req)
        except Exception as exc:
            return {"ok": False, "error": f"转发 worker '{profile}' 失败: {exc}", "error_type": "WorkerUnreachable"}
        with self.lock:
            self._scan_register(profile, resp)
        return resp

    # ---- 动作 ----

    def action_chat(self, req):
        if not req.get("message"):
            return {"ok": False, "error": "chat 需要 message", "error_type": "ValueError"}
        profile = str(req.get("profile") or "default")
        try:
            w = self._ensure_worker(profile)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "error_type": "WorkerSpawnError"}
        return self._forward_and_register(profile, w, {**req, "profile": profile})

    def _action_by_id(self, req, id_field):
        key = req.get(id_field) or ""
        profile, w = self._route_to(key)
        if w is None:
            return {"ok": False, "error": f"路由表查不到 {id_field}: {key}", "error_type": "NotFound"}
        return self._forward_and_register(profile, w, req)

    def action_get_output(self, req):
        return self._action_by_id(req, "run_id")

    def action_get_result(self, req):
        return self._action_by_id(req, "run_id")

    def action_interrupt(self, req):
        return self._action_by_id(req, "session_id")

    def action_steer(self, req):
        return self._action_by_id(req, "session_id")

    def action_status(self, req):
        return self._action_by_id(req, "session_id")

    def action_approval_respond(self, req):
        return self._action_by_id(req, "approval_id")

    def action_clarify_respond(self, req):
        return self._action_by_id(req, "clarify_id")

    def action_destroy(self, req):
        resp = self._action_by_id(req, "session_id")
        sid = req.get("session_id") or ""
        if resp.get("ok") and sid:
            with self.lock:  # 会话没了，入口路由摘了；其 run 条目留死不碍事（worker 侧也 NotFound）
                self.routes.pop(sid, None)
        return resp

    def _action_profile_scoped(self, req):
        """context_estimate/title_generate：实现只在 worker 进程里（broker 不 import
        run_agent），虽无状态也得按 profile 转发到 worker 执行。"""
        profile = str(req.get("profile") or "default")
        try:
            w = self._ensure_worker(profile)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "error_type": "WorkerSpawnError"}
        return self._forward_and_register(profile, w, req)

    def action_ping(self, _req):
        """broker 自答 + 逐个 worker 转发 ping 汇总；只探已存在的 worker，不为 ping 派生新的。"""
        with self.lock:
            items = list(self.workers.items())
        workers = []
        for profile, w in items:
            entry = {"profile": profile, "pid": w.proc.pid, "endpoint": w.endpoint,
                     "running": w.running, "sessions": 0}
            if w.running:
                try:
                    resp = self._forward(w, {"action": "ping"}, timeout=5)
                    if resp.get("ok"):
                        entry["sessions"] = resp.get("sessions", 0)
                    else:
                        entry["running"] = False
                except Exception:
                    entry["running"] = False
            workers.append(entry)
        return {
            "ok": True,
            "pong": True,
            "broker": True,
            "pid": os.getpid(),
            "uptime_ms": _utc_ms() - self.started_at,
            "workers": workers,
        }

    def action_worker_ping(self, req):
        profile = str(req.get("profile") or "default")
        try:
            w = self._ensure_worker(profile)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "error_type": "WorkerSpawnError"}
        try:
            return self._forward(w, {"action": "ping"}, timeout=10)
        except Exception as exc:
            return {"ok": False, "error": f"转发 worker '{profile}' 失败: {exc}", "error_type": "WorkerUnreachable"}

    def action_list(self, _req):
        """fan-out 到所有活着的 worker 合并 sessions，每项标注 profile。"""
        with self.lock:
            items = list(self.workers.items())
        sessions = []
        errors = []
        for profile, w in items:
            if not w.running:
                with self.lock:
                    self._purge_profile_locked(profile)
                continue
            try:
                resp = self._forward(w, {"action": "list"}, timeout=10)
            except Exception as exc:
                errors.append({"profile": profile, "error": str(exc)})
                continue
            for s in resp.get("sessions") or []:
                sessions.append({**s, "profile": profile} if isinstance(s, dict) else s)
        out = {"ok": True, "sessions": sessions}
        if errors:
            out["errors"] = errors
        return out

    def action_background_poll(self, req):
        """后台委派状态 fan-out 合并；worker 都没起就如实报空。"""
        with self.lock:
            items = list(self.workers.items())
        pending = 0
        delegations = []
        for profile, w in items:
            if not w.running:
                continue
            try:
                resp = self._forward(w, req, timeout=10)
            except Exception:
                continue
            if resp.get("ok"):
                pending += resp.get("pending_count") or 0
                for d in resp.get("delegations") or []:
                    delegations.append({**d, "profile": profile} if isinstance(d, dict) else d)
        return {"ok": True, "pending_count": pending, "delegations": delegations}

    def action_shutdown(self, _req):
        threading.Thread(target=self._do_shutdown, daemon=True).start()
        return {"ok": True, "shutting_down": True}

    def _do_shutdown(self):
        """级联停机：先给所有 worker 发 shutdown，等最多 3s，再退自己
        （自己 socket 文件的清理由 serve() 退出路径负责）。"""
        with self.lock:
            items = list(self.workers.items())
        for _profile, w in items:
            if w.running:
                try:
                    self._forward(w, {"action": "shutdown"}, timeout=3)
                except Exception:
                    pass
        deadline = time.time() + 3
        for _profile, w in items:
            try:
                w.proc.wait(timeout=max(0, deadline - time.time()))
            except Exception:
                pass  # 没收住的交给 worker 自己的 broker 看门狗兜底
        self._shutdown.set()

    # ---- 派发 ----

    HANDLERS = {
        "ping": action_ping,
        "worker_ping": action_worker_ping,
        "chat": action_chat,
        "get_output": action_get_output,
        "get_result": action_get_result,
        "interrupt": action_interrupt,
        "steer": action_steer,
        "approval_respond": action_approval_respond,
        "clarify_respond": action_clarify_respond,
        "context_estimate": _action_profile_scoped,
        "title_generate": _action_profile_scoped,
        "background_poll": action_background_poll,
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


def _worker_watchdog(broker_pid):
    """broker 看门狗（设计 §0 防孤儿）：broker 消失则 worker 自杀。
    判消失两条：ppid 变了（broker 死后 worker 被 reparent 到 launchd），
    或 pid 已被系统回收。只在 worker 角色下启动。"""
    while True:
        time.sleep(5)
        if os.getppid() != broker_pid:
            os._exit(0)
        try:
            os.kill(broker_pid, 0)
        except OSError:
            os._exit(0)


def main():
    ap = argparse.ArgumentParser(description="Hermes agent-bridge sidecar（broker/worker 双角色）")
    ap.add_argument("--endpoint", help="ipc:///path/to.sock；缺省按 key 派生")
    ap.add_argument("--key", default="default", help="派生 endpoint 用的键")
    ap.add_argument("--hermes-config", default=os.path.expanduser("~/.qclaw-hermes/config.yaml"))
    ap.add_argument("--hermes-home", default=os.path.expanduser("~/.hermes-agent-bridge"),
                    help="隔离的 HERMES_HOME；不要指向生产 ~/.qclaw-hermes")
    ap.add_argument("--provider", default="qclaw")
    ap.add_argument("--model", default="pool-deepseek-v4-flash")
    ap.add_argument("--worker-profile",
                    help="带此参数即 worker 角色（隶属某 profile，由 broker 派生）；不带即 broker 路由层")
    args = ap.parse_args()

    # HERMES_HOME 必须在 import run_agent 之前落地
    os.environ["HERMES_HOME"] = args.hermes_home
    os.makedirs(args.hermes_home, exist_ok=True)

    endpoint = args.endpoint
    if not endpoint:
        digest = hashlib.sha256(args.key.encode()).hexdigest()[:16]
        endpoint = f"ipc:///tmp/hermes-agent-bridge-{digest}.sock"
    args.endpoint = endpoint  # 归一化：broker 派生 worker endpoint 要用到

    if not args.worker_profile:
        # ---- broker：只做路由，不 import run_agent、不实例化 AIAgent ----
        broker = Broker(args)
        signal.signal(signal.SIGTERM, lambda *_: broker._shutdown.set())
        signal.signal(signal.SIGINT, lambda *_: broker._shutdown.set())
        serve(broker, endpoint)
        return

    # ---- worker：跑真实对话（broker 派生；import 探测只在这支做，broker 不需要）----
    try:
        import run_agent  # noqa: F401 —— 探测依赖，失败趁早
    except ImportError as exc:
        print(json.dumps({"event": "error", "error": f"找不到 run_agent: {exc}"}), flush=True)
        sys.exit(2)

    # 审批上下文：bridge 非交互 CLI，approval.py 需要 gateway 语境才会询问——
    # 平台标记让 _is_gateway_approval_context() 为真，审批走 register_gateway_notify
    # 回调 + resolve_gateway_approval 解阻塞（与微信 gateway 同一机制）。
    # setdefault：运维可用环境变量覆盖。
    os.environ.setdefault("HERMES_SESSION_PLATFORM", "bridge")

    bridge = Bridge(args)
    signal.signal(signal.SIGTERM, lambda *_: bridge._shutdown.set())
    signal.signal(signal.SIGINT, lambda *_: bridge._shutdown.set())
    threading.Thread(target=_worker_watchdog, args=(os.getppid(),), daemon=True).start()
    serve(bridge, endpoint)


if __name__ == "__main__":
    main()
