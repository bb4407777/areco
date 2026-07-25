#!/usr/bin/env python3
"""qclaw-stand-wrapper: areco 会话专用，从 stdin 读一行消息，调用 qclaw 脚本"""
import json
import subprocess
import sys

# 从 stdin 读一行（areco relay 写入消息后跟换行）
try:
    message = sys.stdin.readline().strip()
except EOFError:
    message = ""
if not message:
    print("no message", file=sys.stderr)
    sys.exit(1)

# 解析命令行参数
model = "pool-glm-5.2"
timeout = 300
args = iter(sys.argv[1:])
for arg in args:
    if arg == "--model":
        model = next(args, model)
    elif arg == "--timeout":
        timeout = int(next(args, timeout))

# 调用 qclaw 脚本
try:
    r = subprocess.run(
        ["/Users/gao/skills/qclaw/qclaw", "--message", message, "--model", model, "--wait", "--timeout", str(timeout)],
        capture_output=True, text=True, timeout=timeout + 30
    )
except subprocess.TimeoutExpired:
    print(f"timeout after {timeout}s", file=sys.stderr)
    sys.exit(1)

if r.returncode != 0:
    print(r.stderr[:500], file=sys.stderr)
    sys.exit(r.returncode)

# 提取 reply
try:
    data = json.loads(r.stdout)
    reply = data.get("reply", "")
    if reply:
        print(reply)
    else:
        print(r.stdout[:1000])
except json.JSONDecodeError:
    print(r.stdout[:1000])
