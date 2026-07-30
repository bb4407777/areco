#!/usr/bin/env python3
"""hermes-token-report — Hermes token 用量周报（2026-07-26，Fable5）

原理：state.db 的 session_model_usage 是**累计**计数器（按 session×model×billing 键），
不能按时间窗直接切片。本脚本用快照差分法：每次运行把当前累计总量追加到
logs/token-report-snapshots.jsonl，报表 = 本次累计 − 上次快照。首跑建基线。

为什么要这个：2026-07-26 上了三道 token 闸（compression 0.10 / tool_output 16KB /
session_reset daily）。闸有没有用，不靠感觉，靠这份周报的环比数字——
人是适应度函数，管理者看趋势定下一步，脚本不自动调参。

用法：
  hermes-token-report.py            # 打印报表（写快照）
  hermes-token-report.py --send     # 打印 + cc-send 发微信（cron 用）
  hermes-token-report.py --peek     # 只打印不写快照（随手查，不动基线）
"""

import json
import os
import sqlite3
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))  # ~/.qclaw-hermes
STATE_DB = os.path.join(BASE, "state.db")
SNAP_PATH = os.path.join(BASE, "logs", "token-report-snapshots.jsonl")
# 微信目标复用 StandCode 本机配置（不硬编码；缺失则只打印不发）
_SC_LOCAL = "/Users/gao/Code/StandCode/standcode/config/local.json"
CC_SEND = "/Users/gao/scripts/cc-send.sh"


def collect() -> dict:
    conn = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tot = conn.execute(
            "SELECT COALESCE(SUM(api_call_count),0) calls, COALESCE(SUM(input_tokens),0) inp,"
            " COALESCE(SUM(output_tokens),0) outp, COALESCE(SUM(cache_read_tokens),0) cread"
            " FROM session_model_usage"
        ).fetchone()
        comp = conn.execute(
            "SELECT COALESCE(SUM(api_call_count),0) c FROM session_model_usage WHERE task='compression'"
        ).fetchone()["c"]
        by_model = conn.execute(
            "SELECT model, SUM(input_tokens)+SUM(cache_read_tokens) w FROM session_model_usage"
            " GROUP BY model ORDER BY w DESC LIMIT 3"
        ).fetchall()
        sessions = conn.execute("SELECT COUNT(*) c FROM sessions").fetchone()["c"]
        msgs = conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
    finally:
        conn.close()
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "calls": tot["calls"], "input": tot["inp"], "output": tot["outp"],
        "cache_read": tot["cread"], "compressions": comp,
        "sessions": sessions, "messages": msgs,
        "top_models": {r["model"]: r["w"] for r in by_model},
    }


def last_snapshot() -> dict | None:
    if not os.path.exists(SNAP_PATH):
        return None
    last = None
    with open(SNAP_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    last = json.loads(line)
                except json.JSONDecodeError:
                    continue
    return last


def _fmt_wan(n: int) -> str:
    return f"{n/10000:.1f}万" if abs(n) >= 10000 else str(n)


def build_report(cur: dict, prev: dict | None) -> str:
    if prev is None:
        return (
            "📊 Hermes token 周报 · 首期基线\n"
            f"历史累计: 调用 {cur['calls']} 次 | 输入 {_fmt_wan(cur['input'])} | "
            f"缓存读 {_fmt_wan(cur['cache_read'])} | 压缩 {cur['compressions']} 次\n"
            "下期起出环比。三道闸(压缩0.10/输出16KB/每日重置)已于 2026-07-26 生效。"
        )
    # 差分；库被清理(会话删除)会出现负数，钳到 0 并注记
    dz = {k: cur[k] - prev.get(k, 0) for k in
          ("calls", "input", "output", "cache_read", "compressions", "sessions", "messages")}
    shrunk = any(v < 0 for v in dz.values())
    d = {k: max(0, v) for k, v in dz.items()}
    days = max(1, round((time.mktime(time.strptime(cur["ts"], "%Y-%m-%dT%H:%M:%S"))
                         - time.mktime(time.strptime(prev["ts"], "%Y-%m-%dT%H:%M:%S"))) / 86400))
    lines = [
        f"📊 Hermes token 周报（近 {days} 天）",
        f"调用 {d['calls']} 次 | 输入 {_fmt_wan(d['input'])} | 输出 {_fmt_wan(d['output'])} | 缓存读 {_fmt_wan(d['cache_read'])}",
        f"日均输入 {_fmt_wan(d['input'] // days)} | 压缩触发 {d['compressions']} 次 | 新会话 {d['sessions']} 个 | 新消息 {d['messages']} 条",
    ]
    if cur.get("top_models"):
        total_w = sum(cur["top_models"].values()) or 1
        tops = " / ".join(f"{m.split('/')[-1]} {w*100//total_w}%" for m, w in cur["top_models"].items())
        lines.append(f"累计权重: {tops}")
    if shrunk:
        lines.append("⚠️ 本期有会话清理，负增量已钳 0，数字偏保守")
    return "\n".join(lines)


def send_wechat(msg: str) -> bool:
    try:
        target = json.load(open(_SC_LOCAL)).get("wechat_target", "")
    except Exception:
        target = ""
    if not target or not os.path.exists(CC_SEND):
        print("（未配置微信目标或 cc-send 不在，跳过发送）", file=sys.stderr)
        return False
    env = {**os.environ, "HOME": "/Users/gao",
           "PATH": "/Users/gao/.npm-global/bin:" + os.environ.get("PATH", "")}
    proc = subprocess.run([CC_SEND, "-s", target, "-m", msg],
                          capture_output=True, text=True, timeout=30, env=env)
    return proc.returncode == 0


def main() -> int:
    peek = "--peek" in sys.argv
    do_send = "--send" in sys.argv
    cur = collect()
    prev = last_snapshot()
    report = build_report(cur, prev)
    print(report)
    if not peek:
        os.makedirs(os.path.dirname(SNAP_PATH), exist_ok=True)
        with open(SNAP_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(cur, ensure_ascii=False) + "\n")
    if do_send:
        ok = send_wechat(report)
        print(f"（微信发送 {'成功' if ok else '失败'}）", file=sys.stderr)
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
