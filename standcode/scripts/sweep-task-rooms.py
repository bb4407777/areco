#!/usr/bin/env python3
"""StandCode 任务房清扫器：做完的任务房自动删除，不留堆积（2026-07-26 高律师指示）。

规则（与 caller.py AUTO_ARCHIVE 收口配合，形成「完成→归档→删除」流水）：
- 只删「已归档 且 任务房命名」的房间：名字以 ⚙ 开头（含暖池过期的 ⚙待命·*），
  或 Stand-worker-* / Stand-thinker-* 前缀。讨论房/案件房不匹配命名，永不误删。
- stuck / lost / timeout 的任务房不会被 caller 归档 → 本脚本不碰（留给 reconcile
  补收与人工取证）；等 reconcile 收口归档后，下轮自然清掉。
- 房间 DELETE 级联删除房内专属会话（服务端 2026-07-22 语义），任务结果早在
  ~/.standcode/tasks/<task>.json 里，删房不丢结果。
- 顺手清 tasks 目录：终态（completed/timeout/dead/lost/error/stall）且 mtime
  超过 KEEP_DAYS 的 state/log 用 /usr/bin/trash 进回收站（章程禁 rm 直删）。
- 审计：每个动作追加 ~/.standcode/sweep-task-rooms.jsonl 一行。
- 跑法：sweep-task-rooms.py [--dry-run]；cron 走 cc-connect exec 型（最小 env，
  故 HOME/路径全部显式，不依赖 shell 环境）。
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("STANDCODE_ARECO_BASE", "http://127.0.0.1:8790")
HOME = "/Users/gao"
TASKS_DIR = Path(os.environ.get("STANDCODE_TASKS_DIR", f"{HOME}/.standcode/tasks"))
AUDIT = Path(f"{HOME}/.standcode/sweep-task-rooms.jsonl")
TRASH = "/usr/bin/trash"
KEEP_DAYS = 7
TERMINAL = {"completed", "timeout", "dead", "lost", "error", "stall"}
TASK_ROOM_RE = re.compile(r"^(⚙|Stand-(worker|thinker)-)")


def api(method: str, path: str):
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def audit(event: str, **kw) -> None:
    row = {"ts": datetime.datetime.now().astimezone().isoformat(), "event": event, **kw}
    AUDIT.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def sweep_rooms(dry: bool) -> int:
    rooms = api("GET", "/api/rooms")["data"]["rooms"]
    picks = [r for r in rooms if r.get("archivedAt") and TASK_ROOM_RE.match(r["name"] or "")]
    for r in picks:
        if dry:
            print(f"[dry] room {r['id']} {r['name'][:50]}")
            continue
        try:
            out = api("DELETE", f"/api/rooms/{r['id']}")
            removed = out.get("data", {}).get("removedSessions", [])
            audit("room_deleted", room=r["id"], name=r["name"], cascade_sessions=removed)
            print(f"deleted room {r['id']} {r['name'][:50]} (+{len(removed)} sessions)")
        except (urllib.error.URLError, OSError, ValueError) as e:
            audit("room_delete_failed", room=r["id"], error=str(e))
            print(f"FAIL room {r['id']}: {e}", file=sys.stderr)
    return len(picks)


def sweep_states(dry: bool) -> int:
    if not TASKS_DIR.exists():
        return 0
    cutoff = datetime.datetime.now().timestamp() - KEEP_DAYS * 86400
    doomed: list[Path] = []
    for f in TASKS_DIR.glob("*.json"):
        try:
            if f.stat().st_mtime > cutoff:
                continue
            if json.loads(f.read_text(encoding="utf-8")).get("status") not in TERMINAL:
                continue
        except (OSError, ValueError):
            continue  # 读不了/坏文件不动，留人工
        doomed.append(f)
        log = f.with_suffix(".log")
        if log.exists():
            doomed.append(log)
    if doomed and not dry:
        subprocess.run([TRASH, *[str(p) for p in doomed]], check=False)
        audit("states_trashed", count=len(doomed), files=[p.name for p in doomed])
    for p in doomed:
        print(f"{'[dry] ' if dry else ''}trash {p.name}")
    return len(doomed)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    try:
        n_rooms = sweep_rooms(args.dry_run)
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"areco API 不可达，跳过本轮: {e}", file=sys.stderr)
        return 1
    n_states = sweep_states(args.dry_run)
    if n_rooms or n_states:
        print(f"done: rooms={n_rooms} state_files={n_states}{' (dry-run)' if args.dry_run else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
