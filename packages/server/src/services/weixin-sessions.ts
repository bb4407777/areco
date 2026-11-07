// 微信会话只读视图（数据源：cc-connect 会话存档）
//
// 只做一件事：让 areco 座舱「看见」微信会话——读 ~/.cc-connect/sessions/<agent>_<suffix>.json
// 里 user_sessions 以 weixin: 开头的会话与 history，按 areco transcript 形状
// （{role,parts[],timestamp}）返回，不改任何本地文件。
//
// 数据源沿革（2026-11-07）：原读 ~/.hermes/state.db 的 source='weixin'。Hermes gateway 停用后
// 该库最后一条微信会话停在 2026-10-01（微信入站改由 cc-connect 承接），微信栏因此假死。
// 改读 cc-connect：那边按「一微信号 = 一组 sN 会话」落盘，正好对上本栏「同一段对话被
// session_reset 切成时间片」的展示隐喻，且 history 已是纯 role/content/timestamp，
// 不再有 Hermes 的 tool_calls 解包、active=1 过滤那套坑。
//
// 纪律：
//   - 全程只读，只 readFileSync，不写、不改、不建索引；
//   - 只取 user_sessions 里 weixin: 前缀的会话，其他渠道（sms/telegram…）不混进来；
//   - 会话 id 对外一律 `<agent>:<sN>`（如 CodeBuddy:s696），跨 agent 文件不撞号。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TranscriptMessage, TranscriptPage, TranscriptPart } from '../../../shared/protocol'

// 会话存档目录：ARECO_CC_CONNECT_SESSIONS_DIR 直指目录 > ~/.cc-connect/sessions
const SESSIONS_DIR =
  process.env.ARECO_CC_CONNECT_SESSIONS_DIR?.trim() ||
  path.join(os.homedir(), '.cc-connect', 'sessions')

const WEIXIN_PREFIX = 'weixin:'
const PAGE_MESSAGES = 80 // 与 agent-transcript.ts 同口径：每页消息条数
const MAX_PART_TEXT = 20_000
const TITLE_MAX = 30

// 对外会话 id 形如 CodeBuddy:s696。@koa/router 会 decodeURIComponent，必须显式校验，
// 挡掉 ..%2F 之类路径穿越（本服务不拿 id 拼路径，仍按纪律收窄字符集）。
export const SESSION_ID_RE = /^[A-Za-z0-9_.-]{1,32}:s\d{1,6}$/

export interface WeixinSessionSummary {
  id: string
  title: string | null
  model: string | null
  /** epoch 毫秒 */
  startedAt: number | null
  endedAt: number | null
  endReason: string | null
  /** history 条数 */
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

interface CcHistoryItem {
  role?: unknown
  content?: unknown
  timestamp?: unknown
}

/** cc-connect 单会话（只取本服务用到的字段）。 */
interface CcSession {
  id?: unknown
  name?: unknown
  agent_type?: unknown
  history?: unknown
  created_at?: unknown
  updated_at?: unknown
}

interface CcFile {
  sessions?: unknown
  user_sessions?: unknown
}

/** 归一化后的一条微信消息。 */
interface WxMessage {
  role: 'user' | 'assistant'
  text: string
  /** epoch 毫秒 */
  ts: number | null
}

/** 归一化后的一个微信会话（同一微信号被 session_reset 切开的一段）。 */
interface WxSession {
  id: string
  agent: string
  title: string | null
  chatId: string | null
  chatType: string | null
  userId: string | null
  startedAt: number | null
  endedAt: number | null
  messages: WxMessage[]
}

/** 读全部会话存档文件并归一化成微信会话（最近在前）。 */
function loadSessions(): WxSession[] {
  let files: string[]
  try {
    files = fs.readdirSync(SESSIONS_DIR)
  } catch {
    return [] // 目录不存在（没装 cc-connect / 换机器）：当作没有会话，不抛错
  }
  const out: WxSession[] = []
  for (const file of files) {
    if (!file.endsWith('.json') || file.includes('.bak')) continue
    const agent = file.replace(/_[^_]+\.json$/, '') || file.replace(/\.json$/, '')
    const parsed = readJson(path.join(SESSIONS_DIR, file))
    if (!parsed) continue
    const sessions = asRecord(parsed.sessions)
    if (!sessions) continue
    for (const [chatId, ids] of Object.entries(asRecord(parsed.user_sessions) ?? {})) {
      if (!chatId.startsWith(WEIXIN_PREFIX) || !Array.isArray(ids)) continue
      for (const sid of ids) {
        if (typeof sid !== 'string') continue
        const raw = sessions[sid] as CcSession | undefined
        const s = raw ? normalize(agent, sid, chatId, raw) : null
        if (s) out.push(s)
      }
    }
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

function readJson(file: string): CcFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as CcFile) : null
  } catch {
    return null // 半写坏 / 非本服务文件：跳过，不影响其余
  }
}

function normalize(agent: string, sid: string, chatId: string, raw: CcSession): WxSession | null {
  const history = Array.isArray(raw.history) ? (raw.history as CcHistoryItem[]) : []
  const messages: WxMessage[] = []
  for (const h of history) {
    const role = h?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = typeof h.content === 'string' ? h.content : ''
    if (!text.trim()) continue // 空正文（附件/占位）不成泡，同原 active=1 + 非空过滤
    messages.push({ role, text, ts: parseTime(h.timestamp) })
  }
  if (!messages.length) return null // 无消息的壳会话不显示（同原 message_count > 0）

  const parts = chatId.slice(WEIXIN_PREFIX.length).split(':')
  const chatType = parts[0] || null
  const userId = parts[1] || null
  return {
    id: `${agent}:${sid}`,
    agent,
    title: titleOf(raw.name, messages),
    chatId,
    chatType,
    userId,
    startedAt: parseTime(raw.created_at),
    endedAt: parseTime(raw.updated_at),
    messages,
  }
}

/** 标题：cc-connect 里有 name 就用；没有就取首条用户消息前 30 字。 */
function titleOf(name: unknown, messages: WxMessage[]): string | null {
  if (typeof name === 'string' && name.trim()) return name.trim()
  const first = messages.find((m) => m.role === 'user')
  if (!first) return null
  const oneLine = first.text.replace(/\s+/g, ' ').trim()
  return oneLine ? oneLine.slice(0, TITLE_MAX) : null
}

/** 列出微信会话（最近在前）。q 只搜标题与 id，口径同原 /api/weixin/sessions。 */
export function listWeixinSessions(opts: { limit?: number; offset?: number; q?: string } = {}): WeixinSessionListPage {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 30))
  const offset = Math.max(0, opts.offset ?? 0)
  const q = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : ''
  const all = loadSessions()
  const matched = q
    ? all.filter((s) => s.id.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q))
    : all
  const rows = matched.slice(offset, offset + limit).map(toSummary)
  return { sessions: rows, total: matched.length, hasMore: offset + rows.length < matched.length }
}

function toSummary(s: WxSession): WeixinSessionSummary {
  return {
    id: s.id,
    title: s.title,
    model: s.agent,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    endReason: null,
    messageCount: s.messages.length,
    chatId: s.chatId,
    chatType: s.chatType,
    userId: s.userId,
  }
}

/** 单个微信会话的 transcript（消息序号分页，契约同 agent-transcript.ts 的 TranscriptPage）。 */
export function readWeixinTranscript(
  sessionId: string,
  opts: { cursor?: number; before?: number } = {},
): TranscriptPage {
  if (!SESSION_ID_RE.test(sessionId)) return { exists: false, messages: [], cursor: 0 }
  const s = loadSessions().find((x) => x.id === sessionId)
  if (!s) return { exists: false, messages: [], cursor: 0 }
  const messages: TranscriptMessage[] = s.messages.map((m) => ({
    role: m.role,
    parts: [{ kind: 'text', text: clip(m.text, MAX_PART_TEXT) }] as TranscriptPart[],
    timestamp: m.ts ? new Date(m.ts).toISOString() : null,
  }))
  return paginate(messages, opts)
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

// ---- 跨会话全文搜索 ----

export interface WeixinSearchHit {
  sessionId: string
  sessionTitle: string | null
  sessionStartedAt: number | null
  role: string
  timestamp: number | null
  snippet: string
}

const SEARCH_MAX_Q = 100
const SEARCH_CTX = 60

function snippetOf(text: string, q: string): string {
  const src = text.replace(/\s+/g, ' ').trim()
  if (!src) return ''
  const idx = src.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return src.slice(0, SEARCH_CTX * 2)
  const start = Math.max(0, idx - SEARCH_CTX)
  const end = Math.min(src.length, idx + q.length + SEARCH_CTX)
  return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '')
}

/** 跨会话搜微信对话正文，按消息时间倒序，最多 limit 条。 */
export function searchWeixinMessages(q: string, opts: { limit?: number } = {}): WeixinSearchHit[] {
  const query = q.trim().slice(0, SEARCH_MAX_Q)
  if (!query) return []
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
  const needle = query.toLowerCase()
  const hits: WeixinSearchHit[] = []
  for (const s of loadSessions()) {
    for (const m of s.messages) {
      if (!m.text.toLowerCase().includes(needle)) continue
      hits.push({
        sessionId: s.id,
        sessionTitle: s.title,
        sessionStartedAt: s.startedAt,
        role: m.role,
        timestamp: m.ts,
        snippet: snippetOf(m.text, query),
      })
    }
  }
  return hits.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit)
}

// ---- 小工具 ----

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** ISO 时间串 → epoch 毫秒；非法/缺失返 null。 */
function parseTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) && t > 0 ? t : null
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}
