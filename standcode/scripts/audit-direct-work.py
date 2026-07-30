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

  2026-07-29 口径修正（任务⑦，高律师批准）：
    ① 直干率按**当班模型**分段——模型轮换后一锅算会把账记错人（07-29 实例：83.3%
      被归给印象里的当班模型，账对不上）。映射源 gateway agent.log 逐条模型记录，
      session_model_usage 聚合窗口兜底，都定不了段的进「(未标注)」桶并提示人工标注。
    ② 制度性命令（INSTITUTIONAL_CMDS：守则/章程强制同轮跑的入库/台账动作）不计入
      直干率**分子**——它们不是绕过派单；分母不变，报告头部注明剔除条数。

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
import bisect
import json
import os
import re
import sqlite3
import subprocess
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

# 真 · 直干率数据源（2026-07-26 补齐）：Hermes gateway 的会话库——每条 terminal 工具
# 调用（含完整命令）都在 messages.tool_calls 里。这补上了本脚本 docstring 里一直
# 声明的空白：「真直干率的分母在 Hermes 侧会话记录，需另一数据源」。
HERMES_STATE_DB = os.environ.get("HERMES_STATE_DB") or "/Users/gao/.qclaw-hermes/state.db"
# 「时段→当班模型」映射主源（任务⑦）：gateway agent.log——每次 API 调用/会话轮次
# 都落一行 `[<session_id>] ... model=<名>`，是本机唯一逐条带时间戳的当班模型记录。
# state.db 的 session_model_usage 只有 (会话,模型) 聚合窗口，混用会话里窗口互相
# 重叠（bb5a3cbd 案例重叠 17 小时），定不了段，只配当兜底。
HERMES_AGENT_LOG = os.environ.get("HERMES_AGENT_LOG") or "/Users/gao/.qclaw-hermes/logs/agent.log"
TREND_PATH = Path(HOME_DIR) / ".standcode" / "zhigan-daily.jsonl"

# 制度性命令白名单（任务⑦·2026-07-29 口径修正）：守则/章程强制 Caller 本人同轮
# 执行的入库/台账动作，不是绕过派单的直干——不计入直干率分子，分母不变。
#   add_memory.py / recall.py   memory 守则1：动手前召回、干完显式入库
#   gongguoge-log.py            章程：实质动作同轮录功过格（漏录=没干）
#   fetch-log.py                章程：内容抓取同轮录抓取台账
#   add-deadline.py             章程：硬截止日一律录期限巡检（同类制度台账，一并剔除）
# 判据：命令串含脚本文件名即算（统计口径）；新增/改名制度脚本记得同步这里。
INSTITUTIONAL_CMDS = (
    "add_memory.py",
    "recall.py",
    "gongguoge-log.py",
    "fetch-log.py",
    "add-deadline.py",
)
CC_SEND_BIN = os.environ.get("CC_SEND_BIN") or _LOCAL_CONF.get("cc_send_bin") or "cc-send"
WECHAT_TARGET = os.environ.get("WECHAT_TARGET") or _LOCAL_CONF.get("wechat_target") or ""


def hermes_terminal_commands(db_path: str, since: datetime, until: datetime) -> list[dict] | None:
    """从 Hermes state.db 抽取窗口内全部 terminal 命令（带会话与时刻，供按模型定段）。

    只读连接（mode=ro）——库归常驻 gateway 所有，审计侧绝不写。
    库不存在 / 打不开 / schema 变了 → 返回 None（上层如实说「没算成」，不出假数字）。
    返回 [{"cmd", "session", "ts"}]；messages 表没有 model 列，当班模型靠
    load_model_timeline / hermes_usage_windows 事后归段。
    """
    if not Path(db_path).exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
        rows = conn.execute(
            "SELECT session_id, timestamp, tool_calls FROM messages "
            "WHERE tool_calls IS NOT NULL AND tool_calls LIKE '%\"terminal\"%' "
            "AND timestamp BETWEEN ? AND ?",
            (since.timestamp(), until.timestamp()),
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return None
    out: list[dict] = []
    for sid, ts, raw in rows:
        try:
            calls = json.loads(raw)
        except Exception:
            continue
        for c in calls if isinstance(calls, list) else []:
            fn = (c or {}).get("function") or {}
            if fn.get("name") != "terminal":
                continue
            try:
                cmd = json.loads(fn.get("arguments") or "{}").get("command") or ""
            except Exception:
                continue
            if cmd.strip():
                out.append({"cmd": cmd.strip(), "session": sid, "ts": ts})
    return out


# agent.log 当班模型行，两类都收（API call / turn_context 等，凡带 [会话]+model= 的）：
#   2026-07-29 21:31:07,751 INFO [20260729_085316_c4bbfadb] agent.conversation_loop: API call #357: model=k3 ...
#   2026-07-25 15:08:19,200 INFO [20260723_085630_bb5a3cbd] agent.turn_context: conversation turn: ... model=pool-deepseek-v4-flash ...
_MODEL_LINE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ \S+ \[([^\]\s]+)\] \S+ .*?\bmodel=([\w.:/-]+)"
)


def load_model_timeline(log_path: str = HERMES_AGENT_LOG) -> dict:
    """从 gateway agent.log 抽「会话 → [(时刻, 当班模型)] 升序」逐条映射。

    日志时间是本机时区，转 epoch 后与 messages.timestamp 同轴。
    日志缺席/读不了 → 空映射（上层回落 usage 窗口，再定不了进「未标注」桶）。

    TODO(任务⑦遗留): agent.log 单文件不轮转，现存起点 2026-07-24；更早窗口只能
    靠 usage 窗口兜底。若未来加日志轮转/清理，这里要并读历史段，否则断档期的
    混用会话会退进「(未标注)」桶（届时报告已自带「需人工标注」提示，不出假数字）。
    """
    tz = datetime.now(timezone.utc).astimezone().tzinfo
    timeline: dict = {}
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if "model=" not in line:
                    continue
                m = _MODEL_LINE_RE.match(line)
                if not m:
                    continue
                try:
                    ts = (datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
                          .replace(tzinfo=tz).timestamp())
                except ValueError:
                    continue
                timeline.setdefault(m.group(2), []).append((ts, m.group(3)))
    except OSError:
        return {}
    for entries in timeline.values():
        entries.sort()
    return timeline


def hermes_usage_windows(db_path: str) -> dict:
    """session_model_usage 聚合窗口（兜底源）：会话 → [(first, last, model)]。

    窗口是聚合值，混用会话里互相重叠——只有「全会话单模型」或「时刻唯一命中」
    才敢下结论，其余交「(未标注)」桶如实示人。只读连接，失败 → 空。
    """
    if not Path(db_path).exists():
        return {}
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
        rows = conn.execute(
            "SELECT session_id, model, MIN(first_seen), MAX(last_seen) "
            "FROM session_model_usage WHERE first_seen IS NOT NULL "
            "GROUP BY session_id, model"
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return {}
    wins: dict = {}
    for sid, model, lo, hi in rows:
        wins.setdefault(sid, []).append((lo, hi or lo, model))
    return wins


_ATTR_TOLERANCE = 1800  # 秒：日志证据离消息超 30 分钟不硬贴，退窗口兜底


def attribute_model(session_id: str, ts: float, timeline: dict, windows: dict) -> str | None:
    """单条 terminal 消息 → 当班模型；两级来源都定不了段 → None（未标注）。"""
    entries = timeline.get(session_id)
    if entries:
        i = bisect.bisect_left(entries, (ts, ""))
        near = [e for e in (entries[i - 1] if i else None,
                            entries[i] if i < len(entries) else None) if e]
        best = min(near, key=lambda e: abs(e[0] - ts))
        if abs(best[0] - ts) <= _ATTR_TOLERANCE:
            return best[1]
    wins = windows.get(session_id) or []
    models = {m for _, _, m in wins}
    if len(models) == 1:
        return next(iter(models))
    hits = {m for lo, hi, m in wins if lo - 600 <= ts <= hi + 600}
    if len(hits) == 1:
        return next(iter(hits))
    return None


def analyze_hermes_direct(calls: list[dict], timeline: dict, windows: dict) -> dict | None:
    """真 · 直干率：每条 terminal 命令过 caller 的 Gatekeeper 分级。

    口径（任务⑦·2026-07-29 两处修正）：
      ① 制度性命令（INSTITUTIONAL_CMDS）先于分级剔除——单列 institutional，
        不进直干分子；分母 terminal_calls 不变。
      ② 按当班模型分段：attribute_model 逐条归段（agent.log 主源→usage 窗口
        兜底→「(未标注)」桶），by_model 各段直干率独立计算。
    operator（白名单：caller.py / areco-msg / lens / cc-send / 只读运维）= 本职；
    production / gray = 该派没派的直干。分级器复用 caller.check_should_dispatch——
    与 SKILL.md「禁止直干清单」同源，不另造一套会漂移的白名单。
    import caller 失败（跑在奇怪环境）→ 返回 None，如实缺席。
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "caller"))
        from caller import check_should_dispatch  # noqa: E402
    except Exception:
        return None
    total = len(calls)
    operator = blocked = institutional = 0
    direct: list[str] = []
    seg: dict = {}
    for call in calls:
        cmd = call["cmd"]
        model = attribute_model(call["session"], call["ts"], timeline, windows) or "(未标注)"
        s = seg.setdefault(model, {"terminal": 0, "operator": 0, "institutional": 0, "direct": 0})
        s["terminal"] += 1
        if any(name in cmd for name in INSTITUTIONAL_CMDS):
            institutional += 1
            s["institutional"] += 1
            continue
        cat = check_should_dispatch(cmd).get("category")
        if cat == "operator":
            operator += 1
            s["operator"] += 1
        elif cat == "blocked":
            blocked += 1
        else:  # production / gray：非白名单、该派发的活
            direct.append(cmd)
            s["direct"] += 1
    rate = round(100.0 * len(direct) / total, 1) if total else 0.0
    by_model = [
        {"model": m, **v,
         "direct_rate": round(100.0 * v["direct"] / v["terminal"], 1) if v["terminal"] else 0.0}
        for m, v in sorted(seg.items(), key=lambda kv: -kv[1]["terminal"])
    ]
    top = Counter(" ".join(c.split())[:60] for c in direct).most_common(5)
    return {
        "terminal_calls": total,
        "operator": operator,
        "blocked_cmds": blocked,
        "institutional": institutional,
        "direct": len(direct),
        "direct_rate": rate,
        "by_model": by_model,
        "model_source": "agent.log" if timeline else ("usage-window" if windows else None),
        "top_direct": [{"cmd": k, "n": n} for k, n in top],
    }


def append_trend(h: dict, until: datetime) -> None:
    """直干率趋势落盘（append-only jsonl），供周报/回看；写失败不影响审计输出。"""
    try:
        TREND_PATH.parent.mkdir(parents=True, exist_ok=True)
        with TREND_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"date": until.strftime("%Y-%m-%d"), **{
                k: h[k] for k in ("terminal_calls", "operator", "institutional",
                                  "direct", "direct_rate")
            }}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def send_alert(text: str) -> bool:
    """直干率超阈值时推微信（cc-send 纯文字不经 .ok gate）。失败只报 False 不炸审计。"""
    if not WECHAT_TARGET:
        return False
    try:
        proc = subprocess.run(
            [CC_SEND_BIN, "-s", WECHAT_TARGET, "-m", text],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "HOME": HOME_DIR,
                 "PATH": f"{HOME_DIR}/.npm-global/bin:{os.environ.get('PATH', '')}"},
        )
        return proc.returncode == 0
    except Exception:
        return False


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
                if _is_stub(r):
                    continue
                r["_ts"] = ts
                out.append(r)
    return out


def _is_stub(r: dict) -> bool:
    """测试桩痕迹（与 caller._audit_is_stub 同判据，此处内联——loader 不依赖主模块）。

    2026-07-25/26 离线测试曾把数百条桩事件（thinker-tpl/room0）灌进生产 audit.jsonl，
    读取侧过滤兜底；测试文件已加环境隔离。"""
    t = str(r.get("template") or "")
    rid = str(r.get("room_id") or "")
    return t.endswith("-tpl") or (rid.startswith("room") and rid[4:].isdigit() and len(rid) <= 8)


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

    h = a.get("hermes")
    if h:
        lines += [
            "",
            f"真 · 直干率（Hermes state.db，{h['terminal_calls']} 次 terminal 调用；"
            f"已剔除制度性命令 {h['institutional']} 条——守则/章程强制的入库/台账动作，不算直干）：",
            f"  白名单 operator {h['operator']}｜制度动作 {h['institutional']}｜直干 {h['direct']}"
            + (f"｜BLOCKED 命中 {h['blocked_cmds']}" if h["blocked_cmds"] else "")
            + f"  → 直干率 {h['direct_rate']}%",
        ]
        if h.get("by_model"):
            src = ("gateway agent.log 逐条模型记录，usage 窗口兜底"
                   if h.get("model_source") == "agent.log"
                   else "session_model_usage 聚合窗口（粗粒度兜底）")
            lines.append(f"  按当班模型分段（映射源：{src}）：")
            for s in h["by_model"]:
                lines.append(
                    f"    {s['model']:22s} terminal {s['terminal']:4d}｜制度 {s['institutional']:3d}"
                    f"｜直干 {s['direct']:4d}  → {s['direct_rate']}%"
                )
            if any(s["model"] == "(未标注)" for s in h["by_model"]):
                lines.append("    ⚠️ (未标注) 段无机器可读当班记录——模型切换需人工标注")
        if h["top_direct"]:
            lines.append("  直干 TOP：")
        for s in h["top_direct"]:
            lines.append(f"    · ×{s['n']}  {s['cmd']}")
        if h["terminal_calls"] and h["direct_rate"] > threshold:
            lines.append(f"  🔴 直干率 {h['direct_rate']}% 超阈值 {threshold}%（SKILL.md 红线）")
    else:
        lines += [
            "",
            "注：真直干率本次没算成（Hermes state.db 缺席或 caller 分级器不可用）——",
            "    上方跟进率仍有效；不出假数字。",
        ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="StandCode 派发审计（模式分布 + Gatekeeper 跟进率）")
    ap.add_argument("--days", type=int, default=1, help="回看天数（默认 1 = 昨日至今）")
    ap.add_argument("--since", default=None, help="起始日期 YYYY-MM-DD（覆盖 --days）")
    ap.add_argument("--json", action="store_true", dest="as_json", help="结构化输出")
    ap.add_argument("--threshold", type=float, default=30.0, help="跟进失败率告警阈值%%（默认 30）")
    ap.add_argument("--log", default=None, help="审计日志路径（默认 ~/.standcode/audit.jsonl）")
    ap.add_argument("--hermes-db", default=HERMES_STATE_DB,
                    help="Hermes state.db 路径（真直干率数据源；缺席时如实标注不出假数字）")
    ap.add_argument("--agent-log", default=HERMES_AGENT_LOG,
                    help="gateway agent.log 路径（「时段→当班模型」映射主源）")
    ap.add_argument("--no-hermes", action="store_true", help="跳过 Hermes 侧真直干率")
    ap.add_argument("--alert", action="store_true",
                    help="[cron 用] 直干率/跟进失败率超阈值时推微信；阈内静默（零打扰口径）")
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

    # 真 · 直干率（Hermes 侧）：算成才有 hermes 段并落趋势；算不成如实缺席
    if not args.no_hermes:
        calls = hermes_terminal_commands(args.hermes_db, since, until)
        h = None
        if calls is not None:
            timeline = load_model_timeline(args.agent_log)
            windows = hermes_usage_windows(args.hermes_db)
            h = analyze_hermes_direct(calls, timeline, windows)
        if h:
            a["hermes"] = h
            append_trend(h, until)

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
    h = a.get("hermes")
    follow_breach = bool(g["must_dispatch"] and g["follow_fail_rate"] > args.threshold)
    direct_breach = bool(h and h["terminal_calls"] and h["direct_rate"] > args.threshold)

    # --alert：超阈值才推微信（阈内静默，对齐 api-error 巡检的零打扰口径）
    if args.alert and (follow_breach or direct_breach):
        parts = ["⚠️ StandCode 直干率审计（昨日）"]
        if direct_breach:
            parts.append(f"直干率 {h['direct_rate']}%（{h['direct']}/{h['terminal_calls']} 次 terminal，"
                         f"已剔除制度 {h['institutional']} 条）超阈值 {args.threshold:g}%")
            parts += [f"· {s['model']} {s['direct_rate']}%（直干{s['direct']}/{s['terminal']}）"
                      for s in h.get("by_model", [])[:3]]
            parts += [f"· ×{s['n']} {s['cmd'][:48]}" for s in h["top_direct"][:3]]
        if follow_breach:
            parts.append(f"跟进失败率 {g['follow_fail_rate']}%（判要派 {g['must_dispatch']} 次没派 {g['unfollowed']} 次）")
        parts.append("明细：python3 ~/Code/StandCode/standcode/scripts/audit-direct-work.py")
        send_alert("\n".join(parts))

    return 1 if (follow_breach or direct_breach) else 0


if __name__ == "__main__":
    sys.exit(main())
