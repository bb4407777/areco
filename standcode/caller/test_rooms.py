#!/usr/bin/env python3
"""房间来源标记 / 台账 / 自动归档 自测

离线部分（默认跑）：不碰 areco，只验纯逻辑——
    - _room_label 带来源标记且标记在最前（边栏截断保得住）
    - 台账 append-only + 折叠读（后写覆盖前写）
    - is_standcode_room 的三级判据（台账 > 标记 > 旧命名），外部房间不误判
    - finish_room 的「不归档」分支：复用房间 / 未完成 / 开关关闭（这三支在发请求前返回）

在线部分（--live）：真建一个测试房间，验证 finish_room 成功路径确实归档。
    测试房间跑完留在「已归档」（不删——删除按章程要用户点头），id 会打印出来。

用法:
    python3 caller/test_rooms.py
    python3 caller/test_rooms.py --live
"""
import json
import os
import sys
import tempfile
from pathlib import Path

# _TEST_ISO：离线测试环境隔离（同 test_modes.py 口径）——audit/tasks/台账/暖池全落
# 临时目录，暖池关掉，别再往生产 audit.jsonl 灌桩事件。--live 在线部分同样适用：
# 它建的是真房间，但属测试流量，不该进生产报表。
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_STANDBY", "off")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caller as C  # noqa: E402

PASS, FAIL = "✅", "❌"
_failed = 0


def check(cond: bool, label: str) -> None:
    global _failed
    print(f"{PASS if cond else FAIL} {label}")
    if not cond:
        _failed += 1


def test_room_label() -> None:
    name = C._room_label("把这份判决书整理成时间线", None, "worker")
    check(name.startswith(C.ROOM_MARK), f"标记在最前: {name}")
    check("把这份判决书整理成时间线"[:16] in name, f"任务语义仍在: {name}")
    check(name.rstrip().endswith(name[-5:]) and "·W" in name, f"角色+hex 尾巴保留: {name}")
    # 边栏截断到 8 字时，标记仍在（这正是加标记的理由）
    check(name[:8].startswith(C.ROOM_MARK), "截断到 8 字仍看得见标记")


def test_ledger(tmp: Path) -> None:
    C.ROOMS_LEDGER_PATH = tmp / "rooms.jsonl"
    C.ledger_append("created", "aaa111", task_id="t1", role="worker")
    C.ledger_append("created", "bbb222", task_id="t2", role="thinker")
    C.ledger_append("archived", "aaa111", by="auto")
    led = C.ledger_load()
    check(set(led) == {"aaa111", "bbb222"}, "两个房间都在台账里")
    check(led["aaa111"]["event"] == "archived", "同 room 后写覆盖前写（created→archived）")
    check(led["aaa111"]["task_id"] == "t1", "覆盖是合并不是替换：早前字段仍在")
    check(led["bbb222"]["event"] == "created", "另一个房间不受影响")
    # 脏行不能带崩读取（append-only 最多损失最后一条）
    with C.ROOMS_LEDGER_PATH.open("a") as f:
        f.write("{半行坏 json\n")
    check(len(C.ledger_load()) == 2, "脏行跳过，台账仍可读")


def test_is_standcode_room(tmp: Path) -> None:
    C.ROOMS_LEDGER_PATH = tmp / "rooms2.jsonl"
    C.ledger_append("created", "led001", task_id="t3")
    led = C.ledger_load()
    cases = [
        ({"id": "led001", "name": "用户后来改的名字"}, True, "台账认得（改名也认）"),
        ({"id": "x1", "name": f"{C.ROOM_MARK}房源纠纷调研…·W1a2b"}, True, "标记认得"),
        ({"id": "x2", "name": "Stand-worker-general-6b295e"}, True, "旧命名认得"),
        ({"id": "x3", "name": "调研一下…·T9f0c"}, True, "新命名尾巴认得"),
        ({"id": "x4", "name": "StandCode 搭建"}, False, "同名人建房间不误判"),
        ({"id": "x5", "name": "26咨0701吴景豪vs中国人寿"}, False, "案件房不误判"),
    ]
    for room, want, label in cases:
        check(C.is_standcode_room(room, led) is want, label)


def test_finish_room_branches(tmp: Path) -> None:
    """三个「不归档」分支都在发 HTTP 前返回，所以可以不连 areco 直接验"""
    C.ROOMS_LEDGER_PATH = tmp / "rooms3.jsonl"
    c = C.Caller.__new__(C.Caller)  # 不跑 __init__：本分支不需要连接
    r = c.finish_room({"room_id": "r1", "room_created": False, "task_id": "t"}, "completed")
    check(r == {"archived": False, "room_id": "r1", "reason": "reused_room"}, "复用房间不归档")
    r = c.finish_room({"room_id": "r2", "room_created": True, "task_id": "t"}, "timeout")
    check(r["reason"] == "not_completed" and not r["archived"], "未完成不归档（留看板看现场）")
    r = c.finish_room({"room_created": True, "task_id": "t"}, "completed")
    check(r["reason"] == "no_room", "无房间号安全返回")
    old, C.AUTO_ARCHIVE = C.AUTO_ARCHIVE, False
    try:
        r = c.finish_room({"room_id": "r3", "room_created": True, "task_id": "t"}, "completed")
        check(r["reason"] == "auto_archive_off", "开关关闭时不归档")
    finally:
        C.AUTO_ARCHIVE = old
    led = C.ledger_load()
    check(
        all(led[k]["event"] == "kept" for k in ("r1", "r2", "r3")),
        "不归档的决定同样落台账（event=kept，带 reason）",
    )


def test_live() -> None:
    """真建房间 → finish_room 成功路径 → 验 areco 侧 archivedAt 落位"""
    c = C.Caller()
    room = c.create_room(f"{C.ROOM_MARK}自检-归档收口·W0000")
    rid = room["id"]
    print(f"   测试房间: {rid} {room['name']}")
    try:
        res = c.finish_room({"room_id": rid, "room_created": True, "task_id": "selftest"}, "completed")
        check(res["archived"] is True, "finish_room 报告已归档")
        live = next((r for r in c.list_rooms(include_archived=True) if r["id"] == rid), None)
        check(live is not None and live.get("archivedAt") is not None, "areco 侧 archivedAt 已落位")
        check(rid not in {r["id"] for r in c.list_rooms()}, "默认 list_rooms 不再返回它")
        check(C.ledger_load().get(rid, {}).get("event") == "archived", "台账记到 archived")
    finally:
        print(f"   ↳ 测试房间留在「已归档」不删（删除按章程需你点头）: {rid}")


def main() -> int:
    live = "--live" in sys.argv
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        real_ledger = C.ROOMS_LEDGER_PATH
        print("── 离线 ──")
        test_room_label()
        test_ledger(tmp)
        test_is_standcode_room(tmp)
        test_finish_room_branches(tmp)
        if live:
            print("── 在线（--live，真连 areco）──")
            C.ROOMS_LEDGER_PATH = real_ledger  # 在线段写真台账
            test_live()
    print(f"\n{'全部通过' if not _failed else str(_failed) + ' 项失败'}")
    return 1 if _failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
