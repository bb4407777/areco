#!/usr/bin/env python3
"""工作模式的离线测试：route_mode / resolve_mode / plan_and_execute 降级与共享房间。

全程不碰 areco、不烧额度、不建真房间——REST 层 mock，消息层用真 SQLite 临时库。
跑法：python3 caller/test_modes.py   （零依赖，不需要 pytest）

为什么值得有：审计（2026-07-26）指出 route_mode / resolve_mode / _parse_plan /
check_should_dispatch 这些纯函数**零覆盖**，而它们恰恰是选路的判据——选错路的代价是
烧一个 Stand 段或用错档位的模型，比崩溃更贵，因为不会报错。
"""
import os
import sys
import pathlib
import tempfile

# _TEST_ISO：离线测试环境隔离（2026-07-26）。此前没隔离 STANDCODE_AUDIT_LOG，
# 167 条桩事件（thinker-tpl/room0）混进生产 audit.jsonl，把报表灌成「派发 182 单」
# （真实 15）。所有会 import caller 的离线测试都必须在 import 前落这一块。
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_STANDBY", "off")  # 暖池副作用（建房/补胎）不进离线测试

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


# ── route_mode：四格路由 ───────────────────────────────────────────
def test_route_mode() -> None:
    print("\n[route_mode] 四格路由")
    cases = [
        # (请求, 期望 mode, 期望 plan_only)
        # 2026-07-26 强弱分档后口径：plan 两段式只留给强信号（分几步/计划/拆解…）
        # 或 ≥2 个弱信号且无 DIRECT 压制——单个「设计/调研/架构」不再触发多步。
        # 理由：plan 误入 = 白烧一个 Thinker 段（中位 95s+），而 Worker（claude CLI）
        # 自带内部规划，单段扛得住边界任务；宁 worker 勿 plan。
        ("这两套架构选哪个，为什么", "think", False),   # 弱×1 不算多步：二选一给结论即可
        ("梳理一下这三种模式的优缺点", "think", False),
        ("评估这三条迁移路线的可行性", "think", True),   # 弱×2（评估+可行性）→ 多步判断出结构化计划
        ("先出个计划，别动手", "think", True),
        ("把恩平法院的判决书下载下来", "worker", False),  # 判决=法律重活词 → 主力 Worker
        # 2026-07-29 口径：文书=法律重活词 → 主 Worker（不误配 hy3）
        ("总结一下这份文书", "worker", False),
        ("调研 X 并输出一份报告存到桌面", "worker", False),   # 存到=落盘重活词 → 主力
        # ⑤ 路由反转（2026-07-29）：无法律/代码重活词的默认车道 = fast（hy3）——
        # 反转前这条靠 DIRECT（下载）压制弱双信号落 worker，反转后「其余一律轻车」。
        ("把这个下载下来然后设计一个归档方案", "fast", False),
        ("调研三个方案对比后写入报告存到桌面", "plan", False),   # 弱×3 无压制 → 两段式
        ("分几步把网站改版并部署", "plan", False),              # 强信号单独成立
        ("设计一个脚本保存到 /tmp/x.py", "worker", False),      # 保存到=落盘重活词 → 单段主力
    ]
    for req, exp_mode, exp_po in cases:
        r = C.Caller.route_mode(req)
        check(
            r["mode"] == exp_mode and r["plan_only"] == exp_po,
            f"{req[:22]:24s} → {r['mode']}{'+plan_only' if r['plan_only'] else ''}"
            f"（期望 {exp_mode}{'+plan_only' if exp_po else ''}）",
        )
    # 回归闸：这三条是改动前被错配到 plan 的（白烧一个 Worker 段去执行一个只需结论的判断）
    for req in ("这两套架构选哪个，为什么", "梳理一下这三种模式的优缺点", "评估这三条迁移路线的可行性"):
        check(C.Caller.route_mode(req)["mode"] == "think", f"回归·不再错配到 plan：{req[:20]}")


# ── route_mode：⑤ Worker 路由反转（2026-07-29 高律师批）──────────────
# 旧口径「轻活白名单进 hy3、默认 claude」→ 新口径「法律/代码重活白名单进 claude、
# 其余一律 hy3」。法律词沿用 FAST_BLOCK_KEYWORDS，代码词 CODE_KEYWORDS 新增。
def test_route_mode_fast() -> None:
    print("\n[route_mode] ⑤ 路由反转（法律/代码词 → claude，其余 → hy3）")
    hit = [
        # 高律师冒烟单 c：总结类默认轻车
        "总结下这篇文章",
        # 2026-07-29 搜索/抓取/摘要类轻活 → hy3（反转后不再依赖白名单词，仍应 fast）
        "搜一下贾扬清Intent Lab最新进展",
        "抓取这个公众号文章",
        "总结这篇链接的内容",
        "调研一下 StandCode 暖池机制",
        "翻译这段话",
        "提取这份合同的金额和日期",
        "确认一下明天开庭时间",
        # 反转新口径：长文本不再挡 fast（原 120 字长度闸已撤——默认车道无需白名单）
        "总结一下" + "这份材料很长，" * 30,
    ]
    for req in hit:
        r = C.Caller.route_mode(req)
        check(r["mode"] == "fast" and not r["plan_only"],
              f"轻车 {req[:18]:20s} → {r['mode']}（期望 fast）")

    heavy = [
        # 高律师冒烟单 a/b：法律词、代码词 → 主力 Worker（claude/GLM-5.2）
        "查下26民0421案法条",
        "写个python脚本统计文件",
        # 法律重活词（FAST_BLOCK_KEYWORDS 组）
        "搜索这个案件的相关法条",
        "抓取这篇判决书的内容",
        "核查一下这份文书的条款",
        "查一下 25民1000 案件状态",
        "把调研结果写成报告存到桌面",   # 落盘类重活词
        "批量总结一下这批判决书",
        "帮我修复这个脚本再总结一下报错原因",
        # 代码重活词（CODE_KEYWORDS 新增组；ASCII 词大小写不敏感）
        "帮我调试这段代码",
        "查一下这个 BUG 怎么回事",
        "把改动 commit 到 git 仓库",
    ]
    for req in heavy:
        r = C.Caller.route_mode(req)
        check(r["mode"] == "worker",
              f"重活 {req[:18]:20s} → {r['mode']}（期望 worker/claude）")
        check("命中重活词" in r["reason"],
              f"重活 {req[:14]:16s} route_reason 写明命中词：{r['reason'][:40]}")

    # 多步（强计划信号）仍走 plan，不受反转影响
    r = C.Caller.route_mode("分几步总结这份文书并归档")
    check(r["mode"] == "plan", f"多步强信号 → {r['mode']}（期望 plan）")


# ── resolve_mode：两代参数收敛 ─────────────────────────────────────
def test_resolve_mode() -> None:
    print("\n[resolve_mode] 显式 --mode 与旧 --role/--plan 的收敛")
    accept = [
        (dict(mode="think"), "think", False),
        (dict(mode="think", plan_only=True), "think", True),
        (dict(mode="plan"), "plan", False),
        (dict(mode="fanout", subs=["a", "b"]), "fanout", False),
        (dict(mode="fast"), "fast", False),
        (dict(plan=True), "plan", False),
        (dict(role="thinker"), "think", False),
        (dict(plan_only=True), "think", True),
        (dict(subs=["a", "b"]), "fanout", False),
        (dict(), "worker", False),
    ]
    for kw, exp_mode, exp_po in accept:
        r = C.resolve_mode(**kw)
        check(r["mode"] == exp_mode and r["plan_only"] == exp_po, f"接受 {kw} → {r['mode']}")
    # fast 的 role 必须是 None——dispatch 模板优先级 role > task_type，
    # 给 role 会让 default_worker（claude）顶掉 task_map["fast"]（hy3）
    check(C.resolve_mode(mode="fast")["role"] is None, "--mode fast → role=None（不顶掉 fast 模板）")

    reject = [
        dict(mode="plan", plan_only=True),      # 两段式含执行 vs 只出计划
        dict(mode="think", plan=True),
        dict(mode="worker", role="thinker"),
        dict(mode="fanout", subs=["a"]),        # fanout 至少 2 个子任务
        dict(mode="不存在的模式"),
        dict(plan=True, plan_only=True),
        dict(role="worker", plan_only=True),    # 只执行 vs 只规划
        dict(mode="worker", subs=["a", "b"]),
    ]
    for kw in reject:
        try:
            C.resolve_mode(**kw)
            check(False, f"应拒绝但放行了：{kw}")
        except C.ModeConflictError:
            check(True, f"拒绝 {kw}")


# ── finish_room：提前收口/Stand 存活两道守卫（2026-07-27）─────────────
def test_finish_room_guards() -> None:
    """归档 = 级联 SIGTERM 房内 Stand；「看到中途结果误判完成而提前关闭」链的闸。"""
    print("\n[finish_room] settle_forced / stand_still_working 守卫")

    class _FC(C.Caller):
        def __init__(self, info):
            self._info = info
            self.archived: list[str] = []

        def archive_room(self, rid):
            self.archived.append(rid)

        def _session_info(self, sid):
            return self._info

    d = {"room_id": "r1", "room_created": True, "task_id": "t1",
         "stand_session_id": "s1"}

    # 1) settle_forced：提前收口 ≠ 干完，不归档（留 reconcile 补收后归档）
    c = _FC({"status": "running", "trafficState": "working"})
    r = c.finish_room(d, "completed", settle_forced=True)
    check(not r["archived"] and r["reason"] == "settle_forced" and not c.archived,
          "settle_forced → 不归档（reason=settle_forced）")

    # 2) 存活探针：completed 但 Stand 仍 running + working → 不归档
    c = _FC({"status": "running", "trafficState": "working"})
    r = c.finish_room(d, "completed")
    check(not r["archived"] and r["reason"] == "stand_still_working" and not c.archived,
          "Stand 仍在干活（running+working）→ 不归档")

    # 3) Stand 已收尾（idle）→ 正常归档
    c = _FC({"status": "running", "trafficState": "idle"})
    r = c.finish_room(d, "completed")
    check(r["archived"] and c.archived == ["r1"], "Stand 已收尾 → 正常归档")

    # 4) 探针故障（查不到会话）→ best-effort 不拦归档
    c = _FC(None)
    r = c.finish_room(d, "completed")
    check(r["archived"] and c.archived == ["r1"], "探针查不到 → 不拦归档（探针故障不卡死收口）")

    # 5) 非 completed 照旧不归档（守卫不改变既有口径）
    c = _FC(None)
    r = c.finish_room(d, "timeout")
    check(not r["archived"] and r["reason"] == "not_completed",
          "非 completed → 留看板（既有口径不变）")


# ── _parse_plan：结构化校验 ────────────────────────────────────────
def test_parse_plan() -> None:
    print("\n[_parse_plan] 计划结构化校验")
    c = C.Caller.__new__(C.Caller)  # 只用纯函数，不跑 __init__
    good = ("目标：归档\n步骤：\n1. 建目录 | 工具：mkdir | 产物：/tmp/a\n"
            "2. 移文件 | 工具：mv | 产物：无\n完成判据：目录存在")
    check(c._parse_plan(good)["valid"], "六段齐全 → valid")
    check(len(c._parse_plan(good)["steps"]) == 2, "抓到 2 个编号步骤")
    check(not c._parse_plan("我觉得可以先建个目录然后挪文件")["valid"], "散文无步骤段 → invalid")
    check(not c._parse_plan("")["valid"], "空文本 → invalid")


# ── plan_and_execute：降级 + 共享房间（真 SQLite，mock REST）─────────
class _FakeCaller(C.Caller):
    """把 areco REST 全部 mock 掉，只保留真实的 SQLite 消息读写。"""

    def __init__(self, db_path: pathlib.Path):
        self.projects_db = db_path
        self.base = "http://fake"
        self.session = None
        self.default_thinker_id = "thinker-tpl"
        self.default_worker_id = "worker-tpl"
        self.default_template_id = "worker-tpl"
        self.task_map = {}
        self.roles = {"thinker-tpl": "thinker", "worker-tpl": "worker"}
        self._rooms: list[str] = []
        self._stands: list[str] = []
        self._script: dict[str, list[str]] = {}
        self._thinker_replies: list[str] = []

    def create_room(self, name):
        rid = f"room{len(self._rooms)}"
        self._rooms.append(rid)
        return {"id": rid, "team": f"team-{rid}", "name": name}

    def get_room(self, room_id):
        return {"id": room_id, "team": f"team-{room_id}", "name": "reused", "archivedAt": None}

    def add_stand(self, rid, tid, cwd=None):
        name = f"Stand-{tid}-{len(self._stands)}"
        self._stands.append(name)
        self._cwds = getattr(self, "_cwds", [])
        self._cwds.append(cwd)
        self._script[name] = (list(self._thinker_replies) if tid == "thinker-tpl"
                              else ["Worker 干完了，产物在 /tmp/out.txt"])
        return {"name": name, "sessionId": f"ses-{name}"}

    def list_template_ids(self):
        return {"thinker-tpl", "worker-tpl"}

    def archive_room(self, rid):
        self._archived = getattr(self, "_archived", [])
        self._archived.append(rid)

    def _session_status(self, sid):
        return "running"

    def relay_to_wechat(self, **kw):
        return {"ok": True, "dry_run": True}

    def send_message(self, team, to, body, **kw):
        """发出去后立刻替目标 Stand 回一条——模拟 areco relay + Stand 应答。"""
        mid = super().send_message(team, to, body, **kw)
        queued = self._script.get(to) or []
        if queued:
            super().send_message(team, "all", queued.pop(0), from_=to)
        return mid


GOOD_PLAN = ("目标：归档\n步骤：\n1. 建目录 | 工具：mkdir | 产物：/tmp/a\n"
             "2. 移文件 | 工具：mv | 产物：无\n完成判据：目录存在")
BAD_PLAN = "我觉得可以先建个目录，然后把文件挪进去，大概就这样。"


def _run_plan(thinker_replies: list[str]) -> dict:
    tmp = pathlib.Path(tempfile.mkdtemp())
    c = _FakeCaller(tmp / "projects.db")
    c._thinker_replies = thinker_replies
    # 计划落盘也要隔离——否则测试会往仓库的 data/plans/ 里灌垃圾（首轮实测灌了 4 条）
    _dir, _idx = C.PLANS_DIR, C.PLANS_INDEX
    C.PLANS_DIR = tmp / "plans"
    C.PLANS_INDEX = C.PLANS_DIR / "index.jsonl"
    try:
        return c.plan_and_execute("设计一个归档方案并落盘", poll_timeout=3, dry_run=True)
    finally:
        C.PLANS_DIR, C.PLANS_INDEX = _dir, _idx


def test_plan_and_execute() -> None:
    print("\n[plan_and_execute] P0-2 三级降级 + P0-3 共享房间")
    _sleep = C.time.sleep
    C.time.sleep = lambda *a, **k: None  # 不真等 TUI boot / tail 合并
    try:
        r = _run_plan([GOOD_PLAN])
        rooms = {d.get("room_id") for d in (r["plan"], r["execute"]) if d.get("room_id")}
        check(r["stage"] == "execute" and not r["degraded"], "计划合格 → 正常两段式")
        check(len(rooms) == 1, f"P0-3：计划段与执行段共享一个房间（实得 {len(rooms)} 个）")
        check("Worker" in r["result_text"], "P0-3 前置：Worker 的结果不是 Thinker 的计划（认人认位生效）")

        r = _run_plan([BAD_PLAN, GOOD_PLAN])
        check(r["stage"] == "execute" and not r["degraded"], "降级 1：重申后合格，不算降级")

        r = _run_plan([BAD_PLAN, BAD_PLAN])
        check(r["stage"] == "execute" and r["degraded"], "降级 2：两轮不合格 → 交 Worker 而非全损")
        check(bool(r["result_text"]), "降级 2：用户拿到了产出（改动前此处为零产出）")

        r = _run_plan([])
        check(r["stage"] == "plan_failed", "降级 3：Thinker 零回复 → 真 plan_failed")
    finally:
        C.time.sleep = _sleep


def test_dispatch_hardening() -> None:
    """审计（2026-07-26）指出的派发期缺陷：孤儿房 / 归档房挂死 / 未知模板。"""
    print("\n[dispatch] 派发期加固（孤儿房 / 归档房 / 未知模板）")
    _sleep = C.time.sleep
    C.time.sleep = lambda *a, **k: None
    try:
        tmp = pathlib.Path(tempfile.mkdtemp())

        # 1) 未知模板 → 在建房之前就拒绝，不留孤儿房
        c = _FakeCaller(tmp / "a.db")
        try:
            c.dispatch("任务", template_id="不存在的模板")
            check(False, "未知模板应被拒绝")
        except RuntimeError as e:
            check("不存在" in str(e), "未知模板 → 建房前拒绝")
            check(not c._rooms, "未知模板 → 一个房间都没建（改动前会留孤儿房）")

        # 2) add_stand 中途失败 → 自建的房间被回滚归档
        c = _FakeCaller(tmp / "b.db")
        c.add_stand = lambda rid, tid, cwd=None: (_ for _ in ()).throw(RuntimeError("areco 起 Stand 失败"))
        try:
            c.dispatch("任务")
            check(False, "add_stand 失败应向上抛")
        except RuntimeError:
            check(c._rooms == getattr(c, "_archived", []),
                  f"中途失败 → 自建房间已回滚归档（建 {c._rooms} / 归档 {getattr(c, '_archived', [])}）")

        # 3) 已归档房间 → 当场拒绝，而不是让 --wait 无限等
        c = _FakeCaller(tmp / "c.db")
        c.get_room = lambda rid: {"id": rid, "team": f"team-{rid}", "name": "旧房",
                                  "archivedAt": "2026-07-01T00:00:00Z"}
        try:
            c.dispatch("任务", room_id="room-old")
            check(False, "归档房间应被拒绝")
        except RuntimeError as e:
            check("已归档" in str(e), "归档房间 → 当场拒绝（改动前 --wait 会静默挂死）")
    finally:
        C.time.sleep = _sleep


def test_workspace_isolation() -> None:
    """isolated=True 时工作目录要真传给 areco（此前 applied 硬编码 False，隔离是空壳）。"""
    print("\n[workspace] 隔离工作区落地")
    _sleep, _ws = C.time.sleep, C.WORKSPACE_DIR
    C.time.sleep = lambda *a, **k: None
    C.WORKSPACE_DIR = pathlib.Path(tempfile.mkdtemp()) / "ws"
    try:
        tmp = pathlib.Path(tempfile.mkdtemp())
        c = _FakeCaller(tmp / "iso.db")
        r = c.dispatch("任务", isolated=True)
        check(r["workspace"] and str(C.WORKSPACE_DIR) in r["workspace"], "工作目录已准备")
        check(c._cwds[-1] == r["workspace"], "cwd 已传给 add_stand（areco per-session cwd）")
        check(r["workspace_cwd"] is True, "applied=True（此前硬编码 False）")

        # 不开隔离时不传 cwd，走模板默认
        c2 = _FakeCaller(tmp / "noiso.db")
        c2.dispatch("任务")
        check(c2._cwds[-1] is None, "未开隔离 → 不传 cwd，用模板默认目录")
    finally:
        C.time.sleep, C.WORKSPACE_DIR = _sleep, _ws


def test_conf_float() -> None:
    """配置手误不该让整个 CLI 死在 import 上。"""
    print("\n[_conf_float] 配置解析容错")
    check(C._conf_float("__NOPE__", None, 30) == 30.0, "缺省 → 默认值")
    os.environ["__BAD_FLOAT__"] = "30m"
    try:
        check(C._conf_float("__BAD_FLOAT__", None, 30) == 30.0, "手误 '30m' → 回落默认值而非崩溃")
    finally:
        del os.environ["__BAD_FLOAT__"]


def test_inbox_lock() -> None:
    """.processing 锁：原子获取 + 过期抢占（改动前 TOCTOU 且永不过期）。"""
    print("\n[inbox] .processing 锁")
    import time as _t
    orig_dir = C.INBOX_DIR
    C.INBOX_DIR = pathlib.Path(tempfile.mkdtemp())
    try:
        check(C.acquire_processing_lock("t1"), "首次获取成功")
        check(not C.acquire_processing_lock("t1"), "重复获取被拒（原子，非 TOCTOU）")
        pp = C._processing_path("t1")
        old = _t.time() - C.LOCK_STALE_SEC - 60
        os.utime(pp, (old, old))
        check(C.acquire_processing_lock("t1"), "过期锁被抢占（改动前=永久锁死）")
        C.release_processing_lock("t1")
        check(not pp.exists(), "释放后锁消失")
    finally:
        C.INBOX_DIR = orig_dir


def test_wechat_target_guard() -> None:
    """WECHAT_TARGET 为空时不许发——cc-send 裸 -s '' 会回落到活跃会话指针发错人。"""
    print("\n[relay] 空 WECHAT_TARGET 闸")
    orig = C.WECHAT_TARGET
    C.WECHAT_TARGET = ""
    try:
        r = C.send_callback_trigger("task-x", "测试")
        check(not r["ok"] and "WECHAT_TARGET" in (r.get("error") or ""),
              "未配置目标 → 不发并说明原因（改动前会发给碰巧活跃的会话）")
    finally:
        C.WECHAT_TARGET = orig


def test_plan_reuse() -> None:
    """P1-3 计划复用：落盘 → 相似命中跳过 Thinker → 不相似不误用 → 降级不入库。"""
    print("\n[plans] P1-3 计划复用（opt-in）")
    _sleep, _dir, _idx = C.time.sleep, C.PLANS_DIR, C.PLANS_INDEX
    C.time.sleep = lambda *a, **k: None
    C.PLANS_DIR = pathlib.Path(tempfile.mkdtemp()) / "plans"
    C.PLANS_INDEX = C.PLANS_DIR / "index.jsonl"
    try:
        tmp = pathlib.Path(tempfile.mkdtemp())
        c = _FakeCaller(tmp / "1.db")
        c._thinker_replies = [GOOD_PLAN]
        c.plan_and_execute("把这批判决书归档并建索引", poll_timeout=3, dry_run=True)
        check(len(C.load_plans()) == 1, "合格计划自动落盘")

        c2 = _FakeCaller(tmp / "2.db")
        c2._thinker_replies = ["不该被用到的新计划"]
        r2 = c2.plan_and_execute("把这批判决书归档并建索引", poll_timeout=3,
                                 dry_run=True, reuse_plan=True)
        check(bool(r2.get("reused_plan")), f"相似任务命中复用（相似度 "
                                           f"{(r2.get('reused_plan') or {}).get('score')}）")
        check(len(c2._stands) == 1, f"跳过 Thinker 段：只起 {len(c2._stands)} 个 Stand（原需 2 个）")

        c3 = _FakeCaller(tmp / "3.db")
        c3._thinker_replies = [GOOD_PLAN]
        r3 = c3.plan_and_execute("给客户写一份股权转让协议", poll_timeout=3,
                                 dry_run=True, reuse_plan=True)
        check(not r3.get("reused_plan"), "不相似任务不误用历史计划")
        check(len(c3._stands) == 2, "不命中时正常走两段式")

        before = len(C.load_plans())
        c4 = _FakeCaller(tmp / "4.db")
        c4._thinker_replies = ["散文没有步骤段", "还是散文"]
        c4.plan_and_execute("完全不同的任务描述xyz", poll_timeout=3, dry_run=True)
        check(len(C.load_plans()) == before, "降级产出不入库（不合格计划复用会放大误差）")
    finally:
        C.time.sleep, C.PLANS_DIR, C.PLANS_INDEX = _sleep, _dir, _idx


def main() -> int:
    for t in (test_route_mode, test_route_mode_fast, test_resolve_mode, test_finish_room_guards,
              test_parse_plan, test_plan_and_execute,
              test_dispatch_hardening, test_workspace_isolation, test_conf_float, test_inbox_lock,
              test_wechat_target_guard, test_plan_reuse):
        t()
    print()
    if _fails:
        print(f"❌ {len(_fails)} 项失败：")
        for f in _fails:
            print(f"   - {f}")
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
