#!/usr/bin/env python3
"""派发机制优化（2026-07-28）的离线测试：A1 poll 致命读库错误穿透 / A2 重复派发闸 /
A3 模板健康闸 / B4 _finalize_waiter 公共收尾 / B5 _waiter_alive 加固 / B6 reconcile 单次拉取。

全程不碰 areco、不烧额度——REST 层 mock，inbox/state/黑名单全部落隔离目录。
跑法：python3 caller/test_guards.py   （零依赖，不需要 pytest）
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

# 离线隔离（与 test_modes.py 同口径）：必须在 import caller 之前落
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_STANDBY", "off")  # 暖池副作用不进离线测试
os.environ.setdefault("STANDCODE_UNHEALTHY", os.path.join(_TEST_ISO, "unhealthy.json"))

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

# inbox 也隔离——write_inbox 默认落仓库 data/inbox/，测试不能往里灌垃圾
C.INBOX_DIR = pathlib.Path(_TEST_ISO) / "inbox"

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


def _run_args(request: str, **over) -> SimpleNamespace:
    """_cmd_run --wait 需要的最小参数集。"""
    base = dict(
        request=request, wait=True, bg=False, brief=True,
        mode="worker", role=None, plan=False, plan_only=False, subs=[],
        task_type="general", template=None, room_id=None, summary=None,
        file=None, timeout=1, no_relay=True, dry_run=True, reuse_plan=False,
        isolated=False, workspace_repo=None, force=False,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _write_task(task_id: str, request: str, *, status: str = "running",
                age_sec: float = 0) -> None:
    st = {
        "task_id": task_id,
        "spec": {"request": request},
        "status": status,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                    time.gmtime(time.time() - age_sec)),
        "pid": os.getpid(),
        "start_ts": C._PROC_START_TS,
    }
    C.TASKS_DIR.mkdir(parents=True, exist_ok=True)
    (C.TASKS_DIR / f"{task_id}.json").write_text(json.dumps(st, ensure_ascii=False))


class _BoomCaller(C.Caller):
    """dispatch_and_relay 直接抛 RuntimeError（模拟 poll 读库致命错误穿透上来）。"""

    def __init__(self):
        pass

    def dispatch_and_relay(self, *a, **k):
        raise RuntimeError("连续 10 次读 projects.db 失败，停止等待")

    def collect_stand_cost(self, sid):
        return None


# ── A1：poll 致命读库错误不被吞 ─────────────────────────────────────
def test_a1_poll_fatal_db_error() -> None:
    print("\n[A1] poll 读库致命错误穿透 + 等待者链 error 终态")
    # 1) poll_result 主循环不再吞 RuntimeError（get_messages 连续失败 ≥LIMIT 的上抛）
    c = C.Caller.__new__(C.Caller)

    def _boom(*a, **k):
        raise RuntimeError("连续 10 次读 projects.db 失败，停止等待")

    c.get_messages = _boom
    t0 = time.time()
    try:
        c.poll_result(session_id="team-x", timeout=0, poll_interval=0.01)
        check(False, "poll_result 应让 RuntimeError 穿透（旧逻辑吞掉后 0.5s 空转永挂）")
    except RuntimeError:
        check(time.time() - t0 < 5,
              f"RuntimeError 穿透且迅速返回（{time.time() - t0:.2f}s，不挂死）")

    # 2) 等待者链（_cmd_run --wait）捕获后按 error 终态收尾：state=error、inbox 有
    #    error 副本、退出码非零——不裸 traceback 出门
    orig_cls = C.Caller
    C.Caller = _BoomCaller
    t0 = time.time()
    try:
        rc = C._cmd_run(_run_args("A1单元测试任务"))
    finally:
        C.Caller = orig_cls
    check(rc == 1, "error 终态退出码 1（非零）")
    check(time.time() - t0 < 10, f"迅速返回不挂死（{time.time() - t0:.2f}s）")
    states = [p for p in C.TASKS_DIR.glob("wait-*.json")
              if "A1单元测试任务" in p.read_text()]
    check(bool(states) and json.loads(states[-1].read_text()).get("status") == "error",
          "state 落盘 status=error")
    if states:
        tid = json.loads(states[-1].read_text())["task_id"]
        inbox = C.INBOX_DIR / f"{tid}.json"
        check(inbox.exists()
              and json.loads(inbox.read_text()).get("status") == "error",
              "error 终态也写 inbox（此前只落 state，结果副本随进程消失）")


# ── A2：重复派发闸 ──────────────────────────────────────────────────
def test_a2_dup_gate() -> None:
    print("\n[A2] 重复派发闸（同 request 在途 → 拒；--force/死等待者/超窗 → 放）")
    req = "帮我总结一下这份文件"
    orig_alive = C._waiter_alive
    C._waiter_alive = lambda *a, **k: True  # 闸逻辑单测：等待者存活性另由 B5 覆盖
    try:
        # running 同 request → 命中（规范化：多余空白不影响判定）
        _write_task("wait-dup-1", req)
        hit = C._find_inflight_dup("  帮我  总结一下这份文件 ")
        check(bool(hit) and hit["task_id"] == "wait-dup-1",
              "running 同 request（空白规范化后）→ 判在途重复")
        # 不同 request → 放
        check(C._find_inflight_dup("完全不同的任务") is None, "不同 request → 放")
        # 等待者死 → 放
        C._waiter_alive = lambda *a, **k: False
        check(C._find_inflight_dup(req) is None, "等待者已死 → 放")
        C._waiter_alive = lambda *a, **k: True
        # 超 2h 窗 → 放（陈旧 state 不拦）
        _write_task("wait-dup-old", req, age_sec=3 * 3600)
        (C.TASKS_DIR / "wait-dup-1.json").unlink()
        check(C._find_inflight_dup(req) is None, "在途任务超 2h 窗 → 放")
        (C.TASKS_DIR / "wait-dup-old.json").unlink()
        # 非 running（如 error）同 request → 放
        _write_task("wait-dup-err", req, status="error")
        check(C._find_inflight_dup(req) is None, "同 request 但非 running → 放")
        (C.TASKS_DIR / "wait-dup-err.json").unlink()

        # CLI 入口：在途 → 退出码 2 不派发（state 都不落）
        _write_task("wait-dup-cli", req)
        before = set(C.TASKS_DIR.glob("wait-*.json"))
        rc = C._cmd_run(_run_args(req))
        after = set(C.TASKS_DIR.glob("wait-*.json"))
        check(rc == 2 and before == after, "在途重复 → 退出码 2 且不派发（未落新 state）")
        # --force → 跳过闸（一路走到 dispatch 才炸出 error 终态，退出码 1 ≠ 2）
        orig_cls = C.Caller
        C.Caller = _BoomCaller
        try:
            rc2 = C._cmd_run(_run_args(req, force=True))
        finally:
            C.Caller = orig_cls
        check(rc2 == 1, "--force → 跳过重复闸放行（退出码非 2）")
        (C.TASKS_DIR / "wait-dup-cli.json").unlink()
    finally:
        C._waiter_alive = orig_alive


# ── A3：模板健康闸 ──────────────────────────────────────────────────
def test_a3_template_health() -> None:
    print("\n[A3] 模板健康闸（unhealthy.json）")
    tpl = "bad-tpl-a3"
    C.UNHEALTHY_PATH.unlink(missing_ok=True)
    # 连续 2 次失败入黑名单
    C.template_mark_failure(tpl, "404 template not found")
    check(C.unhealthy_until(tpl) == 0, "1 次失败未达阈值，不入黑名单")
    C.template_mark_failure(tpl, "404 template not found")
    check(C.unhealthy_until(tpl) > time.time(), "连续 2 次失败 → 入黑名单（until 在未来）")

    # dispatch 硬报错且错误信息列健康模板（显式 --template 命中也报，不静默换模板）
    c = C.Caller.__new__(C.Caller)
    c.default_thinker_id = "good-tpl-a3"
    c.default_worker_id = tpl
    c.default_template_id = tpl
    c.task_map = {}
    c.roles = {}
    c.list_template_ids = lambda: {tpl, "good-tpl-a3"}
    try:
        c.dispatch("总结一下这份文件", template_id=tpl)
        check(False, "黑名单模板 dispatch 应硬报错")
    except RuntimeError as e:
        check("good-tpl-a3" in str(e) and "隔离" in str(e),
              "dispatch 硬报错且信息含健康模板清单")

    # refill / claim 跳过黑名单模板（不应再建房连刷 404）
    orig_sb = C.STANDBY_ENABLED
    C.STANDBY_ENABLED = True
    try:
        c2 = C.Caller.__new__(C.Caller)

        def _no_room(name):
            raise AssertionError("黑名单模板不应再建房")

        c2.create_room = _no_room
        check(c2.standby_refill(tpl) is None, "standby_refill 跳过黑名单模板")
        check(c2.standby_claim(tpl) is None, "standby_claim 跳过黑名单模板")
    finally:
        C.STANDBY_ENABLED = orig_sb

    # 成功一次即清除
    C.template_mark_success(tpl)
    check(C.unhealthy_until(tpl) == 0, "成功一次即清除黑名单记录")

    # until 过期自动视为恢复
    C._write_unhealthy({tpl: {"failures": 3, "last_error": "x",
                              "until": time.time() - 10}})
    check(C.unhealthy_until(tpl) == 0, "until 过期 → 自动视为恢复")

    # 回滚路径计数：dispatch 冷派 add_stand 连挂 2 次 → 入黑名单
    C.UNHEALTHY_PATH.unlink(missing_ok=True)

    class _FlakyCaller(C.Caller):
        def __init__(self):
            self.default_thinker_id = "good-tpl-a3"
            self.default_worker_id = tpl
            self.default_template_id = tpl
            self.task_map = {}
            self.roles = {}
            self._n = 0

        def list_template_ids(self):
            return {tpl, "good-tpl-a3"}

        def create_room(self, name):
            return {"id": f"room{self._n}", "team": f"team-room{self._n}", "name": name}

        def add_stand(self, rid, tid, cwd=None):
            self._n += 1
            raise RuntimeError("404 template not found")

        def archive_room(self, rid):
            pass

    c3 = _FlakyCaller()
    for _ in range(2):
        try:
            c3.dispatch("总结一下这份文件", template_id=tpl)
        except RuntimeError:
            pass
    check(C.unhealthy_until(tpl) > time.time(),
          "dispatch 回滚路径连挂 2 次 → 入黑名单")
    C.UNHEALTHY_PATH.unlink(missing_ok=True)


# ── B4：_finalize_waiter 公共收尾 ──────────────────────────────────
def test_b4_finalize_waiter() -> None:
    print("\n[B4] _finalize_waiter 公共收尾 + plan output_path 机检传参")
    captured: dict = {}
    orig_verify = C.verify_completion
    orig_cost = C.Caller.collect_stand_cost

    def _spy_verify(files=None, output_path=None):
        captured["files"] = files
        captured["output_path"] = output_path
        return {"level": "verified", "checks": []}

    C.verify_completion = _spy_verify
    C.Caller.collect_stand_cost = lambda self, sid: None
    try:
        caller = C.Caller.__new__(C.Caller)
        tid = "wait-b4-1"
        spec = {"request": "plan 模式任务", "role": "worker"}
        state = {"task_id": tid, "spec": spec}
        res = {
            "status": "completed", "result_text": "干完了", "room_id": "r1",
            "session_id": "team-r1", "stand_name": "Stand-1",
            "plan_parsed": {"output_path": "/tmp/plan-out.txt"},
            "messages_count": 7,
        }
        fin = C._finalize_waiter(caller, tid, state, res, spec=spec, files=[])
        # ask 路漏传修复：plan output_path 必须进机检（此前只有 run 路传）
        check(captured.get("output_path") == "/tmp/plan-out.txt",
              "plan output_path 传入 verify_completion（ask 路漏传修复）")
        st = json.loads((C.TASKS_DIR / f"{tid}.json").read_text())
        check(st.get("status") == "completed" and st.get("messages_count") == 7
              and st.get("verification", {}).get("level") == "verified",
              "state 终态 + 水位线 + verification 全部落盘")
        check(not (C.INBOX_DIR / f"{tid}.json").exists()
              and (C.INBOX_DIR / f"{tid}.json.done").exists(),
              "completed → inbox 标 .done（防 digest 双报）")
        check(fin["inbox_path"].name.endswith(".done"), "返回 inbox_path 指向 .done 文件")
        # 非 completed：不标 .done，留 pending 由 digest 兜底
        tid2 = "wait-b4-2"
        C._finalize_waiter(caller, tid2, {"task_id": tid2, "spec": spec},
                           {"status": "timeout", "result_text": "", "error": "超时"},
                           spec=spec, files=[])
        check((C.INBOX_DIR / f"{tid2}.json").exists()
              and not (C.INBOX_DIR / f"{tid2}.json.done").exists(),
              "timeout → inbox 留 pending（digest 兜底）")
        # _bg_worker 口径：with_checks=False 不跑机检
        captured.clear()
        tid3 = "wait-b4-3"
        C._finalize_waiter(caller, tid3, {"task_id": tid3, "spec": spec},
                           {"status": "completed", "result_text": "x"},
                           spec=spec, files=[], with_checks=False, mark_done=False)
        check("output_path" not in captured
              and (C.INBOX_DIR / f"{tid3}.json").exists(),
              "with_checks=False（_bg_worker 口径）→ 不机检、不标 .done")
    finally:
        C.verify_completion = orig_verify
        C.Caller.collect_stand_cost = orig_cost


# ── B5：_waiter_alive 加固 ──────────────────────────────────────────
def test_b5_waiter_alive() -> None:
    print("\n[B5] _waiter_alive pid 复用加固（真实 ps）")
    me = os.getpid()
    # 本进程 cmdline 含 "test_guards"；start_ts=模块 import 时刻 ≈ 进程启动（<2s 容差）
    check(C._waiter_alive(me, task_id="test_guards", start_ts=C._PROC_START_TS),
          "pid 存在且 cmdline 含 task_id → 判活")
    check(not C._waiter_alive(me, task_id="wait-不存在-xyz", start_ts=C._PROC_START_TS),
          "pid 存在但 cmdline 不含 task_id → 判死")
    check(not C._waiter_alive(me, task_id="test_guards", start_ts=time.time() + 100),
          "lstart 与 start_ts 对不上（pid 复用）→ 判死")
    check(C._waiter_alive(me, request="test_guards", start_ts=C._PROC_START_TS),
          "cmdline 含请求片段（前台 --wait/ask 链）→ 判活")
    check(not C._waiter_alive(99999999), "pid 不存在 → 判死")
    check(C._waiter_alive(me), "无 start_ts 旧 state → 回落旧逻辑判活")
    # lstart 解析失败 → 视为死（新口径）
    orig_run = subprocess.run

    class _Garbage:
        stdout = "这不是合法的 ps 输出"

    C.subprocess.run = lambda *a, **k: _Garbage()
    try:
        check(not C._waiter_alive(me, task_id="x", start_ts=C._PROC_START_TS),
              "lstart 解析失败 → 视为死")
    finally:
        C.subprocess.run = orig_run


# ── B6：reconcile 每轮只拉一次 sessions ─────────────────────────────
def test_b6_reconcile_single_fetch() -> None:
    print("\n[B6] reconcile 每轮只拉一次 sessions + fail-open")
    # 三个任务分别落在 stuck / timeout / completed+settle_forced 三个查会话的分支
    for tid, st in {
        "wait-b6-stuck": {"status": "stuck", "session_id": "team-x", "messages_count": 0},
        "wait-b6-timeout": {"status": "timeout", "session_id": "team-x", "messages_count": 0},
        "wait-b6-sf": {"status": "completed", "settle_forced": True,
                       "session_id": "team-x", "messages_count": 0},
    }.items():
        st.update({"task_id": tid, "spec": {"request": f"b6 {tid}"},
                   "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        (C.TASKS_DIR / f"{tid}.json").write_text(json.dumps(st, ensure_ascii=False))
    calls = {"n": 0}

    class _RecCaller(C.Caller):
        def __init__(self):
            pass

        def list_sessions(self):
            calls["n"] += 1
            return [{"id": "ses-1", "status": "running", "trafficState": "working"}]

        def get_messages(self, *a, **k):
            return []

    orig_cls = C.Caller
    C.Caller = _RecCaller
    try:
        rc = C._cmd_reconcile(SimpleNamespace(dry_run=True, max_age_days=7))
    finally:
        C.Caller = orig_cls
    check(rc == 0 and calls["n"] == 1,
          f"三个查会话分支复用同一次拉取（list_sessions 调用 {calls['n']} 次）")

    # fail-open：list_sessions 抛错 → 空 dict，不判死、不拦、正常跑完
    class _FailCaller(_RecCaller):
        def list_sessions(self):
            raise OSError("areco down")

    C.Caller = _FailCaller
    try:
        rc2 = C._cmd_reconcile(SimpleNamespace(dry_run=True, max_age_days=7))
    finally:
        C.Caller = orig_cls
    check(rc2 == 0, "list_sessions 失败 → fail-open 正常跑完（不判死不拦）")
    for tid in ("wait-b6-stuck", "wait-b6-timeout", "wait-b6-sf"):
        (C.TASKS_DIR / f"{tid}.json").unlink(missing_ok=True)


# ── ⑥ 两道闸校准（2026-07-29 高律师批）────────────────────────────────
# 空转闸：idle×N 判死须 首字等待超 FIRST_TOKEN_MAX_SEC + 看板新鲜复核零产出；
# 定稿闸：回复须像交付物才吃 MERGE_WAIT_SEC 短窗，纯进度句吃 PROGRESS_SETTLE_SEC 续等窗。
def _gate_caller(messages_fn, session_info_fn):
    """poll_result 离线壳：REST 全 mock，不碰 areco。"""
    c = C.Caller.__new__(C.Caller)
    c.get_messages = messages_fn
    c._session_info = session_info_fn
    c.sent = []
    c.send_message = lambda sid, to, body: c.sent.append((sid, to, body))
    return c


def test_deliverable_classifier() -> None:
    print("\n[⑥定稿闸] _looks_like_deliverable 判别")
    progress = [
        "我先看一下这个任务的上下文",
        "让我来处理，稍等",
        "收到，马上开始干",
        "正在检索相关材料",
        "",
    ]
    for t in progress:
        check(not C._looks_like_deliverable(t), f"进度句判否：{t[:16] or '(空)'}")
    deliverable = [
        "结论：一审判决应予维持，理由如下",
        "产物路径：/tmp/x.md",
        "已完成，报告在 /Users/gao/Desktop/报告.docx",
        "共找到 13 条记录，其中 3 条超期",
        "commit 2c67209 已提交到 main",
        "我先汇报结论：本案已过诉讼时效",  # 开工白开头但带结论段 → 交付物
        "经查" + "本案事实与法律适用分析，" * 20,  # ≥200 字长正文
    ]
    for t in deliverable:
        check(C._looks_like_deliverable(t), f"交付物判是：{t[:16]}")


def test_idle_gate() -> None:
    print("\n[⑥空转闸] 首字上限 + 看板复核")
    orig = (C.IDLE_STALL_PROBES, C.STATE_PROBE_SEC, C.FIRST_TOKEN_MAX_SEC)
    C.IDLE_STALL_PROBES, C.STATE_PROBE_SEC = 2, 0.01
    try:
        # 场景1：真零产出（outputChars 恒定 + 灯 idle）→ 到首字上限才 stall，且重投过一次
        C.FIRST_TOKEN_MAX_SEC = 0.5

        def _msgs(sid, after_id=0):
            # 重投取原文（after_id=0）给任务消息；主循环（after_id>=1）永远无回复
            return ([{"id": 1, "body": "任务原文", "from_agent": "hermes"}]
                    if after_id == 0 else [])

        c = _gate_caller(_msgs, lambda sid: {
            "trafficState": "idle", "outputChars": 100, "status": "running"})
        t0 = time.time()
        res = c.poll_result(session_id="team-g", timeout=5, poll_interval=0.005,
                            stand_session_id="s1", after_id=1, stand_name="w")
        el = time.time() - t0
        check(res["status"] == "stall", f"真零产出 → stall（实得 {res['status']}）")
        check(el >= 0.5, f"stall 不早于首字上限 0.5s（实测 {el:.2f}s）")
        check(len(c.sent) == 1, f"判死前重投过 1 次（实得 {len(c.sent)}）")

        # 场景2：outputChars 持续增长（慢思考模型 spinner/思考流）→ 复核推翻，不 stall 不重投
        C.FIRST_TOKEN_MAX_SEC = 0.1
        tick = {"n": 100}

        def _grow(sid):
            tick["n"] += 7
            return {"trafficState": "idle", "outputChars": tick["n"], "status": "running"}

        c2 = _gate_caller(_msgs, _grow)
        res2 = c2.poll_result(session_id="team-g", timeout=0.8, poll_interval=0.005,
                              stand_session_id="s1", after_id=1, stand_name="w")
        check(res2["status"] == "timeout", f"有产出被复核推翻 → 不判死（实得 {res2['status']}）")
        check(len(c2.sent) == 0, "有产出时也不重投扰动")

        # 场景3：首字上限未到 → idle 探针再多也不 stall
        C.FIRST_TOKEN_MAX_SEC = 30
        c3 = _gate_caller(_msgs, lambda sid: {
            "trafficState": "idle", "outputChars": 100, "status": "running"})
        res3 = c3.poll_result(session_id="team-g", timeout=0.5, poll_interval=0.005,
                              stand_session_id="s1", after_id=1, stand_name="w")
        check(res3["status"] == "timeout", f"上限未到不判死（实得 {res3['status']}）")
    finally:
        C.IDLE_STALL_PROBES, C.STATE_PROBE_SEC, C.FIRST_TOKEN_MAX_SEC = orig


def test_settle_gate() -> None:
    print("\n[⑥定稿闸] 进度句续等窗 / 交付物短窗")
    orig = (C.MERGE_WAIT_SEC, C.PROGRESS_SETTLE_SEC, C.STATE_PROBE_SEC)
    C.MERGE_WAIT_SEC, C.PROGRESS_SETTLE_SEC, C.STATE_PROBE_SEC = 0.05, 0.6, 0.01
    try:
        def _mk_msgs(body):
            state = {"sent": False}

            def _msgs(sid, after_id=0):
                if not state["sent"] and after_id >= 1:
                    state["sent"] = True
                    return [{"id": 2, "body": body, "from_agent": "w"}]
                return []
            return _msgs

        idle_info = lambda sid: {  # noqa: E731
            "trafficState": "idle", "outputChars": 100, "status": "running"}

        # 场景1：纯进度句 → 不吃短窗，静满续等窗才定稿（settle_reason=progress_timeout）
        c = _gate_caller(_mk_msgs("我先看一下任务上下文，马上开始"), idle_info)
        t0 = time.time()
        res = c.poll_result(session_id="team-s", timeout=5, poll_interval=0.005,
                            stand_session_id="s1", after_id=1, stand_name="w")
        el = time.time() - t0
        check(res["status"] == "completed", f"进度句最终也定稿（实得 {res['status']}）")
        check(el >= 0.6, f"进度句不吃 {C.MERGE_WAIT_SEC}s 短窗，续等 ≥0.6s（实测 {el:.2f}s）")
        check(res.get("settle_reason") == "progress_timeout",
              f"定稿原因=progress_timeout（实得 {res.get('settle_reason')}）")

        # 场景2：像交付物（结论+路径）→ 照旧短窗秒级收口
        c2 = _gate_caller(_mk_msgs("结论：已完成，产物路径：/tmp/x.md"), idle_info)
        t0 = time.time()
        res2 = c2.poll_result(session_id="team-s", timeout=5, poll_interval=0.005,
                              stand_session_id="s1", after_id=1, stand_name="w")
        el2 = time.time() - t0
        check(res2["status"] == "completed" and not res2.get("settle_reason"),
              f"交付物走短窗定稿（实得 {res2['status']}/{res2.get('settle_reason')}）")
        check(el2 < 0.6, f"交付物不吃续等窗（实测 {el2:.2f}s）")

        # 场景3：④实证复刻——灯 working + 输出零增长 + 只有开工白 → wedge 不收，
        # 续等窗满才按 working_wedged 收口（真结果有机会并入）
        C.OUTPUT_STALL_PROBES_ORIG = C.OUTPUT_STALL_PROBES
        C.OUTPUT_STALL_PROBES = 2
        try:
            c3 = _gate_caller(_mk_msgs("收到，我来处理"), lambda sid: {
                "trafficState": "working", "outputChars": 100, "status": "running"})
            t0 = time.time()
            res3 = c3.poll_result(session_id="team-s", timeout=5, poll_interval=0.005,
                                  stand_session_id="s1", after_id=1, stand_name="w")
            el3 = time.time() - t0
            check(res3["status"] == "completed"
                  and res3.get("settle_reason") == "working_wedged",
                  f"wedge 最终收口（实得 {res3['status']}/{res3.get('settle_reason')}）")
            check(el3 >= 0.6, f"开工白不许 wedge 提前收（④的124s病灶；实测 {el3:.2f}s）")
        finally:
            C.OUTPUT_STALL_PROBES = C.OUTPUT_STALL_PROBES_ORIG
    finally:
        C.MERGE_WAIT_SEC, C.PROGRESS_SETTLE_SEC, C.STATE_PROBE_SEC = orig


def main() -> int:
    test_a1_poll_fatal_db_error()
    test_a2_dup_gate()
    test_a3_template_health()
    test_b4_finalize_waiter()
    test_b5_waiter_alive()
    test_b6_reconcile_single_fetch()
    test_deliverable_classifier()
    test_idle_gate()
    test_settle_gate()
    print(f"\n{'全部通过' if not _fails else '失败 ' + str(len(_fails)) + ' 项'}"
          f"（隔离目录 {_TEST_ISO}）")
    for f in _fails:
        print(f"  ✗ {f}")
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(main())
