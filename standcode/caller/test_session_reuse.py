#!/usr/bin/env python3
"""旧会话优先复用（2026-07-29 高律师令）的离线测试：
复用判据 a 空闲 / b 上下文未近满 / c 干净上下文标记，擂台/法律案件强制新会话例外，
route_reason 决策可见性，以及 dispatch 集成（复用路不建房不 spawn）。

全程不碰 areco、不烧额度——REST 层 monkeypatch，审计/台账落隔离目录。
跑法：python3 caller/test_session_reuse.py   （零依赖，不需要 pytest）
"""
import json
import os
import pathlib
import sys
import tempfile

# 离线隔离（与 test_guards.py 同口径）：必须在 import caller 之前落
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-reuse-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_UNHEALTHY", os.path.join(_TEST_ISO, "unhealthy.json"))

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

PASS = []


def check(name: str, cond: bool, detail: str = ""):
    PASS.append((name, cond))
    print(f"{'✓' if cond else '✗'} {name}" + (f"  ({detail})" if detail and not cond else ""))


def _sess(**kw):
    base = {
        "id": "sess-1", "templateId": "claude-fable5", "status": "running",
        "archived": False, "roomId": "room-1", "trafficState": "conclusion",
        "trafficUpdatedAt": 1000,
    }
    base.update(kw)
    return base


def _room(**kw):
    base = {
        "id": "room-1", "team": "team-1", "name": "⚙施工·旧会话abcd",
        "members": [{"kind": "session", "name": "Worker-c5", "sessionId": "sess-1"}],
    }
    base.update(kw)
    return base


def _caller(sessions, rooms, ctx=None):
    """造一个 REST 层全 mock 的 Caller：会话/房间列表与上下文用量都由测试喂。"""
    c = C.Caller()
    c.list_sessions = lambda: sessions
    c.list_rooms = lambda: rooms
    c._session_context_tokens = lambda s: ctx
    return c


# ── 判据 c + 例外（_session_reuse_decision 层）────────────────────────
c = _caller([], [])

stand, reason = c._session_reuse_decision("claude-fable5", "把 caller.py 的注释改一下", fresh=True)
check("fresh=True → 新会话", stand is None and "干净上下文" in reason, reason)

stand, reason = c._session_reuse_decision("claude-fable5", "这个任务需要干净上下文，别带旧记忆")
check("正文含「干净上下文」标记 → 新会话", stand is None and "干净上下文" in reason, reason)

stand, reason = c._session_reuse_decision("claude-fable5", "两个模型擂台对比同一道题")
check("擂台 → 强制新会话（公平性）", stand is None and "擂台" in reason, reason)

stand, reason = c._session_reuse_decision("claude-fable5", "跑一轮 benchmark 看分数")
check("benchmark(ASCII 小写) → 强制新会话", stand is None and "擂台" in reason, reason)

stand, reason = c._session_reuse_decision("claude-fable5", "核实某案件判决书的金额")
check("法律案件词 → 强制新会话（防串味）", stand is None and "法律案件" in reason, reason)

_orig = C.SESSION_REUSE_ENABLED
C.SESSION_REUSE_ENABLED = False
stand, reason = c._session_reuse_decision("claude-fable5", "改代码")
check("开关关 → 新会话", stand is None and "SESSION_REUSE_ENABLED" in reason, reason)
C.SESSION_REUSE_ENABLED = _orig

# ── 判据 a/b（find_reusable_session 层）──────────────────────────────
c = _caller([_sess()], [_room()], ctx=50_000)
stand, reason = c.find_reusable_session("claude-fable5")
check("空闲旧会话 → 复用命中", stand is not None and stand["kind"] == "session_reuse"
      and stand["room_created"] is False and stand["stand_name"] == "Worker-c5"
      and "复用旧会话(命中缓存" in reason, reason)

c = _caller([_sess(trafficState="working")], [_room()])
stand, reason = c.find_reusable_session("claude-fable5")
check("working → 无空闲", stand is None and "无空闲" in reason, reason)

c = _caller([_sess(trafficState="needs-user")], [_room()])
stand, reason = c.find_reusable_session("claude-fable5")
check("needs-user（屏上挂待选框）→ 无空闲", stand is None and "无空闲" in reason, reason)

c = _caller([_sess(trafficState="")], [_room()])
stand, reason = c.find_reusable_session("claude-fable5")
check("红绿灯查无值 → 按忙处理不复用", stand is None, reason)

c = _caller([_sess(status="exited")], [_room()])
stand, reason = c.find_reusable_session("claude-fable5")
check("进程已死 → 无空闲", stand is None and "无空闲" in reason, reason)

c = _caller([_sess(templateId="hy3")], [_room()])
stand, reason = c.find_reusable_session("claude-fable5")
check("不同模板 → 无空闲", stand is None and "无空闲" in reason, reason)

c = _caller([_sess()], [_room()], ctx=C.SESSION_REUSE_CONTEXT_LIMIT + 1)
stand, reason = c.find_reusable_session("claude-fable5")
check("上下文近满 → 新会话", stand is None and "近满" in reason, reason)

c = _caller([_sess()], [_room()], ctx=None)
stand, reason = c.find_reusable_session("claude-fable5")
check("上下文用量不可得 → 凭 areco 空闲信号放行（不硬编）",
      stand is not None and "上下文用量不可得" in reason, reason)

c = _caller([_sess()], [], ctx=1000)  # 房间列表为空（已归档/查无）
stand, reason = c.find_reusable_session("claude-fable5")
check("所在房间不可用 → 新会话", stand is None and "房间不可用" in reason, reason)

_busy = _sess(id="sess-busy", trafficState="working", trafficUpdatedAt=2000)
_idle = _sess(id="sess-1", trafficState="conclusion", trafficUpdatedAt=1000)
c = _caller([_busy, _idle], [_room()], ctx=1000)
stand, reason = c.find_reusable_session("claude-fable5")
check("忙的跳过、空闲的命中", stand is not None and stand["stand_session_id"] == "sess-1", reason)

# ── _session_context_tokens：真 transcript 读取 ─────────────────────
c = C.Caller()
tdir = pathlib.Path(_TEST_ISO) / "transcripts"
tdir.mkdir(parents=True, exist_ok=True)
(tdir / "csid-1.jsonl").write_text(
    json.dumps({"message": {"usage": {"input_tokens": 100, "cache_read_input_tokens": 200,
                                      "cache_creation_input_tokens": 50}}}) + "\n"
    + json.dumps({"message": {"usage": {"input_tokens": 3000, "cache_read_input_tokens": 5000,
                                        "cache_creation_input_tokens": 200}}}) + "\n",
    encoding="utf-8",
)
ctx = c._session_context_tokens({"claudeSessionId": "csid-1", "transcriptDir": str(tdir)})
check("transcript 尾条 usage 求和 = 当前上下文量", ctx == 8200, str(ctx))
check("无 transcript → None（不硬编）",
      c._session_context_tokens({"claudeSessionId": None, "transcriptDir": None}) is None)

# ── dispatch 集成：复用路不建房不 spawn，route_reason 落结果与审计 ────
c = _caller([_sess()], [_room()], ctx=1000)
c._assert_template_exists = lambda tid: None
c.send_message = lambda team, stand, req: 42
d = c.dispatch("把 caller.py 的注释改一下", template_id="claude-fable5", mode="worker")
check("dispatch 复用路：route_reason 写明命中缓存",
      d.get("route_reason", "").startswith("复用旧会话(命中缓存"), d.get("route_reason", ""))
check("dispatch 复用路：不建房不 spawn",
      d.get("room_created") is False and d.get("stand_reused") is True
      and d.get("room_id") == "room-1" and d.get("message_id") == 42,
      json.dumps({k: d.get(k) for k in ("room_created", "stand_reused", "room_id")}))

c2 = _caller([], [])  # 无任何会话 → 新会话
c2._assert_template_exists = lambda tid: None
made = {}
c2.create_room = lambda name: made.setdefault("room", {"id": "room-new", "team": "team-new",
                                                       "name": name})
c2.add_stand = lambda rid, tid, cwd=None: {"name": "Worker-c5-new", "sessionId": "sess-new"}
c2.send_message = lambda team, stand, req: 7
import caller as _C_mod  # BOOT_WAIT 置零，离线测试别真睡
_orig_boot = _C_mod.BOOT_WAIT_SEC
_C_mod.BOOT_WAIT_SEC = 0
d2 = c2.dispatch("把 caller.py 的注释改一下", template_id="claude-fable5", mode="worker")
_C_mod.BOOT_WAIT_SEC = _orig_boot
check("dispatch 无空闲：route_reason 写明新会话原因",
      d2.get("route_reason", "").startswith("新会话(无空闲"), d2.get("route_reason", ""))
check("dispatch 新会话路：建房 + add_stand",
      d2.get("room_created") is True and d2.get("stand_reused") is False, "")

d3 = c2.dispatch("核实某案件判决书的金额", template_id="claude-fable5", mode="worker")
check("dispatch 法律案件：route_reason 写明隔离原因",
      "法律案件" in d3.get("route_reason", ""), d3.get("route_reason", ""))

audit = pathlib.Path(os.environ["STANDCODE_AUDIT_LOG"]).read_text(encoding="utf-8")
check("route_reason 进审计 jsonl", '"route_reason": "复用旧会话(命中缓存' in audit
      and '"route_reason": "新会话(' in audit)

# ── 汇总 ─────────────────────────────────────────────────────────────
failed = [n for n, ok in PASS if not ok]
print(f"\n{len(PASS) - len(failed)}/{len(PASS)} 通过")
if failed:
    print("失败:", *failed, sep="\n  - ")
    sys.exit(1)
print("ALL GREEN")
