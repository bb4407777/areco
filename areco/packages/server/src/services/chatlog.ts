// chatlog 统一层：把 codex / reasonix / cc-connect / workbuddy 的会话并进历史浏览。
// 各家日志格式互不相同，解析统一交给 chatlog skill 的提取器（全文提取 + 脱敏 + 截断），
// 本服务只读它产出的 conversations-data.json 做展示；claude 会话走本服务原生路径（全文+字节分页），不从这层出。
// kimi 同理：原生层（history.ts kimiEntries）覆盖列表/分页/恢复，故 CHATLOG_SOURCES 不收 kimi——
// 即使提取器产出了 kimi 数据（供 chatlog 看板/MCP 召回），这里也会被过滤掉，避免与原生层重复。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HistoryEntry, HistoryTranscriptPage, TranscriptMessage } from '../../../shared/protocol'
import { createLogger } from '../logger'

const log = createLogger('chatlog')

const DATA_PATH = path.join(os.homedir(), 'skills', 'chatlog', 'conversations-data.json')
// 提取器刷新端点：env ARECO_CHATLOG_REFRESH_URL 显式覆盖；未覆盖时仅当本机确有
// chatlog 数据文件（即装了 chatlog skill，8020 是其标准端口）才启用，否则关闭
const REFRESH_URL =
  process.env.ARECO_CHATLOG_REFRESH_URL ??
  (fs.existsSync(DATA_PATH) ? 'http://127.0.0.1:8020/api/chatlog/refresh' : '')
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000
// 47MB JSON 解析结果只在有人看时驻留，闲置即释放
const FULL_CACHE_IDLE_MS = 3 * 60 * 1000

const CHATLOG_SOURCES = new Set(['codex', 'reasonix', 'cc-connect', 'workbuddy'])

export function isChatlogSource(source: string): boolean {
  return CHATLOG_SOURCES.has(source)
}

interface RawMessage {
  role?: string
  text?: string
  timestamp?: string | number
}

interface RawConv {
  source?: string
  home?: string
  sessionId?: string
  question?: string
  conclusion?: string
  firstTimestamp?: number
  lastTimestamp?: number
  /** 会话原工作目录（提取器 2026-07 起补录；恢复会话用，旧数据可能没有） */
  cwd?: string
  messages?: RawMessage[]
  /** 提取器标记：本条是渠道桥接副本，后端会话（claude/reasonix）有完整版 */
  duplicate_of?: string
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

let indexCache: { mtimeMs: number; size: number; entries: HistoryEntry[] } | null = null
let fullCache: { mtimeMs: number; size: number; convs: RawConv[] } | null = null
let releaseTimer: NodeJS.Timeout | null = null
let lastRefreshAt = 0

function statData(): fs.Stats | null {
  try {
    const stat = fs.statSync(DATA_PATH)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/** 数据超过 10 分钟没更新就异步踢一脚提取器（端点自带锁与去重；服务不在也无妨） */
function maybeTriggerRefresh(stat: fs.Stats) {
  if (!REFRESH_URL) return
  const now = Date.now()
  if (now - stat.mtimeMs < REFRESH_MIN_INTERVAL_MS) return
  if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return
  lastRefreshAt = now
  fetch(REFRESH_URL, { method: 'POST' }).catch(() => {})
}

function loadConvs(stat: fs.Stats): RawConv[] {
  if (fullCache && fullCache.mtimeMs === stat.mtimeMs && fullCache.size === stat.size) {
    bumpRelease()
    return fullCache.convs
  }
  let convs: RawConv[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as { conversations?: unknown }
    if (Array.isArray(parsed.conversations)) {
      convs = (parsed.conversations as RawConv[]).filter((c) => isChatlogSource(String(c?.source ?? '')))
    }
  } catch (err) {
    log.warn('conversations-data.json 解析失败', err)
    return []
  }
  fullCache = { mtimeMs: stat.mtimeMs, size: stat.size, convs }
  bumpRelease()
  return convs
}

function bumpRelease() {
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(() => {
    fullCache = null
  }, FULL_CACHE_IDLE_MS)
  releaseTimer.unref()
}

function titleOf(c: RawConv): string {
  const raw = (c.question || c.conclusion || '').replace(/\s+/g, ' ').trim()
  const title = raw || String(c.sessionId ?? '').slice(0, 8)
  return title.length > 80 ? `${title.slice(0, 79)}…` : title
}

export function chatlogEntries(): HistoryEntry[] {
  const stat = statData()
  if (!stat) return []
  maybeTriggerRefresh(stat)
  if (indexCache && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) {
    return indexCache.entries
  }
  const entries: HistoryEntry[] = []
  for (const c of loadConvs(stat)) {
    const id = String(c.sessionId ?? '')
    if (!SAFE_ID.test(id)) continue
    // 桥接副本不进列表（同一场微信对话渠道/后端各落一份）；数据仍在，按 id 直取不受影响
    if (c.duplicate_of) continue
    // claude 已由原生 scanRaw 覆盖（~/.claude/projects + ~/.homes/* 分身，见 defaultHistoryRoots）；
    // chatlog 不再重复贡献，否则历史列表里同一 claude 会话因 project 字段不同（cwd-slug vs home 名）
    // 前端 key 撞不上，显示成两条。codex/reasonix/workbuddy/cc-connect/kimi 不受影响。
    if (c.source === 'claude') continue
    const messages = Array.isArray(c.messages) ? c.messages : []
    const first = typeof c.firstTimestamp === 'number' ? c.firstTimestamp : 0
    const last = typeof c.lastTimestamp === 'number' ? c.lastTimestamp : first
    entries.push({
      source: String(c.source),
      project: String(c.home || 'main'),
      id,
      title: titleOf(c),
      cwd: typeof c.cwd === 'string' ? c.cwd : '', // 旧数据没有 cwd；codex/workbuddy 恢复要用
      mtimeMs: last || first,
      createdMs: first,
      size: messages.reduce((sum, m) => sum + (typeof m.text === 'string' ? m.text.length : 0), 0),
      liveSessionId: null,
      resumable: false, // 由 controller 按「该源有无对应模板」填（codex/workbuddy 原生 resume 已支持）
    })
  }
  indexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries }
  return entries
}

function findConv(source: string, project: string, id: string): RawConv {
  const stat = statData()
  if (!stat) throw new Error('历史会话不存在（chatlog 数据缺失）')
  const conv = loadConvs(stat).find(
    (c) => String(c.source) === source && String(c.home || 'main') === project && String(c.sessionId) === id
  )
  if (!conv) throw new Error('历史会话不存在')
  return conv
}

/** 单条会话的 cwd（codex/workbuddy 历史恢复要用；旧数据缺省返回空串） */
export function chatlogCwd(source: string, project: string, id: string): string {
  const cwd = findConv(source, project, id).cwd
  return typeof cwd === 'string' ? cwd : ''
}

export function readChatlogTranscript(source: string, project: string, id: string): HistoryTranscriptPage {
  const conv = findConv(source, project, id)
  const messages: TranscriptMessage[] = []
  for (const m of conv.messages ?? []) {
    const text = typeof m.text === 'string' ? m.text.trim() : ''
    if (!text) continue
    const ts = Number(m.timestamp)
    messages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      parts: [{ kind: 'text', text }],
      timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
    })
  }
  // 提取器已按会话截断（实测最大 ~40KB），整段一页返回
  return { messages, start: 0, end: messages.length, hasMore: false }
}
