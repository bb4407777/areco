#!/usr/bin/env python3
"""ask 通道离线测试：通道解析 / 探灯路由 / 直投形状 / 席位竞态。

全程不碰 areco、不烧额度——REST 层打桩，消息层用真 SQLite 临时库。
跑法：python3 caller/test_ask.py   （零依赖，不需要 pytest）

为什么值得有：ask 的判据是「探灯 → 直投/并行」的路由决策——判错的代价不是崩溃，
是又把任务排进正忙的常驻会话（用户 2026-07-26 点名要修的正是它），不会报错、只会变慢。
"""
import json
import os
import pathlib
import sys
import tempfile

# 离线测试环境隔离（口径同 test_modes.py 头部 _TEST_ISO，改前先读那边注释）
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_ASK_CLAIMS_DIR", os.path.join(_TEST_ISO, "ask-claims"))
os.environ.setdefault("STANDCODE_STANDBY", "off")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


ROOM = {
    "id": "chan01", "team": "room-chan01", "name": "问菲克问题", "archivedAt": None,
    "members": [
        {"name": "高律师", "kind": "human", "sessionId": None},
        {"name": "Fable5", "kind": "session", "sessionId": "sess-fable"},
    ],
}


def _mk(sessions=None, rooms=None, db_path=None):
    """打桩 Caller：REST 层换成本地字典，消息层指向临时 SQLite。"""
    c = C.Caller(projects_db=db_path or os.path.join(_TEST_ISO, "projects.db"))
    c.list_rooms = lambda include_archived=False: list(
        rooms if rooms is not None else [ROOM])
    smap = {s["id"]: s for s in (sessions or [])}
    c._session_info = lambda sid: smap.get(sid)
    return c


# ── resolve_ask_channel：定位与漂移兜底 ────────────────────────────
def test_resolve() -> None:
    print("\n[resolve_ask_channel] 通道定位")
    sess = {"id": "sess-fable", "status": "running", "trafficState": "conclusion",
            "templateId": "c5"}
    ch = _mk([sess]).resolve_ask_channel(room_id="chan01", member="Fable5")
    check(ch["ok"] and ch["team"] == "room-chan01" and ch["session_id"] == "sess-fable",
          "显式 room_id 命中")
    check(ch["template_id"] == "c5", "fork 模板取自会话 templateId")

    ch = _mk([sess]).resolve_ask_channel(room_id="", member="Fable5")
    check(ch["ok"] and ch["room_id"] == "chan01", "room_id 未配时按成员名唯一定位")

    ch = _mk([sess]).resolve_ask_channel(room_id="gone99", member="Fable5")
    check(ch["ok"] and ch["room_id"] == "chan01", "配置 room_id 漂移（房间消失）→ 成员名搜索兜底")

    two = [ROOM, {**ROOM, "id": "chan02", "team": "room-chan02"}]
    ch = _mk([sess], rooms=two).resolve_ask_channel(room_id="", member="Fable5")
    check(not ch["ok"] and "无法唯一定位" in ch["reason"], "成员出现在多房 → 不猜，报不可用")

    ch = _mk([sess], rooms=[]).resolve_ask_channel(room_id="", member="Fable5")
    check(not ch["ok"] and ch["template_id"], "全找不到 → 不可用但仍给 fork 模板兜底")


# ── ask_channel_probe：红绿灯 → 路由 ───────────────────────────────
def test_probe() -> None:
    print("\n[ask_channel_probe] 探灯路由")
    base = {"ok": True, "member": "Fable5", "session_id": "sess-fable"}
    cases = [
        # (session 对象, 期望路由, 场景)
        ({"status": "running", "trafficState": "conclusion"}, "direct", "conclusion=空闲直投"),
        ({"status": "running", "trafficState": "idle"}, "direct", "idle=空闲直投"),
        ({"status": "running", "trafficState": "working"}, "fork", "working=忙→并行"),
        ({"status": "running", "trafficState": "needs-user"}, "fork", "needs-user=卡框→并行"),
        ({"status": "exited", "trafficState": "exited"}, "direct", "exited=投递自动 resume，可直投"),
        ({"status": "error", "trafficState": ""}, "fork", "error 会话→并行保交付"),
        (None, "fork", "会话查无→并行保交付"),
    ]
    for sess, exp, label in cases:
        route, reason = C.Caller.ask_channel_probe({**base, "session": sess})
        check(route == exp, f"{label}（判 {route}：{reason[:36]}）")
    route, _ = C.Caller.ask_channel_probe({"ok": False, "reason": "x"})
    check(route == "fork", "通道不可用→并行")


# ── dispatch_to_channel：直投形状与纪律 ────────────────────────────
def test_direct_dispatch() -> None:
    print("\n[dispatch_to_channel] 直投")
    db = os.path.join(_TEST_ISO, "direct.db")
    sess = {"id": "sess-fable", "status": "running", "trafficState": "idle",
            "templateId": "c5"}
    c = _mk([sess], db_path=db)
    ch = c.resolve_ask_channel(room_id="chan01", member="Fable5")
    crumbs: list[dict] = []
    c._on_dispatch = crumbs.append
    d = c.dispatch_to_channel("查一下 X", ch)
    check(d["session_id"] == "room-chan01" and d["stand_name"] == "Fable5",
          "结果形状与 dispatch() 对齐（session_id=team / stand_name=成员）")
    check(d["room_created"] is False and d.get("ask_direct") is True,
          "room_created=False（常驻房永不归档）")
    check(d["message_id"] > 0, "消息已落库")
    msgs = c.get_messages("room-chan01")
    check(len(msgs) == 1 and msgs[0]["to_agent"] == "Fable5"
          and msgs[0]["from_agent"] == C.CALLER_NAME,
          "消息 to=Fable5 from=Caller（human_relay 投递）")
    check(len(crumbs) == 1 and crumbs[0]["message_id"] == d["message_id"],
          "面包屑回调已触发（reconcile 依赖）")
    ledger = pathlib.Path(os.environ["STANDCODE_ROOMS_LEDGER"])
    check(not ledger.exists() or "chan01" not in ledger.read_text(),
          "常驻房不进 rooms 台账（防被 sweep 当自家房清扫）")
    try:
        c.dispatch_to_channel("rm -rf / 全盘清空", ch)
        check(False, "BLOCKED 红线应拒绝")
    except C.GatekeeperBlockedError:
        check(True, "BLOCKED 红线直投同样硬拒")


# ── 席位 claim：同轮并发闸 ─────────────────────────────────────────
def test_claim() -> None:
    print("\n[ask claim] 直投席位竞态")
    sid = "sess-claim-t"
    check(C.acquire_ask_claim(sid, "task-a"), "首个 ask 抢到席位")
    check(not C.acquire_ask_claim(sid, "task-b"), "并发第二个 ask 抢不到（持有者=本进程，活着）")
    C.release_ask_claim(sid, "task-b")
    check(C._ask_claim_path(sid).exists(), "释放校验 task_id：别人释放不掉我的席位")
    C.release_ask_claim(sid, "task-a")
    check(not C._ask_claim_path(sid).exists(), "持有者正常释放")
    # 陈锁夺取：持有者 pid 已死（写个不存在的 pid）
    C._ask_claim_path(sid).parent.mkdir(parents=True, exist_ok=True)
    C._ask_claim_path(sid).write_text(json.dumps({"pid": 99999999, "task_id": "task-dead"}))
    check(C.acquire_ask_claim(sid, "task-c"), "持有者进程已死 → 夺陈锁成功")
    C.release_ask_claim(sid, "task-c")
    check(not C.acquire_ask_claim("", "task-x"), "session_id 为空 → 不抢（直投都投不了）")


def main() -> int:
    test_resolve()
    test_probe()
    test_direct_dispatch()
    test_claim()
    print(f"\n{'全部通过' if not _fails else '失败 ' + str(len(_fails)) + ' 项'}"
          f"（隔离目录 {_TEST_ISO}）")
    for f in _fails:
        print(f"  ✗ {f}")
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(main())
