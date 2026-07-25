#!/bin/bash
# openclaw-stand-wrapper: areco 会话专用 wrapper
set -e

MODEL=""
TIMEOUT=600
AGENT="main"

# 解析简单参数（剩余当 stdin 处理，不解析位置参数）
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

MESSAGE=$(cat)
if [ -z "$MESSAGE" ]; then
  echo '{"error":"no message"}' >&2
  exit 1
fi

export HOME="${HOME:-$(cd ~ && pwd)}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.qclaw}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.qclaw/openclaw.json}"

NODE=/Applications/QClaw.app/Contents/Resources/node/node
MJS="${OPENCLAW_MJS:-$HOME/Library/Application Support/QClaw/openclaw/node_modules/openclaw/openclaw.mjs}"

exec "$NODE" "$MJS" agent --agent "$AGENT" --json --message "$MESSAGE" --timeout "$TIMEOUT" ${MODEL:+--model "$MODEL"}
