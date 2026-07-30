#!/usr/bin/env python3
"""hermes-profile-sync — 多通道配置同步：主 Hermes → profiles/*（2026-07-26，Fable5）

背景：第二微信通道(profiles/second)上线后,共享层(章程 workspace/skills-router/
统一记忆中台/caller 脚本)天然同步,但四个**按 HOME 落盘的文件**是各自副本——
副本必漂移(2026-07-16 skills 软链教训)。本脚本把"主通道升级"单向镜像到全部 profile:

  SOUL.md / agent.json   → 逐字节镜像(两通道同一人格同一守则)
  config.yaml            → 解析级镜像:主配置为底,保留各 profile 的应然差异
                           (platforms.api_server.port、onboarding、_config_version,
                            以及 .sync-preserve.json 里声明的自定义键)
  .env / memory_store.db → 永不碰(凭证按通道独立;用户档案允许各自生长)

有变更 → kickstart 该 profile 的 launchd 服务(ai.hermes.gateway.<profile>)使之生效;
主通道永远只读不写不重启(它是源)。幂等:无差异时零动作零重启。

用法：hermes-profile-sync.py [--dry-run]
"""

import copy
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

BASE = Path(__file__).resolve().parent.parent  # ~/.qclaw-hermes
PROFILES = BASE / "profiles"
MIRROR_FILES = ["SOUL.md", "agent.json"]
# 解析级保留键（dot-path）：这些键保留 profile 自己的值，其余全部以主配置为准
PRESERVE_PATHS = ["platforms.api_server.port", "onboarding", "_config_version"]


def _get(d, dot):
    cur = d
    for k in dot.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return None, False
        cur = cur[k]
    return cur, True


def _set(d, dot, value):
    ks = dot.split(".")
    cur = d
    for k in ks[:-1]:
        cur = cur.setdefault(k, {})
    cur[ks[-1]] = value


def sync_profile(prof: Path, dry: bool) -> list[str]:
    changed = []
    # 1) 逐字节镜像文件
    for name in MIRROR_FILES:
        src, dst = BASE / name, prof / name
        if not src.exists():
            continue
        if not dst.exists() or src.read_bytes() != dst.read_bytes():
            changed.append(name)
            if not dry:
                shutil.copy2(src, dst)
    # 2) config.yaml 解析级镜像
    src_cfg = yaml.safe_load((BASE / "config.yaml").read_text()) or {}
    dst_path = prof / "config.yaml"
    dst_cfg = yaml.safe_load(dst_path.read_text()) if dst_path.exists() else {}
    preserve = list(PRESERVE_PATHS)
    extra = prof / ".sync-preserve.json"
    if extra.exists():
        try:
            preserve += [str(p) for p in json.loads(extra.read_text())]
        except Exception:
            print(f"[warn] {extra} 解析失败，忽略自定义保留键", file=sys.stderr)
    merged = copy.deepcopy(src_cfg)
    for dot in preserve:
        val, found = _get(dst_cfg or {}, dot)
        if found:
            _set(merged, dot, val)
    if merged != (dst_cfg or {}):
        changed.append("config.yaml")
        if not dry:
            dst_path.write_text(yaml.safe_dump(merged, allow_unicode=True, sort_keys=False))
    return changed


def _profile_busy(prof: Path) -> str:
    """通道忙闲判定——忙则不重启（重启会连坐杀掉 gateway 的 go/ask 等待者子进程，
    在途任务 inbox 落空只能靠 reconcile 迟到补收）。--force 跳过本检查。

    两路信号:①gateway_state.active_agents>0(正在对话);②standcode state 文件里
    status=running 且 channel=本 profile 且 pid 活着(在途等待者)。"""
    try:
        st = json.loads((prof / "gateway_state.json").read_text())
        if int(st.get("active_agents") or 0) > 0:
            return f"active_agents={st.get('active_agents')}"
    except Exception:
        pass
    # 与 caller.py TASKS_DIR 同源（$HOME/.standcode/tasks；曾误写 standcode/data/tasks
    # 致本检查永远空转——路径硬编码必须对源核对）
    tasks_dir = Path(os.environ.get("STANDCODE_TASKS_DIR") or "/Users/gao/.standcode/tasks")
    if tasks_dir.is_dir():
        for f in tasks_dir.glob("*.json"):
            try:
                t = json.loads(f.read_text())
            except Exception:
                continue
            if t.get("status") != "running" or (t.get("channel") or "main") != prof.name:
                continue
            pid = t.get("pid")
            try:
                if pid:
                    os.kill(int(pid), 0)
                    return f"在途等待者 {t.get('task_id')}(pid {pid})"
            except (OSError, ValueError):
                continue
    return ""


def main() -> int:
    dry = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    if not PROFILES.is_dir():
        print("无 profiles 目录，无事可做")
        return 0
    any_changed = False
    for prof in sorted(PROFILES.iterdir()):
        if not (prof / "config.yaml").exists():
            continue
        changed = sync_profile(prof, dry)
        if not changed:
            print(f"{prof.name}: 已同步（无差异）")
            continue
        any_changed = True
        print(f"{prof.name}: {'将' if dry else '已'}更新 {', '.join(changed)}")
        if not dry:
            busy = "" if force else _profile_busy(prof)
            if busy:
                print(f"{prof.name}: 文件已同步,通道忙({busy})暂不重启——"
                      f"新配置待下次重启生效(每日 04:45 cron 或手动 --force)")
                continue
            label = f"ai.hermes.gateway.{prof.name}"
            r = subprocess.run(["launchctl", "kickstart", "-k", f"gui/501/{label}"],
                               capture_output=True, text=True)
            print(f"{prof.name}: kickstart {label} → {'ok' if r.returncode == 0 else (r.stderr or '').strip()[:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
