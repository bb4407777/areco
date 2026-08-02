#!/usr/bin/env python3
"""暖池 standby pool + dispatch 复用通道 离线自测（2026-07-26 提速批件）。

全程不碰 areco：REST mock（复用 test_modes._FakeCaller 骨架），消息层真 SQLite。
跑法：python3 caller/test_standby.py   （零依赖，不需要 pytest）

覆盖面：
    - refill：建房+spawn+池文件；池满幂等跳过
    - claim：命中即消费池文件并返回 reuse 字典；过期/会话死亡当场清理；空池回 None
    - dispatch 复用通道：暖池命中 → 不再 add_stand、结果带 standby=True、用掉即补
    - sweep：死会话/已消失会话席位当场回收，活席位保留，会话列表取不到时不判
    - plan 预热：两段式全程只 spawn 2 个 Stand（Thinker+预热 Worker），执行段 stand_reused
    - 报表去污：_audit_is_stub 桩痕迹判定
"""
import json
import os
import pathlib
import sys
import tempfile
import time

# _TEST_ISO：离线测试环境隔离（同 test_modes.py 口径），暖池默认关、各测试显式开
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_STANDBY", "off")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402
import test_modes as TM  # noqa: E402  复用 _FakeCaller 骨架与隔离前提

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


class _PoolCaller(TM._FakeCaller):
    """在 _FakeCaller 之上补齐暖池要用的 list_sessions/get_room 行为。"""

    def __init__(self, db_path):
        super().__init__(db_path)
        self._session_states: dict[str, str] = {}  # sessionId → status

    def add_stand(self, rid, tid, cwd=None):
        m = super().add_stand(rid, tid, cwd=cwd)
        self._session_states[m["sessionId"]] = "running"
        return m

    def list_sessions(self):
        return [{"id": sid, "status": st} for sid, st in self._session_states.items()]


def _fresh(tmp_name: str) -> "_PoolCaller":
    tmp = pathlib.Path(tempfile.mkdtemp(prefix=f"standby-{tmp_name}-"))
    C.STANDBY_DIR = tmp / "pool"  # 每测一池，互不串
    return _PoolCaller(tmp / "tasks.db")


def test_refill_and_claim() -> None:
    print("\n[standby] refill / claim / 过期 / 死会话")
    C.STANDBY_ENABLED = True
    c = _fresh("rc")
    r1 = c.standby_refill("worker-tpl")
    check(bool(r1) and len(c._standby_files("worker-tpl")) == 1, "refill 落池文件")
    check(c.standby_refill("worker-tpl") is None, "池满（size=1）幂等跳过")
    claim = c.standby_claim("worker-tpl")
    check(bool(claim) and claim["room_id"] == r1["room_id"] and claim["kind"] == "standby",
          "claim 命中即返回 reuse 字典（同房同 Stand）")
    check(claim.get("room_created") is True, "暖池房 room_created=True（收口照常归档）")
    check(len(c._standby_files("worker-tpl")) == 0, "池文件已消费")
    check(c.standby_claim("worker-tpl") is None, "空池回 None（回落冷启动）")

    # 过期位：认领时当场清理（归档房间）并继续
    r2 = c.standby_refill("worker-tpl")
    f = c._standby_files("worker-tpl")[0]
    info = json.loads(f.read_text())
    info["created_ts"] = time.time() - C.STANDBY_MAX_AGE_SEC - 10
    f.write_text(json.dumps(info))
    check(c.standby_claim("worker-tpl") is None and r2["room_id"] in getattr(c, "_archived", []),
          "过期待命位：不认领、房间归档回收")

    # 会话死亡（areco 重启）：不认领、房间归档
    r3 = c.standby_refill("worker-tpl")
    c._session_states[r3["stand_session_id"]] = "exited"
    check(c.standby_claim("worker-tpl") is None and r3["room_id"] in c._archived,
          "死会话待命位：不认领、房间归档回收")


def test_dispatch_uses_standby() -> None:
    print("\n[standby] dispatch 复用通道 + 用掉即补")
    C.STANDBY_ENABLED = True
    c = _fresh("dp")
    seeded = c.standby_refill("worker-tpl")
    stands_before = len(c._stands)
    res = c.dispatch("把这份文书转成 PDF", role="worker")
    check(res["standby"] is True and res["stand_reused"] is True, "结果带 standby/stand_reused 标记")
    check(res["room_id"] == seeded["room_id"], "任务落在待命房（跳过建房+spawn）")
    # 本单任务自身零 add_stand；唯一新增的是「用掉即补」的补胎位
    check(len(c._stands) == stands_before + 1 and len(c._standby_files("worker-tpl")) == 1,
          "任务零新 spawn；补胎 1 位回池")
    res2 = c.dispatch("再转一份", role="worker", room_id=seeded["room_id"])
    check(res2["standby"] is False, "显式 room_id 的定向派发不走暖池")

    C.STANDBY_ENABLED = False
    c2 = _fresh("off")
    c2.standby_refill("worker-tpl")
    check(len(c2._standby_files("worker-tpl")) == 0, "暖池关闭时 refill 不动作")
    r = c2.dispatch("转 PDF", role="worker")
    check(r["standby"] is False, "暖池关闭时 dispatch 走冷启动")


def test_plan_prewarm() -> None:
    print("\n[prewarm] 两段式预热 Worker")
    C.STANDBY_ENABLED = False  # 隔离变量：只看预热
    C.PREWARM_WORKER = True
    _sleep = C.time.sleep
    C.time.sleep = lambda *a, **k: None
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="prewarm-"))
    c = _PoolCaller(tmp / "tasks.db")
    c._thinker_replies = [TM.GOOD_PLAN]
    _dir, _idx = C.PLANS_DIR, C.PLANS_INDEX
    C.PLANS_DIR = tmp / "plans"
    C.PLANS_INDEX = C.PLANS_DIR / "index.jsonl"
    try:
        r = c.plan_and_execute("设计一个归档方案并落盘", poll_timeout=3, dry_run=True)
    finally:
        C.PLANS_DIR, C.PLANS_INDEX = _dir, _idx
        C.time.sleep = _sleep
    check(r["stage"] == "execute", "两段式跑通")
    check(len(c._stands) == 2, f"全程只 spawn 2 个 Stand：Thinker+预热 Worker（实得 {len(c._stands)}）")
    check(r["execute"].get("stand_reused") is True and not r["execute"].get("standby"),
          "执行段复用预热成员（stand_reused=True 且非暖池）")

    # 预热关闭 → 回落原路：第二段现场 add_stand，共 2 个 Stand 但执行段非复用
    C.PREWARM_WORKER = False
    C.time.sleep = lambda *a, **k: None
    c2 = _PoolCaller(tmp / "p2.db")
    c2._thinker_replies = [TM.GOOD_PLAN]
    C.PLANS_DIR = tmp / "plans2"
    C.PLANS_INDEX = C.PLANS_DIR / "index.jsonl"
    try:
        r2 = c2.plan_and_execute("设计一个归档方案并落盘", poll_timeout=3, dry_run=True)
    finally:
        C.PLANS_DIR, C.PLANS_INDEX = _dir, _idx
        C.time.sleep = _sleep
        C.PREWARM_WORKER = True
    check(r2["execute"].get("stand_reused") is not True, "预热关闭 → 执行段回落现场 spawn")


def test_audit_stub_filter() -> None:
    print("\n[report] 测试桩痕迹判定")
    check(C._audit_is_stub({"template": "thinker-tpl", "room_id": "room0"}), "‑tpl 模板判桩")
    check(C._audit_is_stub({"template": "", "room_id": "room12"}), "room\\d 假房号判桩")
    check(not C._audit_is_stub({"template": "claude-glm52", "room_id": "bffaefd2"}), "真实流量不误杀")
    check(not C._audit_is_stub({"template": "workbuddy-deepseek-pro", "room_id": ""}), "无房号事件不误杀")


def test_sweep_dead_session() -> None:
    print("\n[standby] sweep 死会话/活席位")
    C.STANDBY_ENABLED = True
    c = _fresh("sw")
    # 席位会话已 exited：sweep 当场回收（不等 claim、不等 120min 过期）
    r1 = c.standby_refill("worker-tpl")
    c._session_states[r1["stand_session_id"]] = "exited"
    out = c.standby_sweep()
    check(out["dead"] == 1 and len(c._standby_files("worker-tpl")) == 0
          and r1["room_id"] in c._archived,
          "死会话席位：sweep 回收（dead=1、池文件摘走、房间归档）")
    # 席位会话从列表里消失（进程被清理）：同样回收
    r2 = c.standby_refill("worker-tpl")
    c._session_states.pop(r2["stand_session_id"])
    c._session_states["someone-else"] = "running"  # 列表非空才判，模拟 API 正常
    out = c.standby_sweep()
    check(out["dead"] == 1 and r2["room_id"] in c._archived,
          "席位指向已消失会话：sweep 回收")
    # 活席位：sweep 不动
    r3 = c.standby_refill("worker-tpl")
    out = c.standby_sweep()
    check(out["dead"] == 0 and len(c._standby_files("worker-tpl")) == 1,
          "活席位：sweep 不误杀")
    # list_sessions 失败（空列表）= 一律不判，防 API 抖动清空整池
    c._session_states.clear()
    out = c.standby_sweep()
    check(out["dead"] == 0 and len(c._standby_files("worker-tpl")) == 1,
          "会话列表取不到：sweep 不判死活，席位保留")


if __name__ == "__main__":
    test_refill_and_claim()
    test_dispatch_uses_standby()
    test_plan_prewarm()
    test_sweep_dead_session()
    test_audit_stub_filter()
    print()
    if _fails:
        print(f"❌ {len(_fails)} 项失败：")
        for f in _fails:
            print(f"   - {f}")
        sys.exit(1)
    print("✅ 全部通过")
