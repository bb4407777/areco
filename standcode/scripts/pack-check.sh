#!/bin/bash
# npm 发布门禁（2026-08-02 检查报告 P2-5：npm pack 曾夹带 7 个 registry.json.bak*）。
# prepack 自动跑：包内出现备份/临时文件即拒绝打包。
set -uo pipefail
cd "$(dirname "$0")/.."

# --ignore-scripts 必带：本脚本挂在 prepack 钩子上，内层 npm pack 不跳过脚本会无限递归
bad=$(npm pack --dry-run --ignore-scripts 2>&1 | grep -E '\.(bak|tmp|swp|orig)[.[:alnum:]-]*$' || true)
if [ -n "$bad" ]; then
  echo "✗ 发布包夹带备份/临时文件，拒绝打包：" >&2
  echo "$bad" >&2
  exit 1
fi
echo "✓ pack-check：包内无备份/临时文件"
