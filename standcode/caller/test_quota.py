#!/usr/bin/env python3
"""额度/限流检测与车道改道（2026-07-29 GLM 额度打满事件）的离线测试。

覆盖：① 重活车道 HEAVY_LANE_STAND 改道（registry claude-glm52 → kimi-k3）；
② quota_signal_hit 信号词扫描（含「第429条」法条边界保护）；
③ handle_quota_hit 处置链（停新单幂等/备胎改道/微信告警一次/SKILL.md 台账/审计）。

全程不碰 areco、不发真微信——cc-send 用假二进制，状态/台账/审计落隔离目录。
跑法：python3 caller/test_quota.py   （零依赖，不需要 pytest）
"""
import json
import os
import pathlib
import stat
import sys
import tempfile

# 离线隔离（与 test_guards.py 同口径）：必须在 import caller 之前落
_TEST_ISO = tempfile.mkdtemp(prefix="standcode-test-quota-")
os.environ.setdefault("STANDCODE_AUDIT_LOG", os.path.join(_TEST_ISO, "audit.jsonl"))
os.environ.setdefault("STANDCODE_TASKS_DIR", os.path.join(_TEST_ISO, "tasks"))
os.environ.setdefault("STANDCODE_ROOMS_LEDGER", os.path.join(_TEST_ISO, "rooms.jsonl"))
os.environ.setdefault("STANDCODE_STANDBY", "off")
os.environ["STANDCODE_STAND_STOP"] = os.path.join(_TEST_ISO, "stand-stop.json")
os.environ["STANDCODE_SKILL_MD"] = os.path.join(_TEST_ISO, "SKILL.md")
os.environ["WECHAT_TARGET"] = "test-target"

# 假 cc-send：把调用参数记到日志文件，返回 0
_FAKE_SEND = pathlib.Path(_TEST_ISO) / "fake-cc-send"
_FAKE_SEND_LOG = pathlib.Path(_TEST_ISO) / "fake-cc-send.log"
_FAKE_SEND.write_text(f'#!/bin/bash\necho "$*" >> {_FAKE_SEND_LOG}\nexit 0\n')
_FAKE_SEND.chmod(_FAKE_SEND.stat().st_mode | stat.S_IXUSR)
os.environ["CC_SEND_BIN"] = str(_FAKE_SEND)

pathlib.Path(os.environ["STANDCODE_SKILL_MD"]).write_text("# 测试用 SKILL\n")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import caller as C  # noqa: E402

_fails: list[str] = []


def check(cond: bool, label: str) -> bool:
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        _fails.append(label)
    return cond


def test_signal_words() -> None:
    print("\n[信号词表] 额度/限流信号扫描（大小写不敏感）")
    check(C.quota_signal_hit("Error 429: Too Many Requests") == "429", "命中 429")
    check(C.quota_signal_hit("HTTP/1.1 429") == "429", "命中 429（HTTP 状态行）")
    check(C.quota_signal_hit("Rate Limit exceeded") == "rate limit", "命中 rate limit（大写）")
    check(C.quota_signal_hit("insufficient QUOTA remaining") == "quota", "命中 quota（大小写混）")
    check(C.quota_signal_hit("余额不足，请充值") == "余额不足", "命中 余额不足")
    check(C.quota_signal_hit("Insufficient balance") == "insufficient", "命中 insufficient")
    check(C.quota_signal_hit("账户额度已用完") == "额度", "命中 额度")
    check(C.quota_signal_hit("任务完成，产物已落盘") is None, "正常交付不命中")
    check(C.quota_signal_hit("") is None, "空文本不命中")
    check(C.quota_signal_hit(None) is None, "None 不命中")


def test_429_boundary() -> None:
    print("\n[429 边界保护] 法条引用/长数字不误判（本所场景高频）")
    check(C.quota_signal_hit("依据民法典第429条规定") is None, "第429条 不命中")
    check(C.quota_signal_hit("第429号司法解释") is None, "第429号 不命中")
    check(C.quota_signal_hit("案卷编号4290") is None, "4290 长数字不命中")
    check(C.quota_signal_hit("返回码 429，已限流") == "429", "独立 429 仍命中")


def test_heavy_lane_reroute() -> None:
    print("\n[重活改道] HEAVY_LANE_STAND 常量 + registry 停新单标记")
    check(C.HEAVY_LANE_STAND == "kimi-k3", "HEAVY_LANE_STAND = kimi-k3")
    c = C.Caller()
    check(c.default_heavy_worker_id == "kimi-k3",
          f"重活锚加载后 = kimi-k3（实际 {c.default_heavy_worker_id}）")
    check("claude-glm52" in c._stopped_stands(), "registry 静态停新单标记生效")
    r = C.Caller.route_mode("帮我起草案件起诉状文书")
    check(r["mode"] == "worker", "法律重活词仍路由 worker 模式")
    check("kimi-k3" in r["reason"] and "改道" in r["reason"],
          "route_reason 写明改道 kimi-k3")


def test_handle_quota_hit() -> None:
    print("\n[处置链] 停新单幂等 / 备胎改道 / 微信告警一次 / 台账 / 审计")
    r1 = C.handle_quota_hit("claude-glm52", "429", source="poll:room-t",
                            sample="Error 429 rate limit")
    check(r1["already_stopped"] is False and r1["alerted"] is True,
          "首命中：停新单 + 微信告警")
    check(r1["fallback"] == "kimi-k3", "备胎表改道 kimi-k3")

    r2 = C.handle_quota_hit("claude-glm52", "quota", source="harvest:room-t",
                            sample="insufficient quota")
    check(r2["already_stopped"] is True and r2["alerted"] is False,
          "二次命中：幂等补记录，不重复告警")

    r3 = C.handle_quota_hit("unknown-stand", "额度", source="poll:room-u",
                            sample="额度不足")
    check(r3["fallback"] is None, "备胎表无映射不改道")

    state = json.loads(pathlib.Path(os.environ["STANDCODE_STAND_STOP"]).read_text())
    check(state["claude-glm52"]["stopped"] is True
          and len(state["claude-glm52"]["hits"]) == 2,
          "状态文件：停新单 + 两条命中记录")
    check(state["unknown-stand"]["stopped"] is True, "无映射 stand 也停新单")

    send_log = _FAKE_SEND_LOG.read_text()
    check(send_log.count("-s test-target") == 2,
          "微信告警共 2 条（claude-glm52 一次 + unknown-stand 一次）")
    check("kimi-k3" in send_log, "告警内容含改道目标")

    ledger = pathlib.Path(os.environ["STANDCODE_SKILL_MD"]).read_text()
    check(ledger.count("命中「") == 3, "SKILL.md 台账追加 3 条事件")

    audit = [json.loads(l) for l in
             pathlib.Path(os.environ["STANDCODE_AUDIT_LOG"]).read_text().splitlines()
             if l.strip()]
    quota_events = [e for e in audit if e.get("event") == "quota_hit"]
    check(len(quota_events) == 3, "审计日志 quota_hit × 3")


def test_dry_run_no_send() -> None:
    print("\n[dry_run] 不告警但仍登记停新单")
    before = _FAKE_SEND_LOG.read_text().count("-s test-target")
    r = C.handle_quota_hit("dry-stand", "429", source="harvest:room-d",
                           sample="429", dry_run=True)
    after = _FAKE_SEND_LOG.read_text().count("-s test-target")
    check(r["alerted"] is False and after == before, "dry_run 不发微信")
    state = json.loads(pathlib.Path(os.environ["STANDCODE_STAND_STOP"]).read_text())
    check(state["dry-stand"]["stopped"] is True, "dry_run 仍登记停新单")


if __name__ == "__main__":
    test_signal_words()
    test_429_boundary()
    test_heavy_lane_reroute()
    test_handle_quota_hit()
    test_dry_run_no_send()
    print(f"\n{'全部通过' if not _fails else '失败 ' + str(len(_fails)) + ' 项'}"
          f"（隔离目录 {_TEST_ISO}）")
    for f in _fails:
        print("  ✗", f)
    sys.exit(1 if _fails else 0)
