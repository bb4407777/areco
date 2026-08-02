#!/bin/bash
# 消息库每日备份（2026-08-02 分库后配套；此前数据库是零备份单点——claude-code-backup
# 只备 ~/.claude 系，git-backup 只管代码仓，两库坏盘即失）。
#
#   bash scripts/backup-msg-dbs.sh          # 备份 tasks.db + projects.db 并轮转
#
# sqlite3 .backup 在线安全备份（不锁库、与 WAL 并发安全）；落 ~/.backups/areco-db/，
# 每库保留最近 7 份。挂 cc-connect cron 每日执行由高律师定（本脚本幂等，随时手跑）。
set -euo pipefail

DATA_DIR="${ARECO_DATA_DIR:-/Users/gao/Code/StandCode-deploy/areco/data}"
DEST="${ARECO_DB_BACKUP_DIR:-/Users/gao/.backups/areco-db}"
KEEP=7
STAMP=$(date +%Y%m%d-%H%M)

mkdir -p "$DEST"
for name in tasks projects; do
  src="$DATA_DIR/$name.db"
  [ -f "$src" ] || { echo "skip: $src 不存在"; continue; }
  out="$DEST/$name.db.snap-$STAMP"
  sqlite3 "$src" ".backup '$out'"
  ok=$(sqlite3 "$out" "PRAGMA quick_check;" 2>/dev/null || echo bad)
  if [ "$ok" != "ok" ]; then
    echo "✗ $name 备份完整性校验失败（$ok），保留现场 $out" >&2
    exit 1
  fi
  echo "✓ $name.db → $out ($(du -h "$out" | cut -f1 | tr -d ' '))"
  # 轮转：该库快照只留最近 KEEP 份
  ls -t "$DEST/$name.db.snap-"* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs rm -f 2>/dev/null || true
done
