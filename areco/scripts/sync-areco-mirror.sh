#!/bin/bash
# 每日同步：本地 main →①主仓（GitHub bb4407777/standcode）→②bb4407777/areco 镜像（单向全量）
#
# 2026-07-26 高律师定主从：StandCode 为主、areco 为辅。主仓 = GitHub standcode
# 仓（本地 origin），areco 仓保留为每日全量镜像（历史外链/npm 旧指向不断）。
# 2026-07-26 晚补①：此前只推镜像、主仓无任何自动 push，本地攒 commit 不手动推，
# 次晨即镜像领先主仓（主从倒挂）。现先主后镜像保序，两仓与本地 main 恒等；
# 任一步非 ff 即整体失败告警——主仓被绕过本地直推 / 镜像仓被直推，都回本地解决，勿 force。
set -euo pipefail
REPO="${ARECO_REPO:-/Users/gao/Code/StandCode}"
MIRROR="${ARECO_MIRROR:-ssh://git@ssh.github.com:443/bb4407777/areco.git}"
cd "$REPO"
git push origin main
git push "$MIRROR" main:main
echo "[sync-areco-mirror] done $(date '+%F %T')"
