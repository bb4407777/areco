// Hermes 微信会话只读视图（2026-08-04 作业单 A：areco 只读接入微信会话）
//
// 只做一件事：让 areco 座舱「看见」微信会话——只读 Hermes state.db 里的 source='weixin'
// 会话与消息，按 areco transcript 形状（{role,parts[],timestamp}）返回，不改任何本地表。
//
// 纪律（对齐 hermes-studio session-sync.ts 与本仓 hermes-handoff.ts）：
//   - Hermes state.db 永远只读、禁止回填。本服务经 node:sqlite DatabaseSync 的
//     { readOnly: true } 在驱动层强制只读（写尝试抛 SQLITE_READONLY，已实测）；
//   - 只发 SELECT，不 INSERT/UPDATE/DELETE/DDL，不建索引，不 VACUUM；
//   - 微信会话只供查看，不写入 sessions.json、不并入看板卡片绑定（卡片绑定仍归
//     hermes-handoff.ts，且其注释明示「微信 gateway 会话不参与座舱卡片绑定」，本服务
//     与之互补：那边是绑定/交接，这边是纯只读浏览）。
//
// 与 hermes-handoff.ts 的差异（weixin 专属处理，CLI 会话不需要）：
//   - 坑3 tool 消息 content 是 JSON 串 {"output":...,"exit_code":...}，需解包取 output、
//     按 exit_code 判 isError（hermes-handoff 直接把原串当 text）；
//   - 坑4 大量 assistant 消息 content 为空、正文在 tool_calls 里，需展开成 tool_use part；
//   - session_meta 角色丢弃（weixin active 12 条，无 areco 对应概念）。
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import type { TranscriptMessage, TranscriptPage, TranscriptPart } from '../../../shared/protocol'

// DB 路径解析（与 hermes-handoff.ts 的 hermesHomeOf 同口径）：
//   ARECO_WEIXIN_STATE_DB 直指文件 > HERMES_HOME 目录 > 默认 ~/.qclaw-hermes（微信 gateway 实际落盘处）
const STATE_DB =
  process.env.ARECO_WEIXIN_STATE_DB ||
  path.join((process.env.HERMES_HOME && process.env.HERMES_HOME.trim()) || path.join(os.homedir(), '.qclaw-hermes'), 'state.db')

const SOURCE = 'weixin'
const PAGE_MESSAGES = 80 // 与 agent-transcript.ts 同口径：每页消息条数
const MAX_PART_TEXT = 20_000
const MAX_TOOL_TEXT = 2_000

// hermes 会话 id 形如 20260802_104153_57fe8e86：8 位日期 _ 6 位时分秒 _ hex。
// @koa/router 会 decodeURIComponent，必须显式校验，挡掉 ..%2F 之类路径穿越（同 controllers/api.ts SAFE_SEGMENT）。
export const SESSION_ID_RE = /^\d{8}_\d{6}_[0-9a-f]+$/

export interface WeixinSessionSummary {
  id: string
  title: string | null
  model: string | null
  /** epoch 毫秒（state.db 里是浮点秒，×1000） */
  startedAt: number | null
  endedAt: number | null
  endReason: string | null
  /** active 消息条数；= sessions.message_count（≠ 含 compacted 的总行数，见坑1） */
  messageCount: number
  chatId: string | null
  chatType: string | null
  userId: string | null
}

export interface WeixinSessionListPage {
  sessions: WeixinSessionSummary[]
  total: number
  hasMore: boolean
}

/** 只读打开 state.db。gateway 运行中也可读（WAL，实测无锁冲突）。每次调用开/关，不缓存连接。 */
function openDb(): DatabaseSync {
  return new DatabaseSync(STATE_DB, { readOnly: true })
}

/** 列出有消息的微信会话（最近在前）。
 *  坑2：必须 message_count > 0，过滤掉 5 个 session_reset 空壳（message_count=0、model=None、
 *  生命周期仅数秒），否则它们按 started_at 倒序会排在最前。 */
export function listWeixinSessions(opts: { limit?: number; offset?: number; q?: string } = {}): WeixinSessionListPage {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30))
  const offset = Math.max(0, opts.offset ?? 0)
  const q = typeof opts.q === 'string' ? opts.q.trim() : ''
  const db = openDb()
  try {
    const fields =
      'id, title, model, started_at, ended_at, end_reason, message_count, chat_id, chat_type, user_id'
    if (q) {
      const like = `%${q}%`
      // SOURCE 走占位符而非模板插值：当前它是模块常量不构成注入面，但
      // `WHERE ${where}` 这个形状一旦有人往里拼请求值，注入就成立且极难看出（2026-08-04 加固）
      const where = 'source = ? AND message_count > 0 AND (title LIKE ? OR id LIKE ?)'
      const totalRow = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE ${where}`).get(SOURCE, like, like) as
        | { c?: unknown }
        | undefined
      const rows = db
        .prepare(`SELECT ${fields} FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
        .all(SOURCE, like, like, limit + 1, offset) as Array<Record<string, unknown>>
      return pageOf(rows, limit, toCount(totalRow))
    }
    const where = 'source = ? AND message_count > 0'
    const totalRow = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE ${where}`).get(SOURCE) as
      | { c?: unknown }
      | undefined
    const rows = db
      .prepare(`SELECT ${fields} FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(SOURCE, limit + 1, offset) as Array<Record<string, unknown>>
    return pageOf(rows, limit, toCount(totalRow))
  } finally {
    db.close()
  }
}

function pageOf(rows: Array<Record<string, unknown>>, limit: number, total: number): WeixinSessionListPage {
  const hasMore = rows.length > limit // 多取 1 条判断 hasMore，省一次 COUNT
  return { sessions: rows.slice(0, limit).map(toSummary), total, hasMore }
}

/** 单个微信会话的 transcript（消息序号分页，契约同 agent-transcript.ts 的 TranscriptPage）。
 *  坑1：必须 active=1，否则读出 81% 的 compacted 旧上下文（同会话 active 82 行、含 compacted 达 3720 行）。 */
export function readWeixinTranscript(
  sessionId: string,
  opts: { cursor?: number; before?: number } = {},
): TranscriptPage {
  if (!SESSION_ID_RE.test(sessionId)) return { exists: false, messages: [], cursor: 0 }
  const db = openDb()
  try {
    const rows = db
      .prepare(
        `SELECT role, content, tool_name, tool_call_id, tool_calls, timestamp, reasoning_content
           FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`,
      )
      .all(sessionId) as Array<Record<string, unknown>>
    if (!rows.length) return { exists: false, messages: [], cursor: 0 }
    const messages: TranscriptMessage[] = []
    for (const row of rows) {
      const m = toMessage(row)
      if (m) messages.push(m)
    }
    if (!messages.length) return { exists: false, messages: [], cursor: 0 }
    return paginate(messages, opts)
  } finally {
    db.close()
  }
}

/** state.db 消息行 → areco transcript 消息。 */
function toMessage(row: Record<string, unknown>): TranscriptMessage | null {
  const role = typeof row.role === 'string' ? row.role : ''
  const content = typeof row.content === 'string' ? row.content : ''
  const tsSec = Number(row.timestamp)
  const timestamp = Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000).toISOString() : null
  const parts: TranscriptPart[] = []

  if (role === 'user') {
    if (content) parts.push({ kind: 'text', text: clip(content, MAX_PART_TEXT) })
  } else if (role === 'assistant') {
    if (content) parts.push({ kind: 'text', text: clip(content, MAX_PART_TEXT) })
    // 坑4：weixin 有大量 assistant 消息 content 为空（实测 6270 条含 compacted），正文在 tool_calls
    // 里——展开成多条 tool_use part（input 按协议要求是字符串）。
    for (const call of parseJsonArray(typeof row.tool_calls === 'string' ? row.tool_calls : null)) {
      const fn = pickFunction(call)
      parts.push({
        kind: 'tool_use',
        name: String(fn.name ?? 'unknown'),
        input: clip(stringifyArgs(fn.arguments), MAX_TOOL_TEXT),
      })
    }
    if (!parts.length) {
      const reasoning = typeof row.reasoning_content === 'string' ? row.reasoning_content : ''
      if (reasoning) parts.push({ kind: 'text', text: clip('<reasoning> ' + reasoning, MAX_PART_TEXT) })
    }
  } else if (role === 'tool') {
    // 坑5：tool 角色 → areco 里 tool_result 挂在 user 角色下（Anthropic 约定，同 hermes-handoff.ts）。
    // 坑3：tool content 是 JSON 串 {"output":...,"exit_code":...,"error":...}——解包取 output、
    // 按 exit_code 判 isError（exit_code 130 → true；0 → false；带 error → true）。
    const { text, isError } = unpackToolContent(content)
    parts.push({ kind: 'tool_result', text: clip(text, MAX_TOOL_TEXT), isError })
  } else {
    // session_meta 等无 areco 对应概念，丢弃（weixin active 12 条）
    return null
  }

  if (!parts.length) return null
  const transcriptRole: 'user' | 'assistant' = role === 'assistant' ? 'assistant' : 'user'
  return { role: transcriptRole, parts, timestamp }
}

/** 消息序号分页：首载取尾页 / before 向前翻页 / cursor 向前增量。契约对齐 TranscriptPage。 */
function paginate(messages: TranscriptMessage[], opts: { cursor?: number; before?: number }): TranscriptPage {
  const total = messages.length
  if (opts.before !== undefined) {
    const end = Math.max(0, Math.min(opts.before, total))
    const start = Math.max(0, end - PAGE_MESSAGES)
    return { exists: true, messages: messages.slice(start, end), cursor: end, start, hasMore: start > 0 }
  }
  const cursor = Math.max(0, opts.cursor ?? 0)
  if (cursor === 0 || total < cursor) {
    const start = Math.max(0, total - PAGE_MESSAGES)
    return { exists: true, messages: messages.slice(start), cursor: total, start, hasMore: start > 0 }
  }
  return { exists: true, messages: messages.slice(cursor), cursor: total }
}

// ---- 行 → 摘要 / 小工具 ----

function toSummary(r: Record<string, unknown>): WeixinSessionSummary {
  return {
    id: String(r.id ?? ''),
    title: strOrNull(r.title),
    model: strOrNull(r.model),
    startedAt: toMs(r.started_at),
    endedAt: toMs(r.ended_at),
    endReason: strOrNull(r.end_reason),
    messageCount: Number(r.message_count) || 0,
    chatId: strOrNull(r.chat_id),
    chatType: strOrNull(r.chat_type),
    userId: strOrNull(r.user_id),
  }
}

function toMs(v: unknown): number | null {
  const s = Number(v)
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function toCount(row: { c?: unknown } | undefined): number {
  const n = Number(row?.c)
  return Number.isFinite(n) ? n : 0
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** tool_calls 元素可能是 {function:{name,arguments}} 或裸 {name,arguments}，统一取 function 体。 */
function pickFunction(call: unknown): { name?: unknown; arguments?: unknown } {
  if (call && typeof call === 'object') {
    const c = call as { function?: unknown; name?: unknown; arguments?: unknown }
    if (c.function && typeof c.function === 'object') return c.function as { name?: unknown; arguments?: unknown }
    return c
  }
  return {}
}

/** arguments 通常是 JSON 字符串，解析后美化；解析失败或本就是对象则原样字符串化。 */
function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args) as unknown, null, 2)
    } catch {
      return args
    }
  }
  if (args == null) return ''
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** tool content 解包：{"output":...,"exit_code":...,"error":...} → {text, isError}；非 JSON 原串直用。 */
function unpackToolContent(content: string): { text: string; isError: boolean } {
  if (content && content.trimStart().startsWith('{')) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>
      const output = obj.output ?? obj.result
      const text = typeof output === 'string' ? output : output == null ? content : safeStringify(output)
      const ec = obj.exit_code
      const isError = Boolean(obj.error) || (ec !== undefined && ec !== null && ec !== 0)
      return { text: text || content, isError }
    } catch {
      /* 非 JSON 原串直接用 */
    }
  }
  return { text: content, isError: false }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
