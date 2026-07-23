// 项目消息库：data/projects.db（node:sqlite，WAL）。项目协作的消息 SoT，零外部依赖。
// 服务端 room-relay 读写；本机任何终端可用 scripts/areco-msg.mjs 直写本库回执——
// WAL + busy_timeout 保证与服务端并发安全，relay 的 2s 游标轮询自然拾取。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config'

const DB_PATH = path.join(DATA_DIR, 'projects.db')

export interface ProjectMessageRow {
  id: number
  team: string
  from: string
  to: string
  body: string
  createdAt: string
  /** 转述维护者原话的标记（署名仍是 agent 自己）；服务端只对白名单转述者按人类语义处理 */
  humanRelay: boolean
}

export const SCHEMA = `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  human_relay INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_team_history ON messages(team, id);
-- 房间调度底账（确定性房间调度，2026-07-22）：消息可见性与行动许可拆开。
-- message_targets 记录每条消息的真实收件人集合（广播也展开成成员名逐行落），
-- 替代单一 to_agent 的审计盲区；messages.to_agent 保留不动，兼容旧数据与 areco-msg CLI。
CREATE TABLE IF NOT EXISTS message_targets (
  message_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  UNIQUE(message_id, target_name)
);
-- dispatch：一次投递任务（以触发它的根消息为幂等键，重复建单返回既有行）。
-- claim 模式（认领制）新增列：phase（claiming→implementing→done）、implementer（赢家成员名）、
-- claim_deadline（认领截止）、worktree_path/branch（赢家获批时自动开的 git 工作区）。
CREATE TABLE IF NOT EXISTS dispatch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  root_message_id INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('parallel', 'serial', 'claim')),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'done', 'cancelled')),
  current_target TEXT,
  deadline TEXT,
  max_depth INTEGER NOT NULL DEFAULT 3,
  cancel_reason TEXT,
  phase TEXT CHECK(phase IN ('claiming', 'implementing', 'done')),
  implementer TEXT,
  claim_deadline TEXT,
  worktree_path TEXT,
  branch TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(team, root_message_id)
);
-- delivery：dispatch 下每个目标成员一行的投递状态机；UNIQUE(dispatch_id, member_name) 防重。
CREATE TABLE IF NOT EXISTS delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL,
  member_name TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'injected', 'working', 'replied', 'done', 'timeout', 'cancelled', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(dispatch_id, member_name)
);`

// 每请求短连接：流量个位数/分钟，不与 CLI 侧长期抢 WAL
function open(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
  db.exec(SCHEMA)
  migrateMessages(db)
  migrateDispatch(db)
  return db
}

/**
 * 宽容迁移：CREATE TABLE IF NOT EXISTS 不会改既有表。claim 模式上线前的开发库可能已建了
 * 旧版 dispatch 表（CHECK 不含 'claim'、缺 phase/implementer 等新列）——SQLite 改不了 CHECK，
 * 只能整表重建；缺列则 ALTER TABLE ADD COLUMN。生产库上线前从未建过该表，走不到这里。
 */
/** messages 表增量列迁移：既有生产库缺 human_relay（2026-07-23 转述标记）则补 */
function migrateMessages(db: DatabaseSync): void {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as
    | { sql: string }
    | undefined
  if (!master) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
  )
  if (!cols.has('human_relay')) db.exec('ALTER TABLE messages ADD COLUMN human_relay INTEGER NOT NULL DEFAULT 0')
}

function migrateDispatch(db: DatabaseSync): void {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dispatch'").get() as
    | { sql: string }
    | undefined
  if (!master) return
  if (!master.sql.includes("'claim'")) {
    db.exec(`BEGIN;
      ALTER TABLE dispatch RENAME TO dispatch_old;
      CREATE TABLE dispatch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team TEXT NOT NULL,
        root_message_id INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('parallel', 'serial', 'claim')),
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'done', 'cancelled')),
        current_target TEXT,
        deadline TEXT,
        max_depth INTEGER NOT NULL DEFAULT 3,
        cancel_reason TEXT,
        phase TEXT CHECK(phase IN ('claiming', 'implementing', 'done')),
        implementer TEXT,
        claim_deadline TEXT,
        worktree_path TEXT,
        branch TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(team, root_message_id)
      );
      INSERT INTO dispatch (id, team, root_message_id, mode, state, current_target, deadline, max_depth, cancel_reason, created_at, updated_at)
        SELECT id, team, root_message_id, mode, state, current_target, deadline, max_depth, cancel_reason, created_at, updated_at FROM dispatch_old;
      DROP TABLE dispatch_old;
    COMMIT;`)
    return
  }
  // 表已是 claim 版但缺列的半成品（理论上不出现，防御性补齐）
  const cols = new Set(
    (db.prepare('PRAGMA table_info(dispatch)').all() as { name: string }[]).map((c) => c.name)
  )
  const add: Record<string, string> = {
    phase: "ALTER TABLE dispatch ADD COLUMN phase TEXT CHECK(phase IN ('claiming', 'implementing', 'done'))",
    implementer: 'ALTER TABLE dispatch ADD COLUMN implementer TEXT',
    claim_deadline: 'ALTER TABLE dispatch ADD COLUMN claim_deadline TEXT',
    worktree_path: 'ALTER TABLE dispatch ADD COLUMN worktree_path TEXT',
    branch: 'ALTER TABLE dispatch ADD COLUMN branch TEXT',
  }
  for (const [col, sql] of Object.entries(add)) if (!cols.has(col)) db.exec(sql)
}

function rowToMessage(r: Record<string, unknown>): ProjectMessageRow {
  return {
    id: Number(r.id),
    team: String(r.team),
    from: String(r.from_agent),
    to: String(r.to_agent),
    body: String(r.body),
    createdAt: String(r.created_at),
    humanRelay: Number(r.human_relay ?? 0) === 1,
  }
}

export function send(
  team: string,
  from: string,
  to: string,
  body: string,
  opts?: { humanRelay?: boolean }
): ProjectMessageRow {
  if (!team || !from || !to || !body.trim()) throw new Error('team/from/to/body 不能为空')
  const db = open()
  try {
    const res = db
      .prepare('INSERT INTO messages (team, from_agent, to_agent, body, human_relay) VALUES (?, ?, ?, ?, ?)')
      .run(team, from, to, body, opts?.humanRelay ? 1 : 0)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(res.lastInsertRowid as number)
    return rowToMessage(row as Record<string, unknown>)
  } finally {
    db.close()
  }
}

/** 消息流：按 team 拉最近 limit 条，升序返回 */
export function history(team: string, limit = 100): ProjectMessageRow[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db.prepare('SELECT * FROM messages WHERE team=? ORDER BY id DESC LIMIT ?').all(team, limit)
    return (rows as Record<string, unknown>[]).map(rowToMessage).reverse()
  } finally {
    db.close()
  }
}

/** 跨所有项目房间搜消息正文（LIKE，% _ \ 转义防通配符误判），按 id 倒序返回 limit 条 */
export function search(q: string, limit = 50): ProjectMessageRow[] {
  const needle = q.trim()
  if (!needle || !fs.existsSync(DB_PATH)) return []
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`)
  const db = open()
  try {
    const rows = db
      .prepare("SELECT * FROM messages WHERE body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?")
      .all(`%${escaped}%`, limit)
    return (rows as Record<string, unknown>[]).map(rowToMessage)
  } finally {
    db.close()
  }
}

/** 各 team 最后一条消息时间（房间列表按最近回复排序用）；无消息的 team 缺席。created_at 为 ISO 文本，MAX 词典序即最新 */
export function lastMessageAts(): Record<string, string> {
  if (!fs.existsSync(DB_PATH)) return {}
  const db = open()
  try {
    const rows = db.prepare('SELECT team, MAX(created_at) AS last FROM messages GROUP BY team').all()
    const out: Record<string, string> = {}
    for (const r of rows as Record<string, unknown>[]) out[String(r.team)] = String(r.last)
    return out
  } finally {
    db.close()
  }
}

// ---- 房间调度（2026-07-22 设计：不上 LLM selector，规则确定性轮转）----

export type DispatchMode = 'parallel' | 'serial' | 'claim'
export type DispatchState = 'active' | 'done' | 'cancelled'
export type DeliveryStatus = 'queued' | 'injected' | 'working' | 'replied' | 'done' | 'timeout' | 'cancelled' | 'failed'
/** claim 模式阶段：claiming=全员报认领中；implementing=已有赢家在实施；done=收单（超时/取消） */
export type DispatchPhase = 'claiming' | 'implementing' | 'done'

export interface DispatchRow {
  id: number
  team: string
  rootMessageId: number
  mode: DispatchMode
  state: DispatchState
  currentTarget: string | null
  deadline: string | null
  maxDepth: number
  cancelReason: string | null
  phase: DispatchPhase | null
  implementer: string | null
  claimDeadline: string | null
  worktreePath: string | null
  branch: string | null
  createdAt: string
  updatedAt: string
}

export interface DeliveryRow {
  id: number
  dispatchId: number
  memberName: string
  sessionId: string | null
  status: DeliveryStatus
  attempt: number
  correlationId: string | null
  createdAt: string
  updatedAt: string
}

export interface DispatchWithDeliveries extends DispatchRow {
  deliveries: DeliveryRow[]
}

function rowToDispatch(r: Record<string, unknown>): DispatchRow {
  return {
    id: Number(r.id),
    team: String(r.team),
    rootMessageId: Number(r.root_message_id),
    mode: String(r.mode) as DispatchMode,
    state: String(r.state) as DispatchState,
    currentTarget: r.current_target === null ? null : String(r.current_target),
    deadline: r.deadline === null ? null : String(r.deadline),
    maxDepth: Number(r.max_depth),
    cancelReason: r.cancel_reason === null ? null : String(r.cancel_reason),
    phase: r.phase === null || r.phase === undefined ? null : (String(r.phase) as DispatchPhase),
    implementer: r.implementer === null || r.implementer === undefined ? null : String(r.implementer),
    claimDeadline: r.claim_deadline === null || r.claim_deadline === undefined ? null : String(r.claim_deadline),
    worktreePath: r.worktree_path === null || r.worktree_path === undefined ? null : String(r.worktree_path),
    branch: r.branch === null || r.branch === undefined ? null : String(r.branch),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

function rowToDelivery(r: Record<string, unknown>): DeliveryRow {
  return {
    id: Number(r.id),
    dispatchId: Number(r.dispatch_id),
    memberName: String(r.member_name),
    sessionId: r.session_id === null ? null : String(r.session_id),
    status: String(r.status) as DeliveryStatus,
    attempt: Number(r.attempt),
    correlationId: r.correlation_id === null ? null : String(r.correlation_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

/** 记录一条消息的真实收件人集合（广播展开成成员名逐行落；INSERT OR IGNORE 幂等） */
export function recordMessageTargets(messageId: number, targets: string[]): void {
  const db = open()
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO message_targets (message_id, target_name) VALUES (?, ?)')
    for (const t of targets) stmt.run(messageId, t)
  } finally {
    db.close()
  }
}

/** 一条消息的真实收件人（审计/测试用），按 target_name 排序返回 */
export function targetsOf(messageId: number): string[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db.prepare('SELECT target_name FROM message_targets WHERE message_id = ? ORDER BY target_name').all(messageId)
    return (rows as Record<string, unknown>[]).map((r) => String(r.target_name))
  } finally {
    db.close()
  }
}

/** 幂等建 dispatch：UNIQUE(team, root_message_id)，重复建单返回既有行（created=false） */
export function createDispatch(
  team: string,
  rootMessageId: number,
  mode: DispatchMode,
  maxDepth = 3
): { dispatch: DispatchRow; created: boolean } {
  const db = open()
  try {
    const res = db
      .prepare('INSERT OR IGNORE INTO dispatch (team, root_message_id, mode, max_depth) VALUES (?, ?, ?, ?)')
      .run(team, rootMessageId, mode, maxDepth)
    const row = db.prepare('SELECT * FROM dispatch WHERE team = ? AND root_message_id = ?').get(team, rootMessageId)
    return { dispatch: rowToDispatch(row as Record<string, unknown>), created: Number(res.changes) > 0 }
  } finally {
    db.close()
  }
}

/** 为 dispatch 补 deliveries（INSERT OR IGNORE 防重），返回该 dispatch 当前全部 delivery（按 id 升序 = 成员顺序） */
export function addDeliveries(dispatchId: number, members: { name: string; sessionId: string | null }[]): DeliveryRow[] {
  const db = open()
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO delivery (dispatch_id, member_name, session_id) VALUES (?, ?, ?)')
    for (const m of members) stmt.run(dispatchId, m.name, m.sessionId)
    const rows = db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY id').all(dispatchId)
    return (rows as Record<string, unknown>[]).map(rowToDelivery)
  } finally {
    db.close()
  }
}

export function dispatchById(id: number): DispatchRow | null {
  if (!fs.existsSync(DB_PATH)) return null
  const db = open()
  try {
    const row = db.prepare('SELECT * FROM dispatch WHERE id = ?').get(id)
    return row ? rowToDispatch(row as Record<string, unknown>) : null
  } finally {
    db.close()
  }
}

/** 房间的 dispatch 列表（按 id 倒序，新的在前），各自带 deliveries（成员顺序） */
export function listDispatches(team: string, limit = 50): DispatchWithDeliveries[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db.prepare('SELECT * FROM dispatch WHERE team = ? ORDER BY id DESC LIMIT ?').all(team, limit)
    const delStmt = db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY id')
    return (rows as Record<string, unknown>[]).map((r) => ({
      ...rowToDispatch(r),
      deliveries: (delStmt.all(Number(r.id)) as Record<string, unknown>[]).map(rowToDelivery),
    }))
  } finally {
    db.close()
  }
}

export function deliveriesOf(dispatchId: number): DeliveryRow[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY id').all(dispatchId)
    return (rows as Record<string, unknown>[]).map(rowToDelivery)
  } finally {
    db.close()
  }
}

/** 更新 delivery；patch 里 undefined 的字段不动（null 是真实写入，用于清 correlation_id 等） */
export function updateDelivery(
  id: number,
  patch: { status?: DeliveryStatus; attempt?: number; correlationId?: string | null }
): void {
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    vals.push(patch.status)
  }
  if (patch.attempt !== undefined) {
    sets.push('attempt = ?')
    vals.push(patch.attempt)
  }
  if (patch.correlationId !== undefined) {
    sets.push('correlation_id = ?')
    vals.push(patch.correlationId)
  }
  if (!sets.length) return
  const db = open()
  try {
    db.prepare(`UPDATE delivery SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(
      ...vals,
      id
    )
  } finally {
    db.close()
  }
}

/** 更新 dispatch 状态机字段；undefined 不动，null 真实写入（清 currentTarget/deadline 用） */
export function setDispatchState(
  id: number,
  patch: {
    state?: DispatchState
    currentTarget?: string | null
    deadline?: string | null
    cancelReason?: string | null
    phase?: DispatchPhase | null
    implementer?: string | null
    claimDeadline?: string | null
    worktreePath?: string | null
    branch?: string | null
  }
): void {
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  if (patch.state !== undefined) {
    sets.push('state = ?')
    vals.push(patch.state)
  }
  if (patch.currentTarget !== undefined) {
    sets.push('current_target = ?')
    vals.push(patch.currentTarget)
  }
  if (patch.deadline !== undefined) {
    sets.push('deadline = ?')
    vals.push(patch.deadline)
  }
  if (patch.cancelReason !== undefined) {
    sets.push('cancel_reason = ?')
    vals.push(patch.cancelReason)
  }
  if (patch.phase !== undefined) {
    sets.push('phase = ?')
    vals.push(patch.phase)
  }
  if (patch.implementer !== undefined) {
    sets.push('implementer = ?')
    vals.push(patch.implementer)
  }
  if (patch.claimDeadline !== undefined) {
    sets.push('claim_deadline = ?')
    vals.push(patch.claimDeadline)
  }
  if (patch.worktreePath !== undefined) {
    sets.push('worktree_path = ?')
    vals.push(patch.worktreePath)
  }
  if (patch.branch !== undefined) {
    sets.push('branch = ?')
    vals.push(patch.branch)
  }
  if (!sets.length) return
  const db = open()
  try {
    db.prepare(`UPDATE dispatch SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(
      ...vals,
      id
    )
  } finally {
    db.close()
  }
}

/** 房间内全部 active 的 serial dispatch（按 id 升序）；串行推进/超时扫描用 */
export function activeSerialDispatches(team: string): DispatchRow[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db
      .prepare("SELECT * FROM dispatch WHERE team = ? AND mode = 'serial' AND state = 'active' ORDER BY id")
      .all(team)
    return (rows as Record<string, unknown>[]).map(rowToDispatch)
  } finally {
    db.close()
  }
}

/** 按 id 取消息（serial 放行下一位时回取根消息正文用） */
export function messageById(id: number): ProjectMessageRow | null {
  if (!fs.existsSync(DB_PATH)) return null
  const db = open()
  try {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return row ? rowToMessage(row as Record<string, unknown>) : null
  } finally {
    db.close()
  }
}

// ---- claim 认领制（先到先得，原子批准唯一 Implementer）----

/** 房间内仍在报认领阶段的 active dispatch（按 id 升序，最早的在前；claim 消息认最早那单） */
export function activeClaimingDispatches(team: string): DispatchRow[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db
      .prepare("SELECT * FROM dispatch WHERE team = ? AND mode = 'claim' AND state = 'active' AND phase = 'claiming' ORDER BY id")
      .all(team)
    return (rows as Record<string, unknown>[]).map(rowToDispatch)
  } finally {
    db.close()
  }
}

/**
 * 原子认领：仅当该 dispatch 仍无人认领时批准，按 affected rows 判输赢（先到先得）。
 * 返回 true=本成员赢（phase 同步推进 implementing）；false=已被别人认领（迟到，状态不动）。
 */
export function tryClaimDispatch(id: number, memberName: string): boolean {
  const db = open()
  try {
    const res = db
      .prepare(
        `UPDATE dispatch SET implementer = ?, phase = 'implementing',
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND implementer IS NULL`
      )
      .run(memberName, id)
    return Number(res.changes) > 0
  } finally {
    db.close()
  }
}

/** 某成员作为 implementer 的全部 active 且已开工作区的 dispatch（会话退出兜底提交用，跨房间查） */
export function activeDispatchesOfImplementer(memberName: string): DispatchRow[] {
  if (!fs.existsSync(DB_PATH)) return []
  const db = open()
  try {
    const rows = db
      .prepare(
        "SELECT * FROM dispatch WHERE implementer = ? AND state = 'active' AND worktree_path IS NOT NULL ORDER BY id"
      )
      .all(memberName)
    return (rows as Record<string, unknown>[]).map(rowToDispatch)
  } finally {
    db.close()
  }
}
