#!/usr/bin/env node
// 一次性迁移（2026-08-02 高律师定名分库）：把项目房（rooms.json kind=project）的
// messages / message_targets / dispatch / delivery 从 tasks.db 拆到 projects.db。
//
//   node scripts/split-project-db.mjs [--dry-run]
//
// 设计：
// - ATTACH 单连接跨库单事务：插入+删除要么全成要么全不动，中断可直接重跑；
// - INSERT OR IGNORE + 保留原 id：存量 id 来自原单库天然全局唯一，幂等可重跑；
// - projects.db 三张自增表 seed 到 10_000_000（服务端 openFor 同款双保险），
//   未来新增两库 id 永不相撞；
// - 孤儿 team（rooms.json 查无，多为已删任务房遗留）留在 tasks.db，与运行时兜底一致；
// - 跑完后须重启 com.areco（服务端持旧连接/旧代码）。
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = process.env.ARECO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = resolve(root, 'data')
const tasksPath = resolve(dataDir, 'tasks.db')
const projectsPath = resolve(dataDir, 'projects.db')
const roomsPath = resolve(dataDir, 'rooms.json')
const dryRun = process.argv.includes('--dry-run')
const SEED = 10_000_000

if (!existsSync(tasksPath)) {
  console.error(`✗ ${tasksPath} 不存在——没有可拆的源库`)
  process.exit(1)
}
let rooms
try {
  rooms = JSON.parse(readFileSync(roomsPath, 'utf8'))
  if (!Array.isArray(rooms)) throw new Error('rooms.json 不是数组')
} catch (err) {
  console.error(`✗ 读 ${roomsPath} 失败：${err.message}——kind 路由无据，中止`)
  process.exit(1)
}
const projectTeams = rooms.filter((r) => r?.kind === 'project' && r?.team).map((r) => String(r.team))
console.log(`rooms.json：${rooms.length} 房，其中项目房 ${projectTeams.length} 个`)

const db = new DatabaseSync(tasksPath)
db.exec('PRAGMA busy_timeout=5000;')
db.exec(`ATTACH DATABASE '${projectsPath.replace(/'/g, "''")}' AS proj`)

// 目标库建表（与 project-db.ts SCHEMA 同构；直接从源库拷贝建表语句，永不漂移）
for (const row of db
  .prepare("SELECT sql FROM main.sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")
  .all()) {
  const sql = String(row.sql)
    .replace(/CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS proj.')
    .replace(/CREATE INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS proj.')
    .replace(/CREATE UNIQUE INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS proj.')
  db.exec(sql)
}

db.exec('CREATE TEMP TABLE pt (team TEXT PRIMARY KEY)')
const ins = db.prepare('INSERT OR IGNORE INTO pt (team) VALUES (?)')
for (const t of projectTeams) ins.run(t)

const counts = {}
for (const [label, sql] of [
  ['messages', 'SELECT COUNT(*) AS n FROM main.messages m JOIN pt ON pt.team = m.team'],
  ['message_targets', 'SELECT COUNT(*) AS n FROM main.message_targets t JOIN main.messages m ON m.id = t.message_id JOIN pt ON pt.team = m.team'],
  ['dispatch', 'SELECT COUNT(*) AS n FROM main.dispatch d JOIN pt ON pt.team = d.team'],
  ['delivery', 'SELECT COUNT(*) AS n FROM main.delivery x JOIN main.dispatch d ON d.id = x.dispatch_id JOIN pt ON pt.team = d.team'],
]) {
  counts[label] = Number(db.prepare(sql).get().n)
}
console.log('待迁移：', counts)
if (dryRun) {
  console.log('（--dry-run：未做任何改动）')
  process.exit(0)
}

db.exec('BEGIN')
try {
  db.exec(`INSERT OR IGNORE INTO proj.messages SELECT m.* FROM main.messages m JOIN pt ON pt.team = m.team;
INSERT OR IGNORE INTO proj.message_targets SELECT t.* FROM main.message_targets t JOIN main.messages m ON m.id = t.message_id JOIN pt ON pt.team = m.team;
INSERT OR IGNORE INTO proj.dispatch SELECT d.* FROM main.dispatch d JOIN pt ON pt.team = d.team;
INSERT OR IGNORE INTO proj.delivery SELECT x.* FROM main.delivery x JOIN main.dispatch d ON d.id = x.dispatch_id JOIN pt ON pt.team = d.team;
DELETE FROM main.delivery WHERE dispatch_id IN (SELECT d.id FROM main.dispatch d JOIN pt ON pt.team = d.team);
DELETE FROM main.dispatch WHERE team IN (SELECT team FROM pt);
DELETE FROM main.message_targets WHERE message_id IN (SELECT m.id FROM main.messages m JOIN pt ON pt.team = m.team);
DELETE FROM main.messages WHERE team IN (SELECT team FROM pt);`)
  // projects.db 自增起点 seed（幂等：已有更高水位不动）
  for (const table of ['messages', 'dispatch', 'delivery']) {
    const row = db.prepare('SELECT seq FROM proj.sqlite_sequence WHERE name = ?').get(table)
    if (!row) db.prepare('INSERT INTO proj.sqlite_sequence (name, seq) VALUES (?, ?)').run(table, SEED)
    else if (Number(row.seq) < SEED) db.prepare('UPDATE proj.sqlite_sequence SET seq = ? WHERE name = ?').run(SEED, table)
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error(`✗ 迁移失败已回滚：${err.message}`)
  process.exit(1)
}

const after = {
  tasksMessages: Number(db.prepare('SELECT COUNT(*) AS n FROM main.messages').get().n),
  projMessages: Number(db.prepare('SELECT COUNT(*) AS n FROM proj.messages').get().n),
  projDispatch: Number(db.prepare('SELECT COUNT(*) AS n FROM proj.dispatch').get().n),
}
console.log(`✅ 迁移完成：projects.db messages=${after.projMessages} dispatch=${after.projDispatch}；tasks.db 剩 messages=${after.tasksMessages}`)
console.log('▶ 生效需重启 com.areco（在普通终端、非 areco 会话内执行）：launchctl kickstart -k gui/$(id -u)/com.areco')
