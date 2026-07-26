#!/usr/bin/env python3
"""StandCode 派发审计：模式分布 + Gatekeeper 跟进率。

SKILL.md 从 2026-07-25 起就写着「每日 cron 分析昨日 terminal 调用，直干率 > 30% 微信告警」，
但执行体一直不存在（docs/progress.md 挂着 ⏳，scripts/ 是空目录）——规则已宣布、无人执行。
本脚本补上执行体。

⚠️ 先说清这个指标能看见什么、看不见什么（不诚实的数字比没有数字更贵）：

  能看见（审计日志 ~/.standcode/audit.jsonl 里有的）：
    · 派发的模式分布——每次 dispatch 落一行，带 mode 一等字段
    · Gatekeeper 判决分布——`caller.py check` 每次落一行 gatekeeper_check
    · **跟进率**：Gatekeeper 判「必须派发」之后，窗口内到底有没有真的 dispatch

  看不见（本脚本永远算不出真 · 直干率）：
    Caller 直干**根本不经过 caller.py**——它就是在 terminal 里直接跑 grep/git。
    没调 check 也没调 dispatch 的那些，在本日志里是彻底的空白。
    真直干率 = 直干次数 / terminal 调用总数，分母只在 Hermes 侧的会话记录里，
    需要另一个数据源（Hermes state.db / 会话 transcript）才能算。

  所以本脚本的告警口径是**跟进率**：判了要派却没派的比例。这是审计日志能诚实支撑的
  最强指标——它抓的是「明知该派还是自己上」，恰好是 workflow-hardening.md 记录的
  2026-07-25 那 6 次纠正的行为特征。

用法：
    python3 scripts/audit-direct-work.py                # 昨日
    python3 scripts/audit-direct-work.py --days 7       # 近 7 天
    python3 scripts/audit-direct-work.py --since 2026-07-20
    python3 scripts/audit-direct-work.py --json         # 结构化输出（cron 用）
    python3 scripts/audit-direct-work.py --threshold 30 # 跟进失败率超阈值时退出码 1

cron 建法：走 8020 API（`~/skills/cron` 面板），禁手改 jobs.json。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 与 caller.py 保持同一套解析（HOME_DIR → ~/.standcode/audit.jsonl），
# 但不 import caller —— 审计脚本不该因为主模块的任何 import 副作用而跑不起来。
_LOCAL_CONF_PATH = Path(__file__).resolve().parent.parent / "config" / "local.json"
try:
    _LOCAL_CONF = json.loads(_LOCAL_CONF_PATH.read_text()) if _LOCAL_CONF_PATH.exists() else {}
except Exception:
    _LOCAL_CONF = {}
HOME_DIR = os.environ.get("STANDCODE_HOME") or _LOCAL_CONF.get("home_dir") or str(Path.home())
AUDIT_LOG_PATH = Path(
    os.environ.get("STANDCODE_AUDIT_LOG") or (Path(HOME_DIR) / ".standcode" / "audit.jsonl")
)
# 跟进窗口：Gatekeeper 判「要派」之后多久内出现 dispatch 才算跟进了
FOLLOW_WINDOW = timedelta(minutes=10)


def _parse_ts(s: str) -> datetime | None:
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def load_records(path: Path, since: datetime, until: datetime) -> list[dict]:
    """读 jsonl，按时间窗过滤。坏行跳过——审计日志是 append-only，半行是正常的截断。"""
    if not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = _parse_ts(r.get("timestamp", ""))
            if ts and since <= ts <= until:
                r["_ts"] = ts
                out.append(r)
    return out


def analyze(records: list[dict]) -> dict:
    dispatches = [r for r in records if r.get("event") == "dispatch"]
    blocked = [r for r in records if r.get("event") == "dispatch_blocked"]
    checks = [r for r in records if r.get("event") == "gatekeeper_check"]
    degraded = [r for r in records if r.get("event") == "plan_degraded"]
    rejected = [r for r in records if r.get("event") == "mode_rejected"]

    # 跟进率：每条判「要派发」的 check，看窗口内有没有 dispatch
    must_dispatch = [c for c in checks if c.get("should_dispatch") is True]
    dispatch_times = sorted(d["_ts"] for d in dispatches)
    followed, unfollowed = 0, []
    for c in must_dispatch:
        t = c["_ts"]
        if any(t <= dt <= t + FOLLOW_WINDOW for dt in dispatch_times):
            followed += 1
        else:
            unfollowed.append(c)
    follow_fail_rate = (
        round(100.0 * len(unfollowed) / len(must_dispatch), 1) if must_dispatch else 0.0
    )

    return {
        "window": {
            "from": min((r["_ts"] for r in records), default=None),
            "to": max((r["_ts"] for r in records), default=None),
            "records": len(records),
        },
        "dispatch_total": len(dispatches),
        "by_mode": dict(Counter(d.get("mode") or "(未声明)" for d in dispatches).most_common()),
        "by_role": dict(Counter(d.get("role") or "?" for d in dispatches).most_common()),
        "by_template": dict(Counter(d.get("template") or "?" for d in dispatches).most_common()),
        "room_reused": sum(1 for d in dispatches if d.get("room_reused")),
        "gatekeeper": {
            "checks": len(checks),
            "by_category": dict(Counter(c.get("category", "?") for c in checks).most_common()),
            "must_dispatch": len(must_dispatch),
            "followed": followed,
            "unfollowed": len(unfollowed),
            "follow_fail_rate": follow_fail_rate,
        },
        "blocked": len(blocked),
        "plan_degraded": len(degraded),
        "mode_rejected": len(rejected),
        "unfollowed_samples": [
            {"at": c["_ts"].strftime("%m-%d %H:%M"), "task": (c.get("task_preview") or "")[:70]}
            for c in unfollowed[:5]
        ],
        "undeclared_mode": sum(1 for d in dispatches if not d.get("mode")),
    }


def render(a: dict, threshold: float) -> str:
    w = a["window"]
    if not w["records"]:
        return "审计窗口内无记录。（若确有派发发生，检查 STANDCODE_AUDIT_LOG 指向）"
    lines = [
        f"StandCode 派发审计 {w['from']:%m-%d %H:%M} → {w['to']:%m-%d %H:%M}"
        f"（{w['records']} 条记录）",
        "",
        f"派发总数：{a['dispatch_total']}"
        + (f"（复用房间 {a['room_reused']}）" if a["room_reused"] else ""),
    ]
    if a["by_mode"]:
        lines.append("模式分布：")
        total = max(a["dispatch_total"], 1)
        for m, n in a["by_mode"].items():
            bar = "█" * max(1, round(20 * n / total))
            lines.append(f"  {m:12s} {n:4d}  {100*n/total:5.1f}%  {bar}")
    if a["undeclared_mode"]:
        lines.append(
            f"  ⚠️ {a['undeclared_mode']} 次派发未声明 mode（老调用路径）——"
            "显式给 --mode 才进得了统计"
        )

    g = a["gatekeeper"]
    lines += ["", f"Gatekeeper：{g['checks']} 次核查"]
    if g["by_category"]:
        lines.append("  分级：" + "  ".join(f"{k}={v}" for k, v in g["by_category"].items()))
    if g["must_dispatch"]:
        lines.append(
            f"  跟进率：判「要派」{g['must_dispatch']} 次 → 真派了 {g['followed']} 次，"
            f"没跟进 {g['unfollowed']} 次（失败率 {g['follow_fail_rate']}%，"
            f"窗口 {int(FOLLOW_WINDOW.total_seconds() // 60)} 分钟）"
        )
        for s in a["unfollowed_samples"]:
            lines.append(f"    · {s['at']} {s['task']}")
    elif g["checks"]:
        lines.append("  本窗口内无「必须派发」判决")
    else:
        lines.append("  ⚠️ 零核查记录——Caller 没在动手前调 `caller.py check`，"
                     "跟进率无从谈起（这本身就是个信号）")

    extras = []
    if a["blocked"]:
        extras.append(f"BLOCKED 拒绝 {a['blocked']} 次")
    if a["plan_degraded"]:
        extras.append(f"计划降级 {a['plan_degraded']} 次")
    if a["mode_rejected"]:
        extras.append(f"模式拒绝 {a['mode_rejected']} 次")
    if extras:
        lines += ["", "其他：" + "，".join(extras)]

    if g["must_dispatch"] and g["follow_fail_rate"] > threshold:
        lines += ["", f"🔴 跟进失败率 {g['follow_fail_rate']}% 超阈值 {threshold}%——"
                      "判了该派却自己上，正是 workflow-hardening 记录的那个行为"]

    lines += [
        "",
        "注：本指标是**跟进率**不是真直干率。Caller 直干不经过 caller.py，",
        "    在本日志里是空白；真直干率的分母在 Hermes 侧会话记录，需另一数据源。",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="StandCode 派发审计（模式分布 + Gatekeeper 跟进率）")
    ap.add_argument("--days", type=int, default=1, help="回看天数（默认 1 = 昨日至今）")
    ap.add_argument("--since", default=None, help="起始日期 YYYY-MM-DD（覆盖 --days）")
    ap.add_argument("--json", action="store_true", dest="as_json", help="结构化输出")
    ap.add_argument("--threshold", type=float, default=30.0, help="跟进失败率告警阈值%%（默认 30）")
    ap.add_argument("--log", default=None, help="审计日志路径（默认 ~/.standcode/audit.jsonl）")
    args = ap.parse_args()

    path = Path(args.log) if args.log else AUDIT_LOG_PATH
    until = datetime.now(timezone.utc)
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            print(f"--since 格式应为 YYYY-MM-DD，收到：{args.since}", file=sys.stderr)
            return 2
    else:
        since = until - timedelta(days=args.days)

    records = load_records(path, since, until)
    a = analyze(records)

    if args.as_json:
        w = a["window"]
        a["window"] = {
            "from": w["from"].isoformat() if w["from"] else None,
            "to": w["to"].isoformat() if w["to"] else None,
            "records": w["records"],
        }
        a["audit_log"] = str(path)
        print(json.dumps(a, ensure_ascii=False, indent=2))
    else:
        print(render(a, args.threshold))

    g = a["gatekeeper"]
    return 1 if (g["must_dispatch"] and g["follow_fail_rate"] > args.threshold) else 0


if __name__ == "__main__":
    sys.exit(main())
