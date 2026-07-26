#!/bin/bash
# StandCode 镜像同步：areco 主仓 standcode/ 目录 → GitHub bb4407777/standcode（单向）
#
# 2026-07-26 合并决议：StandCode subtree 并入 areco，开发一律在 areco 主仓；
# 独立仓 standcode 保留为自动镜像（npm 包页面/历史外链不断）。
# 本脚本按 HEAD 的 standcode/ 前缀 split 出子历史推镜像——subtree add 保留了
# 原仓全历史，split 结果与镜像仓既有历史连续，正常情况恒可 fast-forward。
# 若镜像仓被人直接推了提交导致非 ff，本脚本失败即为信号：镜像仓不该被直推，
# 到 areco 主仓改。
set -euo pipefail
REPO="${ARECO_REPO:-/Users/gao/Code/areco}"
MIRROR="${STANDCODE_MIRROR:-ssh://git@ssh.github.com:443/bb4407777/standcode.git}"
cd "$REPO"
git subtree push --prefix=standcode "$MIRROR" main
echo "[sync-standcode-mirror] done $(date '+%F %T')"
