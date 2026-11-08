// OPC 后台只读视图：把轨道台账、看板工单、轨道健康表拼成一屏，不写任何 opc 数据。
// SoT 仍在 ~/skills/opc：本服务只读取
//   data/track-runs.jsonl  每单走过的轨（换轨后 tracks = a→b→c）
//   data/track-health.json 各轨用量/冷却/最近错误
//   config/tracks.json     轨的展示名与模型
//   data/kanban.db         工单队列（ready/claimed/running/blocked）
//   ~/.hermes/kanban/logs/<task_id>.log 每单工人日志（只在点开时读尾部）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import type { OpcRun, OpcSessionRow, OpcSnapshot, OpcTaskLog, OpcTaskRow, OpcTrackRow } from '../../../shared/protocol'

const RUN_LIMIT = 200
const TASK_LIMIT = 120
const TAIL_BYTES = 2 * 1024 * 1024
const LOG_TAIL_BYTES = 256 * 1024
const ACTIVE_STATUS = ['ready', 'claimed', 'running', 'in_progress', 'blocked']
/** 判定「该岗在跑」的状态（ready/blocked 是排队与阻断，不算在跑） */
const ACTIVE_RUNNING = ['claimed', 'running', 'in_progress']

function opcRoot(): string {
  return process.env.ARECO_OPC_ROOT || path.join(os.homedir(), 'skills', 'opc')
}

function logsDir(): string {
  return process.env.ARECO_OPC_LOGS || path.join(os.homedir(), '.hermes', 'kanban', 'logs')
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 读文件尾部窗口（台账会一直变长，不整文件进内存） */
function readTail(file: string, maxBytes = TAIL_BYTES): { text: string; truncated: boolean } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size === 0) return null
  const from = Math.max(0, stat.size - maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(stat.size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    return { text: buf.toString('utf8'), truncated: from > 0 }
  } finally {
    fs.closeSync(fd)
  }
}

interface RawTrackHealth {
  used?: number
  fallback?: number
  last_probe?: string
  consecutive_failures?: number
  last_error?: string
  last_error_kind?: string
  cooldown_until?: number
}

interface RawTrack {
  engine?: string
  model?: string
  label?: string
  surface?: string
}

interface RawTracksFile {
  tracks?: Record<string, RawTrack>
  default_prefs?: string[]
}

export function parseRun(value: unknown): OpcRun | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const taskId = typeof row.task_id === 'string' ? row.task_id : ''
  if (!taskId) return null
  return {
    ts: typeof row.ts === 'string' ? row.ts : '',
    taskId,
    dept: typeof row.dept === 'string' ? row.dept : '',
    title: typeof row.title === 'string' ? row.title : '',
    track: typeof row.track === 'string' ? row.track : '',
    tracks: typeof row.tracks === 'string' ? row.tracks : String(row.track ?? ''),
    engine: typeof row.engine === 'string' ? row.engine : '',
    model: typeof row.model === 'string' ? row.model : '',
    durS: Number(row.dur_s) || 0,
    ok: row.ok === true,
    errKind: typeof row.err_kind === 'string' ? row.err_kind : '',
    err: typeof row.err === 'string' ? row.err : '',
    fallback: Number(row.fallback) || 0,
    sessionId: typeof row.session_id === 'string' ? row.session_id : '',
  }
}

/** 台账正文 → 最近 RUN_LIMIT 单，最新在前（逐行解析，坏行跳过） */
export function parseRunsText(text: string, limit = RUN_LIMIT): OpcRun[] {
  return parseAllRuns(text).reverse().slice(0, limit)
}

/** 台账正文 → 全部单（旧在前）。今日统计要用全量，不能只看尾部窗口里的 200 条。 */
export function parseAllRuns(text: string): OpcRun[] {
  const runs: OpcRun[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // 尾部半行
    }
    const run = parseRun(parsed)
    if (run) runs.push(run)
  }
  return runs
}

// ── 会话定位：台账 session_id → 历史页的 (source, project) ──
// 各引擎落盘都是 <root>/<cwd-slug>/<session-id>.jsonl，只有根与源名不同。
const SESSION_ROOTS: Record<string, { source: string; dir: string }[]> = {
  codebuddy: [{ source: 'codebuddy', dir: path.join(os.homedir(), '.codebuddy', 'projects') }],
  qoder: [
    { source: 'qoder', dir: path.join(os.homedir(), '.qoder', 'projects') },
    { source: 'qoder-cn', dir: path.join(os.homedir(), '.qoder-cn', 'projects') },
  ],
}
const sessionCache = new Map<string, { source: string; project: string } | null>()

/**
 * 会话文件位置：各引擎落盘都是 <root>/<cwd-slug>/<session-id>.jsonl。
 * 全量扫一遍 ~/.codebuddy/projects 要两分钟（1.5 万会话 / 6.3G），所以只按 id
 * 逐个 slug 目录做 existsSync（几百个目录，毫秒级），命中即缓存。
 */
export function locateSession(sessionId: string, engine = ''): { source: string; project: string } | null {
  if (!sessionId) return null
  const hit = sessionCache.get(sessionId)
  if (hit !== undefined) return hit
  // 先按引擎自己的根找，再兜底扫全部根（会话可能由换轨前的另一引擎开出，如财务旧会话落在 qoder-cn）
  const primary = SESSION_ROOTS[engine] ?? []
  const roots = primary.concat(Object.values(SESSION_ROOTS).flat().filter((r) => !primary.includes(r)))
  let found: { source: string; project: string } | null = null
  for (const root of roots) {
    let projects: string[] = []
    try {
      projects = fs.readdirSync(root.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const project of projects) {
      if (fs.existsSync(path.join(root.dir, project, `${sessionId}.jsonl`))) {
        found = { source: root.source, project }
        break
      }
    }
    if (found) break
  }
  if (sessionCache.size > 1000) sessionCache.clear()
  sessionCache.set(sessionId, found)
  return found
}

/** 本地日历日（台账 ts 写的是本地时间 "YYYY-MM-DDTHH:mm:ss"，按前缀比对即可） */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今日各轨跑单数（按最终落地的轨计）+ 今日总数/成功数 */
export function todayStats(runs: OpcRun[], day = localDay()): {
  byTrack: Record<string, number>
  runs: number
  ok: number
} {
  const byTrack: Record<string, number> = {}
  let total = 0
  let ok = 0
  for (const r of runs) {
    if (!r.ts.startsWith(day)) continue
    total += 1
    if (r.ok) ok += 1
    const t = r.track || 'unknown'
    byTrack[t] = (byTrack[t] ?? 0) + 1
  }
  return { byTrack, runs: total, ok }
}

function readRuns(): { runs: OpcRun[]; today: { runs: number; ok: number }; byTrack: Record<string, number>; warning?: string } {
  const tail = readTail(path.join(opcRoot(), 'data', 'track-runs.jsonl'), 64 * 1024 * 1024)
  if (!tail) return { runs: [], today: { runs: 0, ok: 0 }, byTrack: {}, warning: '轨道台账 track-runs.jsonl 不存在' }
  let text = tail.text
  if (tail.truncated) {
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)
  }
  const all = parseAllRuns(text)
  const stats = todayStats(all)
  return { runs: all.reverse().slice(0, RUN_LIMIT), today: { runs: stats.runs, ok: stats.ok }, byTrack: stats.byTrack }
}

function readTracks(usedToday: Record<string, number> = {}): OpcTrackRow[] {
  const file = readJson<RawTracksFile>(path.join(opcRoot(), 'config', 'tracks.json'))
  const health = readJson<Record<string, RawTrackHealth>>(path.join(opcRoot(), 'data', 'track-health.json')) ?? {}
  const defs = file?.tracks ?? {}
  const order = (file?.default_prefs ?? []).filter((id) => defs[id])
  for (const id of Object.keys(defs)) if (!order.includes(id)) order.push(id)
  const now = Date.now()
  return order.map((id) => {
    const def = defs[id] ?? {}
    const h = health[id]
    const cooldownUntil = Number(h?.cooldown_until) || 0
    const lastErrorKind = h?.last_error_kind ?? ''
    const status = !h
      ? 'missing'
      : cooldownUntil * 1000 > now
        ? 'cooldown'
        : lastErrorKind
          ? 'error'
          : 'ok'
    return {
      id,
      label: def.label ?? id,
      engine: def.engine ?? '',
      model: def.model ?? '',
      surface: def.surface ?? '',
      used: Number(h?.used) || 0,
      usedToday: usedToday[id] ?? 0,
      fallback: Number(h?.fallback) || 0,
      failures: Number(h?.consecutive_failures) || 0,
      cooldownUntil,
      status,
      lastProbe: h?.last_probe ?? '',
      lastErrorKind,
      lastError: h?.last_error ?? '',
    }
  })
}

interface TaskDbRow {
  id: string
  title: string
  assignee: string | null
  status: string
  priority: number | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  consecutive_failures: number | null
  last_failure_error: string | null
  worker_pid: number | null
}

function readTasks(): { tasks: OpcTaskRow[]; counts: Record<string, number>; warning?: string } {
  const file = path.join(opcRoot(), 'data', 'kanban.db')
  if (!fs.existsSync(file)) return { tasks: [], counts: {}, warning: '看板库 kanban.db 不存在' }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    // 只看今天的单（2026-11-08 高律师令「都显示今天的工单」）：口径＝本地日历日创建的工单
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const since = Math.floor(dayStart.getTime() / 1000)
    const counts: Record<string, number> = {}
    for (const row of db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE created_at >= ? GROUP BY status')
      .all(since) as unknown as { status: string; n: number }[]) {
      counts[row.status] = Number(row.n) || 0
    }
    const placeholders = ACTIVE_STATUS.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, title, assignee, status, priority, created_at, started_at, completed_at,
                consecutive_failures, last_failure_error, worker_pid
           FROM tasks
          WHERE status IN (${placeholders}) AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT ?`
      )
      .all(...ACTIVE_STATUS, since, TASK_LIMIT) as unknown as TaskDbRow[]
    const tasks = rows.map((row) => ({
      id: row.id,
      title: row.title,
      assignee: row.assignee ?? '',
      status: row.status,
      priority: Number(row.priority) || 0,
      createdAt: Number(row.created_at) || 0,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      failures: Number(row.consecutive_failures) || 0,
      lastError: row.last_failure_error ?? '',
      workerPid: row.worker_pid ?? null,
      hasLog: fs.existsSync(path.join(logsDir(), `${row.id}.log`)),
    }))
    return { tasks, counts }
  } catch (err) {
    return { tasks: [], counts: {}, warning: `看板库读取失败：${(err as Error).message}` }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 台账里的标题补正：历史行记的是工位名（「通话录音」），看不出是哪个人哪件事。
 * 按 task_id 回看板取工单自身标题，让「在办」与「今日完成」两处叫同一个名字。
 */
function readTaskTitles(ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const file = path.join(opcRoot(), 'data', 'kanban.db')
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length || !fs.existsSync(file)) return out
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    for (let i = 0; i < uniq.length; i += 400) {
      const part = uniq.slice(i, i + 400)
      const ph = part.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT id, title FROM tasks WHERE id IN (${ph})`)
        .all(...part) as unknown as { id: string; title: string | null }[]
      for (const row of rows) if (row.title) out.set(row.id, row.title)
    }
  } catch {
    /* 看板库读不了就沿用台账原标题 */
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
  return out
}

interface RawDept {
  name?: string
  standing_session?: boolean
  status?: string
  engine?: string
  qoder_model?: string
}

interface RawSessionEntry {
  session_id?: string
  rounds?: number
  engine?: string
  updated?: string
}

/**
 * 常驻会话岗：depts.json 里 standing_session=true 的岗位 + colleague-sessions.json 的会话登记。
 * 会话文件位置按 id 直查（locateSession），供前端「打开对话记录」跳到历史页。
 */
function readSessions(runs: OpcRun[], tasks: OpcTaskRow[]): OpcSessionRow[] {
  const depts = readJson<Record<string, RawDept>>(path.join(opcRoot(), 'config', 'depts.json')) ?? {}
  const book = readJson<Record<string, RawSessionEntry>>(path.join(opcRoot(), 'data', 'colleague-sessions.json')) ?? {}
  const rows: OpcSessionRow[] = []
  for (const [dept, cfg] of Object.entries(depts)) {
    if (!cfg || cfg.standing_session !== true) continue
    const ent = book[dept] ?? {}
    const sessionId = typeof ent.session_id === 'string' ? ent.session_id : ''
    const engine = (typeof ent.engine === 'string' && ent.engine) || cfg.engine || ''
    const ref = sessionId ? locateSession(sessionId, engine) : null
    const running = tasks.find((t) => t.assignee === dept && ACTIVE_RUNNING.includes(t.status))
    const queued = tasks.find((t) => t.assignee === dept && t.status === 'ready')
    const last = runs.find((r) => r.dept === dept)
    rows.push({
      dept,
      name: cfg.name || dept,
      engine,
      model: cfg.qoder_model ?? '',
      sessionId,
      rounds: Number(ent.rounds) || 0,
      updated: typeof ent.updated === 'string' ? ent.updated : '',
      sessionSource: ref?.source,
      sessionProject: ref?.project,
      runningTaskId: running?.id,
      runningTitle: running?.title,
      queuedTaskId: queued?.id,
      queuedTitle: queued?.title,
      lastRunAt: last?.ts,
      lastRunOk: last?.ok,
    })
  }
  // 在跑／排队在前，其余按最近一单倒序（没跑过的沉底）
  const live = (s: OpcSessionRow) => Number(Boolean(s.runningTaskId)) * 2 + Number(Boolean(s.queuedTaskId))
  rows.sort(
    (a, b) =>
      live(b) - live(a) ||
      (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '') ||
      (b.updated || '').localeCompare(a.updated || '') ||
      a.dept.localeCompare(b.dept)
  )
  return rows
}

const OPC_PY = process.env.ARECO_OPC_PY || '/opt/homebrew/bin/python3.13'

/**
 * 常驻会话对话：把一句话当工单派给该岗，worker 用同一条常驻会话续聊（同轨续用、换轨新开）。
 * 走 chat-dispatch.py 这个唯一投递口——principal_only 岗（网上立案）只有带 --principal 才收。
 */
export function sendSessionMessage(dept: string, text: string): { taskId: string; title: string; receipt: string } {
  const depts = readJson<Record<string, RawDept>>(path.join(opcRoot(), 'config', 'depts.json')) ?? {}
  const cfg = depts[dept]
  if (!cfg) throw new Error(`没有这个岗位：${dept}`)
  if (cfg.standing_session !== true) throw new Error(`「${cfg.name || dept}」不是常驻会话岗`)
  const bodyText = text.trim()
  if (!bodyText) throw new Error('内容不能为空')
  if (bodyText.length > 8000) throw new Error('内容过长（上限 8000 字）')

  const firstLine = bodyText.split('\n').find((l) => l.trim())?.trim() ?? ''
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
  const body = `〔常驻会话对话〕高律师在 OPC 页面直接发来的一句话，按本岗职责直接办或直接答，不要另开话题。\n\n${bodyText}`
  const script = path.join(opcRoot(), 'scripts', 'chat-dispatch.py')
  if (!fs.existsSync(script)) throw new Error(`派单口不存在：${script}`)

  const r = spawnSync(OPC_PY, [script, '--assignee', dept, '--title', title, '--stdin', '--principal'], {
    input: body,
    encoding: 'utf8',
    timeout: 90_000,
    cwd: opcRoot(),
  })
  if (r.error) throw new Error(`派单失败：${r.error.message}`)
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')
    throw new Error(msg || `派单失败（退出码 ${r.status}）`)
  }
  const m = /已入队\s+(t_[A-Za-z0-9]+)/.exec(r.stdout ?? '')
  return { taskId: m?.[1] ?? '', title, receipt: (r.stdout ?? '').trim() }
}

export function snapshot(): OpcSnapshot {
  const { runs, today, byTrack, warning: runWarn } = readRuns()
  const { tasks, counts, warning: taskWarn } = readTasks()
  const titles = readTaskTitles(runs.map((r) => r.taskId))
  for (const r of runs) {
    const real = titles.get(r.taskId)
    if (real) r.title = real
  }
  for (const r of runs) {
    const ref = r.sessionId ? locateSession(r.sessionId, r.engine) : null
    if (ref) {
      r.sessionSource = ref.source
      r.sessionProject = ref.project
    }
  }
  return {
    ts: Date.now(),
    runs,
    tasks,
    counts,
    today,
    tracks: readTracks(byTrack),
    sessions: readSessions(runs, tasks),
    warning: runWarn ?? taskWarn,
  }
}

/** 单张工单的工人日志尾部（只读，最多 400 行） */
export function taskLog(id: string, maxLines = 400): OpcTaskLog {
  if (!/^t_[A-Za-z0-9]+$/.test(id)) throw new Error('工单 id 不合法')
  const file = path.join(logsDir(), `${id}.log`)
  if (!fs.existsSync(file)) throw new Error('该工单没有工人日志')
  const tail = readTail(file, LOG_TAIL_BYTES)
  if (!tail) throw new Error('该工单日志为空')
  let text = tail.text
  if (tail.truncated) {
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)
  }
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const truncated = tail.truncated || lines.length > maxLines
  return { id, path: file, lines: lines.slice(-maxLines), truncated }
}
