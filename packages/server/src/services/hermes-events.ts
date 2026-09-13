// Hermes outbound webhook 事件库（F2·台账#12）：独立 data/hermes-events.db，不塞 messages 房间流——
// webhook 事件高频且无 from/to 对话语义，进 messages 会淹房间并放大房间库 WAL 争用
// （设计依据 ~/.loop-tasks/father-architect/03-webhook观察面-设计说明.md §2.3）。
// append-only 冷数据；delivery_id UNIQUE = 幂等去重键（Hermes 侧 X-Hermes-Delivery 参与 HMAC，兼防重放）。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config'

const DB_PATH = path.join(DATA_DIR, 'hermes-events.db')

const SCHEMA = `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);`

// 进程级共享长连接（同 project-db P2-10 口径）：WAL 下与外部只读方并发安全，随进程存亡
let shared: DatabaseSync | null = null
function open(): DatabaseSync {
  if (shared) return shared
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  // busy_timeout 先设：journal_mode=WAL 本身就可能要拿锁（同 project-db 教训）
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;')
  db.exec(SCHEMA)
  shared = db
  return db
}

export interface HermesEventRow {
  id: number
  deliveryId: string
  event: string
  sessionId: string
  toolName: string | null
  ts: string
  receivedAt: string
  payload: string
}

export interface HermesEventInput {
  deliveryId: string
  event: string
  sessionId?: string
  toolName?: string | null
  /** payload.timestamp（Hermes 侧 UTC）；缺失回退收件时刻 */
  ts?: string
  /** 原始 JSON 全文 */
  payload: string
}

/** 幂等落库：新行返回 true；delivery_id 已存在（重投/重放）返回 false，不产生第二行 */
export function insertEvent(e: HermesEventInput): boolean {
  const db = open()
  const r = db
    .prepare('INSERT OR IGNORE INTO events (delivery_id, event, session_id, tool_name, ts, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.deliveryId, e.event, e.sessionId ?? '', e.toolName ?? null, e.ts ?? new Date().toISOString(), e.payload)
  return Number(r.changes) > 0
}

interface RawRow {
  id: number
  delivery_id: string
  event: string
  session_id: string
  tool_name: string | null
  ts: string
  received_at: string
  payload: string
}

/** 只读查询（GET /api/webhooks/hermes/events）：event 精确匹配；since 与 ts 按 ISO UTC 字符串比较；新→旧 */
export function queryEvents(opts: { event?: string; since?: string; limit?: number } = {}): HermesEventRow[] {
  const db = open()
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), 1000)
  const cond: string[] = []
  const args: (string | number)[] = []
  if (opts.event) {
    cond.push('event = ?')
    args.push(opts.event)
  }
  if (opts.since) {
    cond.push('ts >= ?')
    args.push(opts.since)
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT id, delivery_id, event, session_id, tool_name, ts, received_at, payload FROM events ${where} ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit) as unknown as RawRow[]
  return rows.map((r) => ({
    id: r.id,
    deliveryId: r.delivery_id,
    event: r.event,
    sessionId: r.session_id,
    toolName: r.tool_name,
    ts: r.ts,
    receivedAt: r.received_at,
    payload: r.payload,
  }))
}

/** 行数（单测与 E2E 验证用） */
export function countEvents(): number {
  const row = open().prepare('SELECT COUNT(*) AS n FROM events').get() as unknown as { n: number }
  return Number(row.n)
}
