#!/bin/bash
# areco 镜像同步：monorepo 主仓（GitHub bb4407777/standcode）→ bb4407777/areco（单向全量）
#
# 2026-07-26 高律师定主从：StandCode 为主、areco 为辅。主仓 = GitHub standcode
# 仓（本地 origin），areco 仓保留为每日全量镜像（历史外链/npm 旧指向不断）。
# 全量 push 本地 main——两仓内容恒等，非 ff 即为信号：镜像仓不该被直推，到主仓改。
set -euo pipefail
REPO="${ARECO_REPO:-/Users/gao/Code/areco}"
MIRROR="${ARECO_MIRROR:-ssh://git@ssh.github.com:443/bb4407777/areco.git}"
cd "$REPO"
git push "$MIRROR" main:main
echo "[sync-areco-mirror] done $(date '+%F %T')"
