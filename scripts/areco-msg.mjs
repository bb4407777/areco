#!/usr/bin/env node
// areco 项目消息 CLI：本机终端/agent 回执与插话用，直写 data/projects.db（WAL，与服务端并发安全）。
// 用法：
//   发消息：node scripts/areco-msg.mjs <team> <from> <to> <消息...> [--human-relay]
//     team = 项目 team 名（页面「⇗ 邀请」里可查，形如 room-<id>）
//     from = 发言身份（项目成员名；外部终端可用任意名字，仅作显示）
//     to   = 收件身份（成员名 / all）
//     --human-relay = 转述人类原话标记（仅服务端配置白名单里的 from 生效，如微信通道
//       Hermes 转维护者指令：清零互调链深 + 按人类语义投递；名单外打标无效）
//   查历史：node scripts/areco-msg.mjs <team> history [N]
//     打印该项目最近 N 条消息（默认 20，旧→新）。共享上下文空间的主动查询入口——
//     服务端投递时只附「文件路径 + 近况预览」，想看全量来龙去脉用本子命令自查。
// 零依赖；node ≥ 22.5（node:sqlite）。ARECO_ROOT 可覆盖数据根（多实例/测试）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)`

const rawArgv = process.argv.slice(2)
const humanRelay = rawArgv.includes('--human-relay')
const argv = rawArgv.filter((a) => a !== '--human-relay')
const team = argv[0]
if (!team) {
  console.error('用法: node scripts/areco-msg.mjs <team> <from> <to> <消息...>')
  console.error('      node scripts/areco-msg.mjs <team> history [N]')
  process.exit(1)
}

const root = process.env.ARECO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = resolve(root, 'data')
mkdirSync(dataDir, { recursive: true })
const dbPath = resolve(dataDir, 'projects.db')

// ---- 查历史分支：共享上下文的主动查询入口 ----
if (argv[1] === 'history') {
  const limit = Math.max(1, Number(argv[2]) || 20)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
    db.exec(SCHEMA) // 房间从未发过消息时表可能不存在：建空表兜底防 SELECT 报错
    const rows = db.prepare('SELECT * FROM messages WHERE team=? ORDER BY id DESC LIMIT ?').all(team, limit)
    if (!rows.length) {
      console.log(`（项目 ${team} 暂无消息）`)
    } else {
      for (const r of rows.reverse()) {
        // 升序打印（旧→新），方便通读来龙去脉
        const when = String(r.created_at).replace('T', ' ').replace(/(\d{2}:\d{2}):\d{2}Z$/, '$1Z')
        console.log(`[${when}] ${r.from_agent} → ${r.to_agent}`)
        console.log(`  ${String(r.body).replace(/\s*\r?\n\s*/g, '；')}`)
      }
    }
  } finally {
    db.close()
  }
  process.exit(0)
}

// ---- 发消息分支（原逻辑） ----
const from = argv[1]
const to = argv[2]
const body = argv.slice(3).join(' ').trim()
if (!from || !to || !body) {
  console.error('用法: node scripts/areco-msg.mjs <team> <from> <to> <消息...>')
  console.error('      node scripts/areco-msg.mjs <team> history [N]')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
  db.exec(SCHEMA)
  // 旧库缺 human_relay 列（服务端未升级/未重启过）：就地补列再写，与服务端迁移幂等
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name)
  if (!cols.includes('human_relay')) db.exec('ALTER TABLE messages ADD COLUMN human_relay INTEGER NOT NULL DEFAULT 0')
  db.prepare('INSERT INTO messages (team, from_agent, to_agent, body, human_relay) VALUES (?, ?, ?, ?, ?)').run(team, from, to, body, humanRelay ? 1 : 0)
} finally {
  db.close()
}
console.log(humanRelay ? 'ok (human-relay)' : 'ok')
