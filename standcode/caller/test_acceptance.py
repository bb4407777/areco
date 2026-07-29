#!/usr/bin/env python3
"""作业单验收栏 + 结果把关闸的离线测试（2026-07-29 批件①）。

2026-07-29 高律师令验收闸整体关停（判据提取误伤三次）：ACCEPTANCE_GATE_ENABLED
默认 False，验收栏照写但不机检/不打回/不升级。闸逻辑保留未删，把关闸相关测试
（test_gate / test_gate_switch 开闸半）改临时开闸验证口径——同三闸先例。

全程不碰 areco、不烧额度：Caller 用 object.__new__ 绕过 __init__，
send_message / poll_result 全 mock；INBOX_DIR 重指到临时目录防污染生产收信箱。
跑法：python3 caller/test_acceptance.py   （零依赖，不需要 pytest）

为什么值得有：把关闸的三个分支（机检过 / 打回后补齐 / 二次不过升级人工）在真派发里
复现成本高（要 Worker 配合演戏），离线 mock 是唯一能全覆盖三分支的地方；
ensure_acceptance_block 的幂等性坏掉的后果是每次 bg 回放都叠一层验收栏。
"""
import os
import re
import sys
import pathlib
import subprocess
import tempfile

# _TEST_ISO：离线测试环境隔离（2026-07-26 约定）。不隔离的桩事件会混进生产 audit.jsonl。
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY_DIR", os.path.join(_TEST_ISO, "standby"))
os.environ.setdefault("STANDCODE_STANDBY", "off")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

# inbox 目录是仓内写死路径，测试必须重指临时目录（防污染生产收信箱）
C.INBOX_DIR = pathlib.Path(_TEST_ISO) / "inbox"

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


# ── ensure_acceptance_block：三栏追加 + 幂等 ─────────────────────────
def test_ensure_block() -> None:
    print("\n[ensure_acceptance_block] 验收栏自动追加")
    # 1) 什么都没给 → 默认模板（自报判据 + 红线），source=default
    req2, acc = C.ensure_acceptance_block("统计一下今天的派单量")
    check(C.ACCEPT_HEADER in req2, "默认模板：追加了验收栏")
    check("产物路径" in req2 and "红线提醒" in req2, "默认模板：三栏齐（判据/产物路径/红线）")
    check(acc["source"] == "default" and not acc["criteria"], "默认模板：source=default 无预置判据")
    # 2) 正文落盘动词 → 不提取（2026-07-29 高律师令：文件判据只认「产物路径：」两路）
    req2, acc = C.ensure_acceptance_block("把 caller.py 行数统计写到 /tmp/x.txt")
    check(not acc["criteria"] and acc["source"] == "default",
          "正文落盘动词：不再自动抽判据，source=default")
    check("file:/tmp/x.txt" not in req2, "正文落盘动词：不把正文路径写进判据栏")
    # 3) 幂等：已带验收栏不重复追加
    req3, acc3 = C.ensure_acceptance_block(req2)
    check(req3 == req2 and req3.count(C.ACCEPT_HEADER) == 1, "幂等：二次调用不叠加")
    check(acc3.get("block_appended") is False, "幂等：标记 block_appended=False")
    # 4) 用户自带显式判据 → 不重复写判据栏，但补红线
    req4, acc4 = C.ensure_acceptance_block("干活。\n验收判据：\n- file:/tmp/a.txt")
    check(acc4["source"] == "explicit", "显式判据：source=explicit")
    check("红线提醒" in req4, "显式判据：仍补红线栏")
    check("完工自报（格式见上" not in req4, "显式判据：不再塞默认判据")
    # 5) 用户已写红线 → 不重复
    req5, _ = C.ensure_acceptance_block("干活，注意红线：别删库。")
    check(req5.count("红线提醒") == 0, "已有红线：不重复追加红线行")


# ── extract / 判据解析细节 ─────────────────────────────────────────
def test_parse() -> None:
    print("\n[extract_acceptance] 判据解析")
    acc = C.extract_acceptance(
        "修 bug。\n验收判据：\n1. file:/tmp/out.md（文件存在且非空）\n"
        "2. result_contains:全绿\n3. commit:/Users/gao/Code/areco\n产物路径：/tmp/out.md"
    )
    kinds = {(c["kind"], c["arg"]) for c in acc["criteria"]}
    check(("file", "/tmp/out.md") in kinds, "全角注释被剥掉（file:/tmp/out.md）")
    check(("result_contains", "全绿") in kinds, "result_contains 解析")
    check(("commit", "/Users/gao/Code/areco") in kinds, "commit 判据解析")
    check(len([c for c in acc["criteria"] if c["arg"] == "/tmp/out.md"]) == 1,
          "产物路径与判据同路径去重")
    acc2 = C.extract_acceptance("产物路径：无")
    check(not acc2["criteria"] and acc2["source"] == "default", "「产物路径：无」不算判据")
    # 2026-07-29 高律师令（验收闸去机械化）：正文枚举不提取；产物路径行多路径逐个独立
    acc3 = C.extract_acceptance(
        "用 court-docx文书/opencli/OCR（macOS Vision）等工具处理，参考 /tmp/a.txt、/tmp/b.txt。"
    )
    check(not acc3["criteria"] and acc3["source"] == "default",
          "正文顿号枚举（工具名/路径串）：一律不提取为判据")
    acc4 = C.extract_acceptance("产物路径：/tmp/a.txt、/tmp/b.txt、/tmp/c.txt")
    args4 = [c["arg"] for c in acc4["criteria"] if c["kind"] == "file"]
    check(args4 == ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"],
          "产物路径行顿号串：拆成 3 条独立 file 判据，不并整行")
    acc5 = C.extract_acceptance("产物路径：/tmp/a.txt;/tmp/b.txt，/tmp/c.txt（终稿）")
    args5 = [c["arg"] for c in acc5["criteria"] if c["kind"] == "file"]
    check(args5 == ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"],
          "产物路径行混用分隔符+全角注释：仍逐路径独立")


# ── verify_acceptance：机检 ────────────────────────────────────────
def test_verify() -> None:
    print("\n[verify_acceptance] 判据机检")
    good = pathlib.Path(_TEST_ISO) / "good.txt"
    good.write_text("hello 行数=7298\n")
    empty = pathlib.Path(_TEST_ISO) / "empty.txt"
    empty.write_text("")

    acc = {"criteria": [{"kind": "file", "arg": str(good), "raw": "", "origin": "explicit"}],
           "source": "explicit"}
    v = C.verify_acceptance(acc, result_text="done")
    check(v["level"] == "verified", "file 存在非空 → verified")

    acc = {"criteria": [{"kind": "file", "arg": str(_TEST_ISO) + "/missing.txt",
                         "raw": "", "origin": "explicit"}], "source": "explicit"}
    v = C.verify_acceptance(acc, result_text="我做完了")
    check(v["level"] == "check_failed", "file 不存在 → check_failed")
    check("不存在" in v["checks"][0]["detail"], "失败带 detail")

    acc = {"criteria": [{"kind": "file", "arg": str(empty), "raw": "", "origin": "explicit"}],
           "source": "explicit"}
    check(C.verify_acceptance(acc)["level"] == "check_failed", "0 字节文件 → check_failed")

    acc = {"criteria": [{"kind": "file_contains", "arg": f"{good}:行数=7298",
                         "raw": "", "origin": "explicit"}], "source": "explicit"}
    check(C.verify_acceptance(acc)["level"] == "verified", "file_contains 命中 → verified")
    acc = {"criteria": [{"kind": "file_contains", "arg": f"{good}:不存在的词",
                         "raw": "", "origin": "explicit"}], "source": "explicit"}
    check(C.verify_acceptance(acc)["level"] == "check_failed", "file_contains 未命中 → check_failed")

    acc = {"criteria": [{"kind": "result_contains", "arg": "commit", "raw": "", "origin": "explicit"}],
           "source": "explicit"}
    check(C.verify_acceptance(acc, result_text="已提交 commit abc1234")["level"] == "verified",
          "result_contains 命中 → verified")

    # Worker 自报「产物路径：/xxx」→ 反向机检（默认模板唯一的机检抓手）
    v = C.verify_acceptance({"criteria": [], "source": "default"},
                            result_text=f"干完了\n产物路径：{good}")
    check(v["level"] == "verified" and any(c.get("origin") == "self_report" for c in v["checks"]),
          "自报真路径 → verified（origin=self_report）")
    v = C.verify_acceptance({"criteria": [], "source": "default"},
                            result_text="干完了\n产物路径：/tmp/definitely-missing-xyz.txt")
    check(v["level"] == "check_failed", "自报假路径 → check_failed（谎报被抓）")
    v = C.verify_acceptance({"criteria": [], "source": "default"},
                            result_text="纯分析结论如下…\n产物路径：无")
    check(v["level"] == "agent_reported" and "无" in v["note"], "自报「无」→ agent_reported")
    # 2026-07-29 高律师令：自报多路径逐条独立机检；正文提到的路径不提取
    v = C.verify_acceptance({"criteria": [], "source": "default"},
                            result_text=f"干完了\n产物路径：{good}、/tmp/definitely-missing-xyz.txt")
    file_checks = [c for c in v["checks"] if c["check"].startswith("file:")]
    check(v["level"] == "check_failed" and len(file_checks) == 2
          and file_checks[0]["passed"] and not file_checks[1]["passed"],
          "自报两路径一真一假：逐条独立，假的那条打回（不并整行、不一票全否）")
    v = C.verify_acceptance({"criteria": [], "source": "default"},
                            result_text="结果已写到 /tmp/definitely-missing-xyz.txt，请查收")
    check(v["level"] == "agent_reported" and not v["checks"],
          "正文落盘动词提到的路径：不提取，无可机检判据转人工")


def test_verify_commit() -> None:
    print("\n[verify_acceptance] commit 判据（临时真仓）")
    repo = pathlib.Path(_TEST_ISO) / "repo"
    repo.mkdir()
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q"], cwd=repo, env=env, check=True)
    (repo / "a.txt").write_text("x")
    subprocess.run(["git", "add", "a.txt"], cwd=repo, env=env, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "t"], cwd=repo, env=env, check=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, env=env,
                         capture_output=True, text=True).stdout.strip()
    acc = {"criteria": [{"kind": "commit", "arg": str(repo), "raw": "", "origin": "explicit"}],
           "source": "explicit"}
    check(C.verify_acceptance(acc, result_text=f"已提交 {sha[:12]}")["level"] == "verified",
          "回复报真 hash → verified")
    check(C.verify_acceptance(acc, result_text="已提交 deadbeefcafe")["level"] == "check_failed",
          "回复报假 hash → check_failed")
    check(C.verify_acceptance(acc, result_text="提交完成（没报 hash）")["level"] == "check_failed",
          "不报 hash → check_failed")


# ── 三段式打回话术 ────────────────────────────────────────────────
def test_rejection() -> None:
    print("\n[build_rejection_message] 三段式打回")
    v = {"level": "check_failed",
         "checks": [{"check": "file:/tmp/x.txt", "passed": False, "detail": "文件不存在"},
                    {"check": "result_contains:全绿", "passed": True, "detail": ""}]}
    msg = C.build_rejection_message(v, attempt=1)
    check("一、差距" in msg and "二、锚点" in msg and "三、修改范围" in msg, "三段结构齐全")
    check("file:/tmp/x.txt" in msg and "文件不存在" in msg, "差距段带机检实测")
    check("result_contains:全绿" not in msg, "已过判据不进打回单（只报差距）")
    check("已过的部分不要动" in msg, "范围段限制只补差价")
    check("再改改" not in msg, "无「再改改」式废话")


# ── gate_result：机检→打回→复检→升级 三分支（mock Caller）────────────
def _fake_caller():
    caller = object.__new__(C.Caller)  # 绕过 __init__（不碰 areco）
    caller.sent: list[tuple] = []
    return caller


def test_gate() -> None:
    # 2026-07-29 高律师令验收闸整体关停：开关默认 False，把关闸三分支的闸逻辑
    # 保留未删——测试改临时开闸验证口径（同三闸先例），跑完恢复原值。
    print("\n[gate_result] 把关闸三分支（临时开闸验证）")
    orig = C.ACCEPTANCE_GATE_ENABLED
    C.ACCEPTANCE_GATE_ENABLED = True
    try:
        tgt = pathlib.Path(_TEST_ISO) / "gate.txt"
        if tgt.exists():
            tgt.unlink()
        acc = {"criteria": [{"kind": "file", "arg": str(tgt), "raw": "", "origin": "explicit"}],
               "source": "explicit"}
        disp = {"task_id": "t1", "session_id": "room-test", "room_id": "r1",
                "stand_name": "Stand-W", "stand_session_id": "s1", "role": "worker",
                "template_id": "claude-glm52", "message_id": 1}

        # 分支 1：机检直接过（文件在场）→ 不打回
        tgt.write_text("data")
        caller = _fake_caller()
        caller.send_message = lambda *a, **k: (_ for _ in ()).throw(AssertionError("不该打回"))
        g = C.Caller.gate_result(caller, disp, {"status": "completed", "result_text": "done"}, acc)
        check(g["verification"]["level"] == "verified" and not g["bounced"], "判据过 → 不打回")

        # 分支 2：首轮谎报 → 打回（三段式送达同房）→ 补齐 → 复检 verified
        tgt.unlink()
        caller = _fake_caller()

        def fake_send(team, to, body, **k):
            caller.sent.append((team, to, body))
            tgt.write_text("补齐了")  # Worker 收到打回后补作业
            return 42

        caller.send_message = fake_send
        caller.poll_result = lambda **k: {"status": "completed", "result_text": "已补齐\n产物路径：" + str(tgt)}
        g = C.Caller.gate_result(caller, disp, {"status": "completed", "result_text": "我完成了（其实没有）"}, acc)
        check(g["bounced"] and not g["escalated"], "谎报被抓 → 打回一次后过")
        check(g["verification"]["level"] == "verified" and g["verification"]["attempts"] == 2,
              "复检 verified，attempts=2")
        team, to, body = caller.sent[0]
        check(team == "room-test" and to == "Stand-W", "打回送达同房同 Stand")
        check("一、差距" in body and "二、锚点" in body and "三、修改范围" in body,
              "打回话术是三段式")
        check("补齐（第 2 轮）" in g["poll"]["result_text"], "两轮结果合并入回执")

        # 分支 3：打回后仍不过 → 升级人工
        tgt.unlink()
        caller = _fake_caller()
        caller.send_message = lambda *a, **k: 43
        caller.poll_result = lambda **k: {"status": "completed", "result_text": "还是嘴上说完成"}
        g = C.Caller.gate_result(caller, disp, {"status": "completed", "result_text": "完成"}, acc)
        check(g["escalated"] and g["verification"]["level"] == "check_failed", "二次不过 → 升级人工")
        check("升级" in g["verification"].get("note", ""), "note 写明升级")

        # 分支 3b：打回消息发送失败 → 如实升级，不假装过
        caller = _fake_caller()
        caller.send_message = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db locked"))
        g = C.Caller.gate_result(caller, disp, {"status": "completed", "result_text": "完成"}, acc)
        check(g["escalated"] and not g["bounced"], "打回发送失败 → 升级（fail-closed）")
    finally:
        C.ACCEPTANCE_GATE_ENABLED = orig


# ── ACCEPTANCE_GATE_ENABLED 总开关（2026-07-29 高律师令验收闸关停）────────
def test_gate_switch() -> None:
    print("\n[ACCEPTANCE_GATE_ENABLED] 验收闸总开关")
    check(not C.ACCEPTANCE_GATE_ENABLED, "开关常量默认 False（2026-07-29 高律师令关停）")
    acc = {"criteria": [{"kind": "file", "arg": "/tmp/definitely-missing-xyz.txt",
                         "raw": "", "origin": "explicit"}], "source": "explicit"}
    spec = {"mode": "worker", "request": "写个文件", "acceptance": acc}

    def fin_of(task_id: str):
        caller = _fake_caller()
        caller.collect_stand_cost = lambda sid: None
        return C._finalize_waiter(
            caller, task_id, {"task_id": task_id, "spec": spec},
            {"status": "completed", "result_text": "完成", "room_id": "r1"},
            spec=spec, files=[], request_summary=None,
        )

    # 关闸（生产口径）：判据不机检，结果直报并如实标注
    v = fin_of("sw-off")["verification"]
    check(v["level"] == "agent_reported" and not v["checks"]
          and "验收闸已关停" in (v.get("note") or ""),
          "关闸：不机检不打回，agent_reported 直报并标注")

    # 临时开闸验证（同三闸先例）：机检恢复，假路径照抓
    orig = C.ACCEPTANCE_GATE_ENABLED
    C.ACCEPTANCE_GATE_ENABLED = True
    try:
        v2 = fin_of("sw-on")["verification"]
        check(v2["level"] == "check_failed", "临时开闸：判据机检恢复，假路径 check_failed")
    finally:
        C.ACCEPTANCE_GATE_ENABLED = orig


# ── _finalize_waiter：旧式派单标注「无判据未验」────────────────────────
def test_finalize_legacy_note() -> None:
    print("\n[_finalize_waiter] 旧式派单向后兼容")
    caller = _fake_caller()
    caller.collect_stand_cost = lambda sid: None
    state = {"task_id": "legacy-1", "spec": {}}
    res = {"status": "completed", "result_text": "老任务干完了", "room_id": "r9"}
    fin = C._finalize_waiter(
        caller, "legacy-1", state, res,
        spec={"mode": "worker", "request": "老任务"},  # 无 acceptance 字段=改动前落盘的 spec
        files=[], request_summary=None,
    )
    v = fin["verification"]
    check(v["level"] == "agent_reported" and v.get("criteria_source") == "none",
          "旧 spec 照常跑，criteria_source=none")
    check("无判据未验" in v.get("note", ""), "报告标注「无判据未验」")
    # ask 类（spec.mode 非派单）不背这个标注
    fin2 = C._finalize_waiter(
        caller, "legacy-2", {"task_id": "legacy-2", "spec": {}},
        {"status": "completed", "result_text": "答复"},
        spec={"request": "问答"}, files=[], request_summary=None,
    )
    check("无判据未验" not in (fin2["verification"].get("note") or ""),
          "非派单 spec 不标「无判据未验」")


def main() -> int:
    test_ensure_block()
    test_parse()
    test_verify()
    test_verify_commit()
    test_rejection()
    test_gate()
    test_gate_switch()
    test_finalize_legacy_note()
    print()
    if _fails:
        print(f"✗ {len(_fails)} 项失败：")
        for f in _fails:
            print(f"  - {f}")
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
