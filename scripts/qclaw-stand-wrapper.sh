#!/bin/bash
# qclaw-stand-wrapper: 通过 qclaw 脚本调用 openclaw，绕过 PTY 问题
set -e

MODEL="pool-glm-5.2"
TIMEOUT=300

while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

MESSAGE=$(cat)
if [ -z "$MESSAGE" ]; then
  echo "no message" >&2
  exit 1
fi

RESULT=$(/Users/gao/skills/qclaw/qclaw --message "$MESSAGE" --model "$MODEL" --wait --timeout "$TIMEOUT" 2>/dev/null)

REPLY=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reply',''))" 2>/dev/null || echo "")

if [ -n "$REPLY" ]; then
  echo "$REPLY"
else
  echo "$RESULT"
fi
