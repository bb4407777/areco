#!/usr/bin/env python3
"""三角色口径对齐测试（2026-08-02 检查报告 P1-1/P1-2）。

背景：08-01 高律师定案角色只剩 Caller/Thinker/Worker——重活并入 Thinker、快速并入
Worker；areco 设置页同日收敛三角色（heavyWorker/fastWorker 字段已删）。此前
resolve_lane_anchors 只认旧字段，读不到一路落文件内常量 → 设置页改 Thinker/Worker
两车道不跟（UI 一套、实际另一套）。本测试钉死新解析链与 registry 元数据一致性：

① 车道锚 = 角色锚：conf 只给 thinker/worker 时 heavy=thinker、fast=worker；
② 迁移期兼容：conf 还带旧字段 heavyWorker/fastWorker 时旧字段优先；
③ 全挂兜底：conf 空 → 文件内常量（source=常量fallback）；
④ registry 一致性：default_thinker/default_worker/task_type_defaults 引用的模板
  role 元数据必须与角色相符（kimi-k3 曾标 worker 却被 default_thinker 引用，
  房名 T/W、台账 role、审计统计全被带偏——P1-2）。

跑法：python3 caller/test_role_alignment.py   （零依赖、全离线，不碰 areco）
"""
import os
import pathlib
import sys
import tempfile

_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-roles-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY", "off")
os.environ["STANDCODE_STAND_STOP"] = os.path.join(_TEST_ISO, "stand-stop.json")
os.environ["STANDCODE_SKILL_MD"] = os.path.join(_TEST_ISO, "SKILL.md")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


def _with_conf(conf: dict, source: str = "areco-api"):
    """monkeypatch _areco_standcode_conf 与其 memo，跑一次 resolve_lane_anchors。"""
    orig = C._areco_standcode_conf
    C._STANDCODE_CONF_MEMO = None
    C._areco_standcode_conf = lambda: (conf, source)
    try:
        return C.resolve_lane_anchors()
    finally:
        C._areco_standcode_conf = orig
        C._STANDCODE_CONF_MEMO = None


def test_lane_follows_roles() -> None:
    print("\n[车道锚=角色锚] 设置页三角色即车道 SoT（08-01 定案的结构化落地）")
    a = _with_conf({"caller": "hermes", "thinker": "tpl-T", "worker": "tpl-W"})
    check(a["heavy"][0] == "tpl-T", "heavy 锚跟随 thinker")
    check("=thinker" in a["heavy"][1], "heavy 来源标注 (=thinker)")
    check(a["fast"][0] == "tpl-W", "fast 锚跟随 worker")
    check("=worker" in a["fast"][1], "fast 来源标注 (=worker)")

    b = _with_conf({"thinker": "tpl-T2", "worker": "tpl-W2"})
    check(b["heavy"][0] == "tpl-T2" and b["fast"][0] == "tpl-W2",
          "设置页改 Thinker/Worker，两车道即时跟随")


def test_legacy_fields_compat() -> None:
    print("\n[迁移期兼容] 旧字段 heavyWorker/fastWorker 残留时优先尊重")
    a = _with_conf({"thinker": "tpl-T", "worker": "tpl-W",
                    "heavyWorker": "legacy-H", "fastWorker": "legacy-F"})
    check(a["heavy"][0] == "legacy-H", "旧字段 heavyWorker 优先")
    check("旧字段" in a["heavy"][1], "heavy 来源标注旧字段")
    check(a["fast"][0] == "legacy-F", "旧字段 fastWorker 优先")


def test_const_fallback() -> None:
    print("\n[全挂兜底] conf 空 → 文件内常量")
    a = _with_conf({}, source="")
    check(a["heavy"] == (C.HEAVY_LANE_STAND, "常量fallback"), "heavy 落常量")
    check(a["fast"] == (C.FAST_LANE_STAND, "常量fallback"), "fast 落常量")


def test_registry_role_metadata() -> None:
    print("\n[registry 一致性] 默认角色引用的模板 role 元数据必须相符（P1-2）")
    import json
    reg = json.loads((pathlib.Path(__file__).resolve().parent.parent
                      / "stand" / "registry.json").read_text())
    roles = {t["id"]: t.get("role") for t in reg.get("templates", [])}

    thinker_id = reg.get("default_thinker")
    check(roles.get(thinker_id) == "thinker",
          f"default_thinker({thinker_id}) 模板 role=thinker")
    worker_id = reg.get("default_worker")
    check(roles.get(worker_id) == "worker",
          f"default_worker({worker_id}) 模板 role=worker")
    # 重活并入 Thinker（08-01）：heavy 镜像字段引用的模板也应是 thinker 角色
    heavy_id = reg.get("default_heavy_worker")
    if heavy_id:
        check(roles.get(heavy_id) == "thinker",
              f"default_heavy_worker({heavy_id}) 并入 Thinker 后 role=thinker")
    tmap = reg.get("task_type_defaults", {})
    for tt in ("think", "plan"):
        tid = tmap.get(tt)
        tid = tid.get("template_id") if isinstance(tid, dict) else tid
        if tid:
            check(roles.get(tid) == "thinker", f"task_type_defaults[{tt}]({tid}) role=thinker")
    for tt in ("execute", "work", "fast"):
        tid = tmap.get(tt)
        tid = tid.get("template_id") if isinstance(tid, dict) else tid
        if tid:
            check(roles.get(tid) == "worker", f"task_type_defaults[{tt}]({tid}) role=worker")


def main() -> int:
    test_lane_follows_roles()
    test_legacy_fields_compat()
    test_const_fallback()
    test_registry_role_metadata()
    print()
    if _fails:
        print(f"✗ {len(_fails)} 项失败：{_fails}")
        return 1
    print(f"全部通过（隔离目录 {_TEST_ISO}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
