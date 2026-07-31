#!/usr/bin/env bash
# StandCode 任务级 worktree 管理(2026-07-31,并发 worker 隔离)
#
# 为什么:同 agent 多 worker 并发写码是常态,共用一棵 agent 树照样互相 reset/merge 抹活。
# 隔离单位 = 任务:每个写码任务一棵一次性 worktree + 同名分支,commit → 合 main → 销毁。
#
# 用法:
#   task-worktree.sh new  <task-id>   建 ~/Code/StandCode-task-<id>(分支 task-<id>,基于 main),
#                                     配好运行态 symlink + node_modules 软链
#   task-worktree.sh land <task-id>   把 task-<id> 合进 main(在 main 树 merge;
#                                     与他人 WIP 冲突会被 git 拒绝——这是保护不是故障),
#                                     成功后提示跑 standcode-deploy.sh,并自动销毁任务树
#   task-worktree.sh drop <task-id>   放弃任务:删树(脏树会被拒)+ 删分支(未合并会被拒)
#   task-worktree.sh list             列出所有任务树
#
# 纪律:任务树里改完先 commit 再 land;node_modules 是主树软链,别在任务树跑 npm install
# (改了 package.json 依赖的任务:删软链再真装)。运维脚本仍只从 StandCode-deploy 树跑。
set -euo pipefail

MAIN=/Users/gao/Code/StandCode
LINKS=(areco/data areco/config.json areco/bin standcode/data \
       standcode/config/harnesses.json standcode/config/providers.json standcode/config/local.json)

die() { echo "❌ $*" >&2; exit 1; }
[ $# -ge 1 ] || die "用法: task-worktree.sh new|land|drop|list <task-id>"

cmd=$1
if [ "$cmd" = list ]; then
  git -C "$MAIN" worktree list | grep 'StandCode-task-' || echo "(无任务树)"
  exit 0
fi

[ $# -eq 2 ] || die "用法: task-worktree.sh $cmd <task-id>"
id=$2
case "$id" in *[!a-zA-Z0-9-]*) die "task-id 只能含字母/数字/连字符";; esac
T=/Users/gao/Code/StandCode-task-$id
B=task-$id

case "$cmd" in
new)
  [ -e "$T" ] && die "$T 已存在(换 id 或先 drop)"
  git -C "$MAIN" worktree add -b "$B" "$T" main
  for p in "${LINKS[@]}"; do ln -s "$MAIN/$p" "$T/$p"; done
  ln -s "$MAIN/areco/node_modules" "$T/areco/node_modules"
  echo "✅ 任务树就绪: $T (分支 $B)"
  echo "   改码 → git commit → $0 land $id"
  ;;
land)
  [ -d "$T" ] || die "$T 不存在"
  git -C "$T" diff --quiet && git -C "$T" diff --cached --quiet \
    || die "任务树有未提交改动——先 commit(未 commit = 没干)"
  git -C "$MAIN" merge --no-edit "$B" \
    || die "合并被 git 拒绝(多半撞上 main 树他人 WIP 同文件)——这是保护;先让对方收走 WIP 或手动解"
  echo "✅ $B 已合进 main:"
  git -C "$MAIN" log --oneline -3
  git -C "$MAIN" worktree remove "$T"
  git -C "$MAIN" branch -d "$B"
  echo "✅ 任务树已销毁。上线请跑: bash ~/scripts/standcode-deploy.sh (只构建不重启)"
  ;;
drop)
  [ -d "$T" ] || die "$T 不存在"
  git -C "$MAIN" worktree remove "$T" \
    || die "任务树有改动,git 拒绝删除;确认要丢就: git -C $MAIN worktree remove --force $T"
  git -C "$MAIN" branch -d "$B" 2>/dev/null \
    || echo "⚠️ 分支 $B 未合并进 main,保留未删(确认丢弃: git -C $MAIN branch -D $B)"
  echo "✅ 已删任务树 $T"
  ;;
*) die "未知命令 $cmd(应 new|land|drop|list)";;
esac
