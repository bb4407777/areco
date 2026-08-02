#!/bin/bash
# 每天凌晨切 Hermes 主网关到 qclaw 积分池(积分次日回血,白天池耗尽切 zhipu 后夜里自动切回)。
# 探针失败(如 QClaw App 未运行)自动回退 zhipu,避免醒来微信通道挂死。
# 2026-07-23 管理者指示建立;由 cc-connect cron 调度(jobs.json),会话外执行合规。
set -u
PY=/opt/homebrew/bin/python3.13
SWITCH=/Users/gao/.qclaw-hermes/bin/hermes-switch-model.py
LOG=/Users/gao/.qclaw-hermes/logs/nightly-switch.log
ts() { date '+%F %T'; }

echo "[$(ts)] switch → qclaw" >> "$LOG"
"$PY" "$SWITCH" qclaw >> "$LOG" 2>&1
sleep 20

out=$(HOME=/Users/gao HERMES_HOME=/Users/gao/.qclaw-hermes "$PY" -m hermes_cli.main -z "只回复ok" --cli 2>> "$LOG")
if [ -n "$out" ]; then
  echo "[$(ts)] probe ok: ${out:0:40} (qclaw 生效)" >> "$LOG"
else
  echo "[$(ts)] probe FAILED → revert zhipu" >> "$LOG"
  "$PY" "$SWITCH" zhipu >> "$LOG" 2>&1
fi
