// MiniMax Code 历史源：只读 ~/.minimax/v2/sqlite/runtime-state.sqlite。
// mcode（CLI）与 MiniMax Code.app 共用这份本地库：会话在 local_runtime_sessions，
// 逐条消息在 local_runtime_message_rows（正文塞在 data_json 里）。
// 这里只 SELECT，不写库、不复制、不改 mcode 的目录结构——mcode 自己升级换 schema 时，
// 查不到表就整源返回空，不影响其他历史源。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  HistoryEntry,
  HistoryTranscriptPage,
  TranscriptMessage,
  TranscriptPart,
} from '../../../shared/protocol'

const MCODE_SESSION_ID = /^mvs_[0-9a-f]{32}$/
const TITLE_MAX = 80

/** 会话库路径：env 覆盖仅为测试用；默认 mcode 自己的落点 */
export function mcodeDbPath(): string {
  return process.env.ARECO_MCODE_DB || path.join(os.homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')
}

function openDb(): DatabaseSync | null {
  const file = mcodeDbPath()
  if (!fs.existsSync(file)) return null
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

interface SessionRow {
  session_id: string
  title: string | null
  workspace_dir: string | null
  created_at_ms: number | null
  updated_at_ms: number
}

/** 历史列表：只读 session 表，按最后活动倒序；标题空则退 id 前 12 位 */
export function mcodeEntries(): HistoryEntry[] {
  const db = openDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms
           FROM local_runtime_sessions
          ORDER BY updated_at_ms DESC`
      )
      .all() as unknown as SessionRow[]
    const entries: HistoryEntry[] = []
    for (const row of rows) {
      const id = String(row.session_id ?? '')
      if (!MCODE_SESSION_ID.test(id)) continue
      const rawTitle = (row.title ?? '').replace(/\s+/g, ' ').trim()
      const title = rawTitle
        ? rawTitle.length > TITLE_MAX
          ? `${rawTitle.slice(0, TITLE_MAX - 1)}…`
          : rawTitle
        : id.slice(4, 16)
      entries.push({
        source: 'mcode',
        project: 'minimax',
        id,
        title,
        cwd: row.workspace_dir ?? '',
        mtimeMs: Number(row.updated_at_ms) || 0,
        createdMs: Number(row.created_at_ms) || 0,
        size: 0,
        liveSessionId: null,
        resumable: false, // mcode exec --resume 走原生会话，areco 不代起
      })
    }
    return entries
  } catch {
    return []
  } finally {
    safeClose(db)
  }
}

/** 历史正文：逐条消息拼 parts（思考/正文/工具调用），工具结果太重不入页 */
export function readMcdeTranscript(id: string): HistoryTranscriptPage {
  if (!MCODE_SESSION_ID.test(id)) throw new Error('会话 id 不合法')
  const db = openDb()
  if (!db) throw new Error('mcode 会话库不存在')
  try {
    const rows = db
      .prepare(
        `SELECT role, created_at_ms, data_json
           FROM local_runtime_message_rows
          WHERE session_id = ?
          ORDER BY id`
      )
      .all(id) as unknown as { role: string | null; created_at_ms: number; data_json: string }[]
    if (!rows.length) {
      const exists = db.prepare('SELECT 1 AS n FROM local_runtime_sessions WHERE session_id = ?').get(id)
      if (!exists) throw new Error('历史会话不存在')
    }
    const messages: TranscriptMessage[] = []
    for (const row of rows) {
      const msg = toMessage(row)
      if (msg) messages.push(msg)
    }
    return { messages, start: 0, end: messages.length, hasMore: false }
  } finally {
    safeClose(db)
  }
}

function toMessage(row: { role: string | null; created_at_ms: number; data_json: string }): TranscriptMessage | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(row.data_json) as Record<string, unknown>
  } catch {
    return null
  }
  const parts: TranscriptPart[] = []
  const thinking = typeof data.thinking_content === 'string' ? data.thinking_content.trim() : ''
  if (thinking) parts.push({ kind: 'thinking', text: thinking })

  const content = typeof data.msg_content === 'string' ? data.msg_content.trim() : ''
  if (content) parts.push({ kind: 'text', text: content })

  const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const c = call as { tool_name?: unknown; tool_call_args?: unknown }
    const name = typeof c.tool_name === 'string' ? c.tool_name : 'tool'
    const input = typeof c.tool_call_args === 'string' ? c.tool_call_args : JSON.stringify(c.tool_call_args ?? {})
    parts.push({ kind: 'tool_use', name, input })
  }
  if (!parts.length) return null

  const ts = Number(row.created_at_ms)
  return {
    role: row.role === 'user' ? 'user' : 'assistant',
    parts,
    timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
  }
}

function safeClose(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
}
