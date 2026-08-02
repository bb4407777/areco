// 消息库（双库，2026-08-02 高律师定名分库）：任务房 → data/tasks.db，项目房 → data/projects.db。
// 路由收在本层内部：按 data/rooms.json 的房间 kind 选库（mtime 缓存），调用方（room-relay/
// controllers/CLI）签名与行为零改动；kind 查无（孤儿/已删房/测试无 rooms.json）兜底 tasks.db，
// 因此无 rooms.json 的环境行为与旧单库完全一致。
// id 永不相撞：存量来自原单库（id 天然唯一）；新增侧 projects.db 三张自增表的起点 seed 到
// 10_000_000（openFor 建库与迁移脚本双保险），tasks.db 自然增长——按 id 的查询两库顺查即可。
// 服务端 room-relay 读写；本机任何终端可用 scripts/areco-msg.mjs 直写回执（同路由规则）——
// WAL + busy_timeout 保证与服务端并发安全，relay 的 2s 游标轮询自然拾取。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config'

export type DbKind = 'task' | 'project'
const DB_PATHS: Record<DbKind, string> = {
  task: path.join(DATA_DIR, 'tasks.db'),
  project: path.join(DATA_DIR, 'projects.db'),
}
const ROOMS_JSON = path.join(DATA_DIR, 'rooms.json')
/** projects.db 自增起点：与 tasks.db 的自然增长（当前 ~2k，日增几十）永不相交 */
const PROJECT_ID_SEED = 10_000_000

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
-- P2-10：lastMessageAts 的 SELECT team, MAX(created_at) GROUP BY team 走索引跳扫，
-- 不再全表扫（该查询挂在每次建房/加成员/归档的 rooms 广播上）
CREATE INDEX IF NOT EXISTS idx_team_created ON messages(team, created_at);
-- 房间调度底账（确定性房间调度，2026-07-22）：消息可见性与行动许可拆开。
-- message_targets 记录每条消息的真实收件人集合（广播也展开成成员名逐行落），
-- 替代单一 to_agent 的审计盲区；messages.to_agent 保留不动，兼容旧数据与 areco-msg CLI。
CREATE TABLE IF NOT EXISTS message_targets (
  message_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  UNIQUE(message_id, target_name)
);
-- dispatch：一次投递任务（以触发它的根消息为幂等键，重复建单返回既有行）。
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

// 建表与迁移每进程只做一次。
// 原先每个 open() 都跑：mkdir + 5 条 CREATE TABLE IF NOT EXISTS + 1 索引 + 2 次
// PRAGMA table_info 迁移探测。而 RoomRelay.tick 每 2 秒对每个房间调 history()（当前 39 个
// 房间，其中 23 个已归档），sweepTimeouts 再来一轮 —— 折算约 40 次/秒的全量 DDL，
// 打在一个 CLI 侧（areco-msg.mjs）也在并发写的库上。功能上能跑，但纯属浪费，
// 且是房间数增长后 WAL 争用的第一个源头。
//
// P2-10（2026-07-30）：短连接进一步升级为进程级共享长连接。tick 每秒对每个活跃房间
// history() 一次，每次新开连接（open+PRAGMA+close）纯属固定税；WAL 下服务端长连接与
// CLI 侧（areco-msg.mjs）短连接并发互不阻塞（reader 不挡 writer，writer 锁有
// busy_timeout=3000 兜底）。调用点的 finally db.close() 全部改为空操作注释——
// 单例连接随进程存亡，SQLite 进程退出自动释放。
const sharedDbs: Record<DbKind, DatabaseSync | null> = { task: null, project: null }

function open(kind: DbKind): DatabaseSync {
  const cached = sharedDbs[kind]
  if (cached) return cached
  fs.mkdirSync(path.dirname(DB_PATHS[kind]), { recursive: true })
  const db = new DatabaseSync(DB_PATHS[kind])
  // busy_timeout 先设：journal_mode=WAL 本身就可能要拿锁，
  // 原顺序（WAL 在前）让唯一真正需要等锁的那条语句反而没有超时保护。
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;')
  db.exec(SCHEMA)
  migrateMessages(db)
  migrateDispatch(db)
  if (kind === 'project') seedProjectSequences(db)
  sharedDbs[kind] = db
  return db
}

/** projects.db 三张自增表起点 seed（幂等）：已有更高水位不动，防两库 id 相撞 */
function seedProjectSequences(db: DatabaseSync): void {
  for (const table of ['messages', 'dispatch', 'delivery']) {
    const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
      | { seq: number }
      | undefined
    if (!row) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, PROJECT_ID_SEED)
    else if (Number(row.seq) < PROJECT_ID_SEED)
      db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(PROJECT_ID_SEED, table)
  }
}

// ── kind 路由：data/rooms.json 的房间 kind（mtime 缓存 + 2s stat TTL），查无兜底 task ──
// tick 每秒对每个活跃房间 history() 一次，路由若每次 statSync 就是每秒几十次冗余
// syscall——mtime 缓存判「要不要重读」，TTL 判「要不要重 stat」。建房落盘 → 首条消息
// 之间远超 2s，感知延迟无实害。
const ROOMS_STAT_TTL_MS = 2000
let roomsKindCache: { mtimeMs: number; kinds: Map<string, DbKind> } | null = null
let roomsStatAtMs = 0
let roomsWarnAtMs = 0

export function dbKindForTeam(team: string): DbKind {
  try {
    const now = Date.now()
    if (!roomsKindCache || now - roomsStatAtMs >= ROOMS_STAT_TTL_MS) {
      roomsStatAtMs = now
      const st = fs.statSync(ROOMS_JSON)
      if (!roomsKindCache || roomsKindCache.mtimeMs !== st.mtimeMs) {
        const arr = JSON.parse(fs.readFileSync(ROOMS_JSON, 'utf8'))
        const kinds = new Map<string, DbKind>()
        if (Array.isArray(arr))
          for (const r of arr)
            if (r && typeof r === 'object' && r.team)
              kinds.set(String(r.team), r.kind === 'project' ? 'project' : 'task')
        roomsKindCache = { mtimeMs: st.mtimeMs, kinds }
      }
    }
    return roomsKindCache.kinds.get(team) ?? 'task'
  } catch (err) {
    // rooms.json 缺失/损坏：兜底任务库（与旧单库行为一致）。损坏时项目房消息会
    // 错落任务库——不能全静默，节流告警（60s 一次）留可观测线索。
    const now = Date.now()
    if (now - roomsWarnAtMs > 60_000) {
      roomsWarnAtMs = now
      console.warn(`[project-db] rooms.json 不可读，kind 路由兜底 tasks.db：${err instanceof Error ? err.message : err}`)
    }
    return 'task'
  }
}

function openFor(team: string): DatabaseSync {
  return open(dbKindForTeam(team))
}

/** 测试钩子：清路由与存在性缓存（TTL 让毫秒级 rooms.json 切换不可见——生产语义，测试须显式冲掉；生产勿调） */
export function _resetRoutingCachesForTest(): void {
  roomsKindCache = null
  roomsStatAtMs = 0
  dbFileSeen.task = false
  dbFileSeen.project = false
}

/** 库文件存在性（单调缓存：打开过/见过即永真——库只增建不删除，false 才重查盘） */
const dbFileSeen: Record<DbKind, boolean> = { task: false, project: false }
function dbFileExists(kind: DbKind): boolean {
  if (dbFileSeen[kind] || sharedDbs[kind]) return (dbFileSeen[kind] = true)
  if (fs.existsSync(DB_PATHS[kind])) return (dbFileSeen[kind] = true)
  return false
}

/** 已落盘的库集合（存在才 open，只读路径不误建空库），task 在前保持顺查稳定序 */
function existingDbs(): DatabaseSync[] {
  const out: DatabaseSync[] = []
  for (const kind of ['task', 'project'] as DbKind[]) if (dbFileExists(kind)) out.push(open(kind))
  return out
}

/** 按 id 定库的候选序（利用 seed 错位免探测）：
 *  id ≥ SEED → 只可能在 projects.db（seed 硬保证，O(1) 直路由）；
 *  id < SEED → 大概率 tasks.db（任务消息量大），miss 回退 projects.db
 *  （迁移保留原 id 的存量项目数据，随时间自然淡出热路径）。 */
function dbsForId(id: number): DatabaseSync[] {
  if (id >= PROJECT_ID_SEED) return dbFileExists('project') ? [open('project')] : []
  return existingDbs()
}

/** 含指定消息 id 的库（两库 id 永不相撞，最多命中一个） */
function dbWithMessage(id: number): DatabaseSync | null {
  for (const db of dbsForId(id)) if (stmt(db, 'SELECT 1 FROM messages WHERE id = ?').get(id)) return db
  return null
}

/** 含指定 dispatch id 的库 */
function dbWithDispatch(id: number): DatabaseSync | null {
  for (const db of dbsForId(id)) if (stmt(db, 'SELECT 1 FROM dispatch WHERE id = ?').get(id)) return db
  return null
}

/**
 * 宽容迁移：CREATE TABLE IF NOT EXISTS 不会改既有表。claim 模式上线前的开发库可能已建了
 * 旧版 dispatch 表（CHECK 不含 'claim'、缺 phase/implementer 等新列）——SQLite 改不了 CHECK，
 * 只能整表重建；缺列则 ALTER TABLE ADD COLUMN。生产库上线前从未建过该表，走不到这里。
 * 注：claim 调度模式已于 2026-07-25 砍掉（保 serial+parallel），下列 ADD COLUMN 仅为旧库兼容，
 * 新代码不再写入这些列。
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

// ── prepared statement 缓存（2026-08-02 提速二轮）────────────────────
// node:sqlite 的 db.prepare() 每次都重新编译 SQL；tick 每秒对每个活跃房间跑
// history/historyAfter，编译成本纯属固定税。StatementSync 官方支持跨调用复用
// （.get/.all/.run 可重复执行），按 (db, sql) 缓存；WeakMap 键随连接存亡，无泄漏。
type StatementSyncT = ReturnType<DatabaseSync['prepare']>
const stmtCache = new WeakMap<DatabaseSync, Map<string, StatementSyncT>>()
function stmt(db: DatabaseSync, sql: string): StatementSyncT {
  let m = stmtCache.get(db)
  if (!m) stmtCache.set(db, (m = new Map()))
  let s = m.get(sql)
  if (!s) m.set(sql, (s = db.prepare(sql)))
  return s
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
  const db = openFor(team)
  try {
    const res = stmt(db, 'INSERT INTO messages (team, from_agent, to_agent, body, human_relay) VALUES (?, ?, ?, ?, ?)').run(
      team, from, to, body, opts?.humanRelay ? 1 : 0)
    const row = stmt(db, 'SELECT * FROM messages WHERE id = ?').get(res.lastInsertRowid as number)
    return rowToMessage(row as Record<string, unknown>)
  } finally {
    /* P2-10 共享长连接：不逐调用关闭（见 open） */
  }
}

/** 消息流：按 team 拉最近 limit 条，升序返回 */
export function history(team: string, limit = 100): ProjectMessageRow[] {
  const kind = dbKindForTeam(team)
  if (!dbFileExists(kind)) return []
  const db = open(kind)
  const rows = stmt(db, 'SELECT * FROM messages WHERE team=? ORDER BY id DESC LIMIT ?').all(team, limit)
  return (rows as Record<string, unknown>[]).map(rowToMessage).reverse()
}

/** 增量消息流（tick 游标下推，2026-08-02 提速二轮）：id > afterId 的消息升序直查。
 *  走 idx_team_history 索引且无需 reverse；平时新消息为零 → 每 tick 每房间零行返回，
 *  取代「拉最近 50 条到 JS 层再按游标过滤、积压时指数放大重拉」的旧模式。 */
export function historyAfter(team: string, afterId: number, limit = 6400): ProjectMessageRow[] {
  const kind = dbKindForTeam(team)
  if (!dbFileExists(kind)) return []
  const db = open(kind)
  const rows = stmt(db, 'SELECT * FROM messages WHERE team=? AND id>? ORDER BY id ASC LIMIT ?').all(
    team,
    afterId,
    limit
  )
  return (rows as Record<string, unknown>[]).map(rowToMessage)
}

/**
 * 署名校正（2026-07-29 冒名回执事件：会话被别的模板接手后照抄旧回执命令，
 * from_agent 记成原成员名）：room-relay tick 摄入时按绑定会话当前模板改写本行署名。
 */
export function correctMessageSender(id: number, newFrom: string): void {
  if (!newFrom.trim()) throw new Error('newFrom 不能为空')
  // id 两库无撞：按 seed 范围直路由（≥SEED 单库 O(1)），命中即止
  for (const db of dbsForId(id)) {
    const res = db.prepare('UPDATE messages SET from_agent = ? WHERE id = ?').run(newFrom, id)
    if (Number(res.changes) > 0) return
  }
}

/** 跨所有项目房间搜消息正文（LIKE，% _ \ 转义防通配符误判），按 id 倒序返回 limit 条 */
export function search(q: string, limit = 50): ProjectMessageRow[] {
  const needle = q.trim()
  if (!needle) return []
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`)
  // 跨库合并：两库各取 limit，按 created_at 倒序（跨库 id 不可比时序，projects 存量 id 小于
  // tasks 新增而时间更晚）取前 limit
  const merged: ProjectMessageRow[] = []
  for (const db of existingDbs()) {
    const rows = db
      .prepare("SELECT * FROM messages WHERE body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?")
      .all(`%${escaped}%`, limit)
    merged.push(...(rows as Record<string, unknown>[]).map(rowToMessage))
  }
  return merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id)).slice(0, limit)
}

/** 各 team 最后一条消息时间（房间列表按最近回复排序用）；无消息的 team 缺席。created_at 为 ISO 文本，MAX 词典序即最新 */
export function lastMessageAts(): Record<string, string> {
  // 两库合并：同一 team 的消息只会在一个库（路由确定性），直接并集；
  // 万一迁移半途同 team 两库都有，取时间较大者
  const out: Record<string, string> = {}
  for (const db of existingDbs()) {
    const rows = db.prepare('SELECT team, MAX(created_at) AS last FROM messages GROUP BY team').all()
    for (const r of rows as Record<string, unknown>[]) {
      const team = String(r.team)
      const last = String(r.last)
      if (!out[team] || out[team] < last) out[team] = last
    }
  }
  return out
}

// ---- 房间调度（2026-07-22 设计：不上 LLM selector，规则确定性轮转）----

export type DispatchMode = 'parallel' | 'serial'
export type DispatchState = 'active' | 'done' | 'cancelled'
export type DeliveryStatus = 'queued' | 'injected' | 'working' | 'replied' | 'done' | 'timeout' | 'cancelled' | 'failed'

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
  // targets 与其 message 同库（含该 id 消息的库；查无兜底任务库,与旧行为一致）
  const db = dbWithMessage(messageId) ?? open('task')
  const stmt = db.prepare('INSERT OR IGNORE INTO message_targets (message_id, target_name) VALUES (?, ?)')
  for (const t of targets) stmt.run(messageId, t)
}

/** 一条消息的真实收件人（审计/测试用），按 target_name 排序返回 */
export function targetsOf(messageId: number): string[] {
  const db = dbWithMessage(messageId)
  if (!db) return []
  const rows = db.prepare('SELECT target_name FROM message_targets WHERE message_id = ? ORDER BY target_name').all(messageId)
  return (rows as Record<string, unknown>[]).map((r) => String(r.target_name))
}

/** 幂等建 dispatch：UNIQUE(team, root_message_id)，重复建单返回既有行（created=false） */
export function createDispatch(
  team: string,
  rootMessageId: number,
  mode: DispatchMode,
  maxDepth = 3
): { dispatch: DispatchRow; created: boolean } {
  const db = openFor(team)
  try {
    const res = db
      .prepare('INSERT OR IGNORE INTO dispatch (team, root_message_id, mode, max_depth) VALUES (?, ?, ?, ?)')
      .run(team, rootMessageId, mode, maxDepth)
    const row = db.prepare('SELECT * FROM dispatch WHERE team = ? AND root_message_id = ?').get(team, rootMessageId)
    return { dispatch: rowToDispatch(row as Record<string, unknown>), created: Number(res.changes) > 0 }
  } finally {
    /* P2-10 共享长连接：不逐调用关闭（见 open） */
  }
}

/** 为 dispatch 补 deliveries（INSERT OR IGNORE 防重），返回该 dispatch 当前全部 delivery（按 id 升序 = 成员顺序） */
export function addDeliveries(dispatchId: number, members: { name: string; sessionId: string | null }[]): DeliveryRow[] {
  // delivery 与其 dispatch 同库
  const db = dbWithDispatch(dispatchId) ?? open('task')
  const stmt = db.prepare('INSERT OR IGNORE INTO delivery (dispatch_id, member_name, session_id) VALUES (?, ?, ?)')
  for (const m of members) stmt.run(dispatchId, m.name, m.sessionId)
  const rows = db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY id').all(dispatchId)
  return (rows as Record<string, unknown>[]).map(rowToDelivery)
}

export function dispatchById(id: number): DispatchRow | null {
  const db = dbWithDispatch(id)
  if (!db) return null
  const row = db.prepare('SELECT * FROM dispatch WHERE id = ?').get(id)
  return row ? rowToDispatch(row as Record<string, unknown>) : null
}

/** 房间的 dispatch 列表（按 id 倒序，新的在前），各自带 deliveries（成员顺序） */
export function listDispatches(team: string, limit = 50): DispatchWithDeliveries[] {
  const kind = dbKindForTeam(team)
  if (!dbFileExists(kind)) return []
  const db = open(kind)
  try {
    const rows = db.prepare('SELECT * FROM dispatch WHERE team = ? ORDER BY id DESC LIMIT ?').all(team, limit)
    const delStmt = db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY id')
    return (rows as Record<string, unknown>[]).map((r) => ({
      ...rowToDispatch(r),
      deliveries: (delStmt.all(Number(r.id)) as Record<string, unknown>[]).map(rowToDelivery),
    }))
  } finally {
    /* P2-10 共享长连接：不逐调用关闭（见 open） */
  }
}

export function deliveriesOf(dispatchId: number): DeliveryRow[] {
  const db = dbWithDispatch(dispatchId)
  if (!db) return []
  const rows = db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY id').all(dispatchId)
  return (rows as Record<string, unknown>[]).map(rowToDelivery)
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
  for (const db of dbsForId(id)) {
    const res = db
      .prepare(`UPDATE delivery SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .run(...vals, id)
    if (Number(res.changes) > 0) return
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
  if (!sets.length) return
  for (const db of dbsForId(id)) {
    const res = db
      .prepare(`UPDATE dispatch SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .run(...vals, id)
    if (Number(res.changes) > 0) return
  }
}

/** 房间内全部 active 的 serial dispatch（按 id 升序）；串行推进/超时扫描用 */
export function activeSerialDispatches(team: string): DispatchRow[] {
  const kind = dbKindForTeam(team)
  if (!dbFileExists(kind)) return []
  const db = open(kind)
  try {
    const rows = db
      .prepare("SELECT * FROM dispatch WHERE team = ? AND mode = 'serial' AND state = 'active' ORDER BY id")
      .all(team)
    return (rows as Record<string, unknown>[]).map(rowToDispatch)
  } finally {
    /* P2-10 共享长连接：不逐调用关闭（见 open） */
  }
}

/** 按 id 取消息（serial 放行下一位时回取根消息正文用） */
export function messageById(id: number): ProjectMessageRow | null {
  const db = dbWithMessage(id)
  if (!db) return null
  const row = stmt(db, 'SELECT * FROM messages WHERE id = ?').get(id)
  return row ? rowToMessage(row as Record<string, unknown>) : null
}
