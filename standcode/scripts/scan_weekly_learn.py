#!/usr/bin/env python3
"""scan_weekly_learn.py — 主动学习·每周采矿（2026-07-29 高律师令「agent 要学会主动学习」③，Kimi 施工）

每周日晚由 cc-connect cron 触发，扫两个数据源本周（周一 00:00 起）的记录：
  1. StandCode inbox 本周 .done 结果（/Users/gao/Code/StandCode/standcode/data/inbox/*.json.done）
  2. 功过格本周行（飞书案件管理 Base「功过格YYYY年M月」表，本周日期列全部单元格）

用规则提炼「高频坑 / 高频工具问题 / 新事实候选 / 打回复盘」，生成候选 lesson 清单落
  /tmp/weekly_learn_YYYYMMDD.md
供高律师过目后人工 promote（add_memory.py）。

红线：机器只候选、绝不自动入库——防垃圾沉淀。脚本不写 memory.db、不改任何业务数据。
"""
from __future__ import annotations

import collections
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys

HOME = "/Users/gao"
INBOX_DIR = "/Users/gao/Code/StandCode/standcode/data/inbox"
BASE_TOKEN = "Nv6EbJAJIaOi4YsgdczcdDz1nte"

# 坑信号词：行里命中即视为一条「踩坑/教训」候选
PIT_WORDS = (
    "踩坑", "坑", "报错", "失败", "超时", "兜底", "打回", "被拒", "教训", "卡住",
    "重试", "返工", "漏", "错把", "误判", "不要用", "禁用", "别用", "忘了", "踩到",
)
# 新事实信号词
FACT_WORDS = ("发现", "原来", "实际", "其实是", "新事实", "真相", "并非", "纠正")
# 工具名（高频工具问题统计用；命中坑行里的工具名归因）
TOOL_WORDS = (
    "agent-reach", "opencli", "lark-cli", "bilinote", "mediacrawler", "cc-send",
    "recall.py", "add_memory.py", "gongguoge-log.py", "pdftotext", "ocr-vision",
    "court-doc-verify.py", "hermes", "workbuddy", "codebuddy", "areco", "caller.py",
)


def week_bounds(today: datetime.date) -> tuple[datetime.date, datetime.date]:
    monday = today - datetime.timedelta(days=today.weekday())
    return monday, today


def parse_iso(ts: str) -> datetime.datetime | None:
    try:
        return datetime.datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize(line: str) -> str:
    """去日期/路径/数字/空白差异，供同类坑聚合计数。"""
    s = re.sub(r"https?://\S+", "<url>", line)
    s = re.sub(r"/[\w./\-]+", "<path>", s)
    s = re.sub(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2})?)?", "<date>", s)
    s = re.sub(r"\d+", "<n>", s)
    return re.sub(r"\s+", "", s)[:120]


def scan_inbox(monday: datetime.date, today: datetime.date) -> list[dict]:
    """本周 inbox .done → [{source, summary, pits[], facts[], bounced, stand}]"""
    items: list[dict] = []
    for fp in sorted(glob.glob(os.path.join(INBOX_DIR, "*.json.done"))):
        try:
            d = json.load(open(fp, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        ts = parse_iso(d.get("inbox_created_at") or "")
        if not ts or not (monday <= ts.date() <= today):
            continue
        text = d.get("result_text") or ""
        pits, facts = [], []
        for raw in re.split(r"[\n。；;]", text):
            line = raw.strip().strip("-·*• ")
            if len(line) < 8:
                continue
            # 纯标记行（「──【…】──」打回分隔符、孤立的「【标题】」行）不是坑，防假高频
            if line.startswith("──") or re.fullmatch(r"【[^】]*】[·。]?", line):
                continue
            if any(w in line for w in PIT_WORDS):
                pits.append(line[:200])
            elif any(w in line for w in FACT_WORDS):
                facts.append(line[:200])
        ver = d.get("verification") or {}
        bounced = bool(ver.get("bounced")) or int(ver.get("attempts") or 1) > 1
        items.append({
            "source": os.path.basename(fp),
            "stand": d.get("stand") or "?",
            "summary": (d.get("request_summary") or "")[:80],
            "pits": pits, "facts": facts, "bounced": bounced,
        })
    return items


def lark_cli() -> str | None:
    for cand in (shutil.which("lark-cli"),
                 os.path.join(HOME, ".npm-global/bin/lark-cli")):
        if cand and os.path.exists(cand):
            return cand
    return None


def lark(bin_path: str, *args: str) -> dict:
    env = {**os.environ, "HOME": HOME,
           "PATH": os.path.dirname(bin_path) + ":" + os.environ.get("PATH", "")}
    r = subprocess.run([bin_path, *args, "--as", "user", "--format", "json"],
                       capture_output=True, text=True, env=env, timeout=90)
    out = json.loads(r.stdout or "{}")
    if not out.get("ok"):
        raise RuntimeError(json.dumps(out.get("error"), ensure_ascii=False)[:200])
    return out


def cell_text(v) -> str:
    if isinstance(v, list):
        return "".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in v)
    if isinstance(v, dict):
        return v.get("text", "")
    return v or ""


def scan_gongguoge(monday: datetime.date, today: datetime.date) -> tuple[list[str], str]:
    """本周功过格全部单元格行 → (行列表, 备注)。跨月自动补上月表；失败不致命。"""
    bin_path = lark_cli()
    if not bin_path:
        return [], "未找到 lark-cli，功过格部分跳过"
    months = {(today.year, today.month)}
    if monday.month != today.month:
        months.add((monday.year, monday.month))
    week_cols = {(monday + datetime.timedelta(days=i)).isoformat()
                 for i in range((today - monday).days + 1)}
    lines: list[str] = []
    notes: list[str] = []
    try:
        tables = lark(bin_path, "base", "+table-list", "--base-token", BASE_TOKEN)["data"]["tables"]
    except Exception as e:  # noqa: BLE001 —— cron 场景失败只记不炸
        return [], f"功过格拉取失败（table-list）: {e}"
    for (y, m) in sorted(months):
        name = f"功过格{y}年{m}月"
        tid = next((t["id"] for t in tables if t["name"] == name), None)
        if not tid:
            notes.append(f"缺表「{name}」")
            continue
        try:
            out = lark(bin_path, "base", "+record-list", "--base-token", BASE_TOKEN,
                       "--table-id", tid)
            dd = out["data"]
            rows, cols = dd.get("data") or [], dd.get("fields") or []
        except Exception as e:  # noqa: BLE001
            notes.append(f"「{name}」读取失败: {e}")
            continue
        for row in rows:
            case_no = cell_text(row[cols.index("律所案号")]) if "律所案号" in cols else "?"
            for col in week_cols:
                if col not in cols:
                    continue
                cell = cell_text(row[cols.index(col)])
                for ln in cell.splitlines():
                    ln = ln.strip()
                    if ln:
                        lines.append(f"[{case_no}·{col}] {ln}")
    return lines, "；".join(notes)


def aggregate(items: list[dict], ggg_lines: list[str]) -> dict:
    pit_counter: dict[str, dict] = {}
    tool_counter: collections.Counter = collections.Counter()
    fact_cands: list[dict] = []
    bounced: list[dict] = []

    def add_pit(line: str, src: str) -> None:
        key = normalize(line)
        e = pit_counter.setdefault(key, {"line": line, "count": 0, "srcs": set()})
        e["count"] += 1
        e["srcs"].add(src)
        for t in TOOL_WORDS:
            if t in line:
                tool_counter[t] += 1

    for it in items:
        for p in it["pits"]:
            add_pit(p, f"inbox:{it['source']}")
        for f in it["facts"]:
            fact_cands.append({"line": f, "src": f"inbox:{it['source']}"})
        if it["bounced"]:
            bounced.append({"summary": it["summary"], "stand": it["stand"], "src": it["source"]})
    for ln in ggg_lines:
        if any(w in ln for w in PIT_WORDS):
            add_pit(ln, "功过格")
        elif any(w in ln for w in FACT_WORDS):
            fact_cands.append({"line": ln, "src": "功过格"})

    pits = sorted(pit_counter.values(), key=lambda e: -e["count"])
    return {"pits": pits, "tools": tool_counter.most_common(),
            "facts": fact_cands, "bounced": bounced}


def render(today: datetime.date, monday: datetime.date, items: list[dict],
           ggg_lines: list[str], ggg_note: str, agg: dict) -> str:
    n_cand = sum(1 for p in agg["pits"] if p["count"] >= 2)
    out = [
        f"# 每周学习采矿 {today.isoformat()}（{monday.isoformat()} ~ {today.isoformat()}）",
        "",
        "机器只候选、不自动入库。高律师过目后，挑有货的用下面命令 promote：",
        "```",
        'python3 /Users/gao/skills/memory/scripts/add_memory.py --kind lesson \\',
        '  --claim "<结论>" --evidence "<依据>" --source "weekly_learn:' + today.isoformat() + '"',
        "```",
        "",
        f"- inbox 本周 .done：{len(items)} 单（打回 {len(agg['bounced'])} 单）",
        f"- 功过格本周行：{len(ggg_lines)} 行" + (f"（{ggg_note}）" if ggg_note else ""),
        "",
        "## 高频坑（≥2 次，候选 kind=lesson）",
    ]
    freq = [p for p in agg["pits"] if p["count"] >= 2]
    out += [f"- ×{p['count']} {p['line']}（出处：{'、'.join(sorted(p['srcs'])[:3])}）"
            for p in freq] or ["- 无"]
    out += ["", "## 单次坑（候选，酌选）"]
    out += [f"- {p['line']}（出处：{next(iter(p['srcs']))}）"
            for p in agg["pits"] if p["count"] < 2] or ["- 无"]
    out += ["", "## 高频工具问题（坑行归因，候选 kind=tooling）"]
    out += [f"- {t} ×{c}" for t, c in agg["tools"]] or ["- 无"]
    out += ["", "## 新事实候选（候选 kind=fact）"]
    out += [f"- {f['line']}（出处：{f['src']}）" for f in agg["facts"]] or ["- 无"]
    out += ["", "## 打回复盘（验收闸 bounced / attempts>1）"]
    out += [f"- [{b['stand']}] {b['summary']}（{b['src']}）" for b in agg["bounced"]] or ["- 无"]
    out += ["", f"合计候选：高频坑 {n_cand} 条；全部坑 {len(agg['pits'])} 条；"
                f"事实 {len(agg['facts'])} 条。", ""]
    return "\n".join(out)


def main() -> None:
    today = datetime.date.today()
    monday, today = week_bounds(today)
    items = scan_inbox(monday, today)
    ggg_lines, ggg_note = scan_gongguoge(monday, today)
    agg = aggregate(items, ggg_lines)
    md = render(today, monday, items, ggg_lines, ggg_note, agg)
    out_path = f"/tmp/weekly_learn_{today.strftime('%Y%m%d')}.md"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    n = sum(1 for p in agg["pits"] if p["count"] >= 2)
    # stdout 只出一行摘要：cron 非静默推送时微信收到的就是这行，详情在 md。
    print(f"weekly_learn {today.isoformat()}: inbox {len(items)} 单 / 功过格 {len(ggg_lines)} 行 "
          f"/ 高频坑候选 {n} 条 → {out_path}")


if __name__ == "__main__":
    sys.exit(main())
