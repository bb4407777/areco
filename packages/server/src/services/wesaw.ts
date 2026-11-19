// weSaw 会话只读视图：照搬 weSaw 自己的显示口径——
//   左：会话列表＝weSaw 的「最近会话」（app 自带接口 /api/v1/recent_chat，含备注名与最后消息时间）
//   右：agent 对话＝该工作区 project.md 的工作纪要条目 + 引擎会话里尚未入账的助手回复
// 不读微信聊天原文、不展示工作区路径与文件清单（2026-11-19 高律师定）。
//
// 引擎绑定存在各工作区 .agent-session.json（{ cli, sessionId }）。qoder 绑定 sessionId 常为空、
// 且每批都是新会话（weSaw 投喂模型），故 qoder 侧取该 cwd 下最近一份会话文件。
// 全部只读：只读接口 + 扫盘 + 读文件，不碰 weSaw 进程、不写任何文件。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { TranscriptMessage } from '../../../shared/protocol'
import { parseKimi, parsePi } from './agent-transcript'

const DOC_ROOT = path.join(os.homedir(), 'Documents', 'weSaw', 'document')
const KIMI_INDEX = path.join(os.homedir(), '.kimi-code', 'session_index.jsonl')
const PI_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions')
const QODER_ROOT = path.join(os.homedir(), '.qoder', 'projects')
/** 单次读盘的正文上限：超了只读尾部 */
const MAX_READ_BYTES = 20 * 1024 * 1024

export interface WesawSessionRow {
  /** 工作区相对路径的 base64url，正文端点原样带回 */
  id: string
  /** 会话名：readme 的 name 字段（无则目录名） */
  name: string
  /** 联系人 / 群聊 / 公众号 */
  kind: string
  /** 微信 wxid、群 id 或公众号 id */
  talker: string
  /** 最近活动时间（毫秒）：project/readme/绑定/会话文件取最大 */
  updatedAt: number
  /** 引擎名（qoder/kimi/pi/codebuddy），无绑定为空 */
  cli: string
  /** 最后一条消息摘要（weSaw 会话行第二行，原样取 app 的 summary） */
  summary: string
  /** 二级分类：微信/企业微信、群聊/折叠的群聊、订阅号/服务号 */
  sub: WesawSubKind
}

/** 二级分类键（与 weSaw 侧栏的二级标签一一对应） */
export type WesawSubKind = 'wechat' | 'wecom' | 'normal' | 'folded' | 'subscription' | 'service'

// ---- 引擎会话文件索引 ----

let kimiIndex: { mtime: number; map: Map<string, string> } | null = null

/** kimi：session_index.jsonl 里 sessionId → sessionDir；正文在 <dir>/agents/main/wire.jsonl */
function kimiDirs(): Map<string, string> {
  try {
    const st = fs.statSync(KIMI_INDEX)
    if (kimiIndex && kimiIndex.mtime === st.mtimeMs) return kimiIndex.map
    const map = new Map<string, string>()
    for (const line of fs.readFileSync(KIMI_INDEX, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { sessionId?: string; sessionDir?: string }
        if (row.sessionId && row.sessionDir) map.set(row.sessionId, row.sessionDir)
      } catch {
        // 坏行跳过
      }
    }
    kimiIndex = { mtime: st.mtimeMs, map }
    return map
  } catch {
    return new Map()
  }
}

let piIndex: { builtAt: number; files: Map<string, string> } | null = null

/** pi：文件名 `<时间戳>_<uuid>.jsonl`，按 uuid 建索引（10 分钟重建一次） */
function piFiles(): Map<string, string> {
  const now = Date.now()
  if (piIndex && now - piIndex.builtAt < 10 * 60_000) return piIndex.files
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(dir, name)
      let st: fs.Stats
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (name.endsWith('.jsonl')) {
        const uuid = name.slice(0, -'.jsonl'.length).split('_').pop()
        if (uuid) files.set(uuid, full)
      }
    }
  }
  walk(PI_ROOT)
  piIndex = { builtAt: now, files }
  return files
}

/** qoder：~/.qoder/projects/<cwd 斜线换横线>/<uuid>.jsonl，同 Claude Code 布局 */
function qoderProjectDir(workspaceDir: string): string {
  return path.join(QODER_ROOT, workspaceDir.replace(/\//g, '-'))
}

function newestJsonl(dir: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best: { m: number; f: string } | null = null
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) continue
      if (!best || st.mtimeMs > best.m) best = { m: st.mtimeMs, f: full }
    } catch {
      // 跳过读不到的
    }
  }
  return best?.f ?? null
}

/** 绑定 + 工作区 → 正文文件绝对路径；解析不到返回 null */
function resolveTranscript(workspaceDir: string, cli: string, sessionId: string): string | null {
  if (cli === 'kimi') {
    const dir = kimiDirs().get(sessionId)
    if (!dir) return null
    const file = path.join(dir, 'agents', 'main', 'wire.jsonl')
    return fs.existsSync(file) ? file : null
  }
  if (cli === 'pi') {
    const file = piFiles().get(sessionId)
    return file && fs.existsSync(file) ? file : null
  }
  if (cli === 'qoder') {
    const dir = qoderProjectDir(workspaceDir)
    if (sessionId) {
      const file = path.join(dir, `${sessionId}.jsonl`)
      if (fs.existsSync(file)) return file
    }
    return newestJsonl(dir)
  }
  return null
}

// ---- 列表 ----

function walkWorkspaces(): Array<{ dir: string; rel: string; kind: string; talker: string }> {
  const out: Array<{ dir: string; rel: string; kind: string; talker: string }> = []
  for (const kind of ['contacts', 'groups', 'official']) {
    const kindDir = path.join(DOC_ROOT, kind)
    for (const channel of safeReaddir(kindDir)) {
      const channelDir = path.join(kindDir, channel)
      if (!safeIsDir(channelDir)) continue
      for (const name of safeReaddir(channelDir)) {
        const dir = path.join(channelDir, name)
        if (!safeIsDir(dir)) continue
        // weSaw 侧栏的会话 = 有绑定或有 readme 的工作区（空壳 stub 不列）
        if (!fs.existsSync(path.join(dir, '.agent-session.json')) && !fs.existsSync(path.join(dir, 'readme.md'))) continue
        out.push({ dir, rel: path.relative(DOC_ROOT, dir), kind: kindLabel(kind), talker: name })
      }
    }
  }
  return out
}

function kindLabel(kind: string): string {
  return kind === 'contacts' ? '联系人' : kind === 'groups' ? '群聊' : '公众号'
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function safeIsDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readBinding(dir: string): { cli: string; sessionId: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.agent-session.json'), 'utf8')) as {
      cli?: string
      sessionId?: string
    }
    return { cli: raw.cli ?? '', sessionId: raw.sessionId ?? '' }
  } catch {
    return { cli: '', sessionId: '' }
  }
}

export interface WesawListPage {
  sessions: WesawSessionRow[]
  total: number
  hasMore: boolean
  /** q 过滤后各分类条数（侧栏标签用；含二级分类） */
  counts: {
    all: number
    contacts: number
    groups: number
    official: number
    wechat: number
    wecom: number
    normal: number
    folded: number
    subscription: number
    service: number
  }
}

let listCache: { at: number; rows: WesawSessionRow[] } | null = null
const LIST_TTL_MS = 60_000
/** weSaw 本地接口（app 主进程起的只读服务） */
const WESAW_API = 'http://127.0.0.1:6131/api/v1'
const WESAW_TOKEN = path.join(os.homedir(), 'skills', 'weSaw', 'data', 'api-token.txt')

interface RecentChat {
  m_nsUsrName?: string
  m_nsNickName?: string
  remark?: string
  type?: string
  isOfficialAccount?: boolean
  lastTimestamp?: number
  summary?: string
  isFolded?: boolean | string
  officialKind?: string
}

function truthy(v: unknown): boolean {
  return v === true || v === 'True' || v === 'true' || v === 1
}

function subKind(item: RecentChat): WesawSubKind {
  const kind = chatKind(item)
  if (kind === '群聊') return truthy(item.isFolded) ? 'folded' : 'normal'
  if (kind === '公众号') return item.officialKind === 'service' ? 'service' : 'subscription'
  return (item.m_nsUsrName ?? '').toLowerCase().endsWith('@openim') ? 'wecom' : 'wechat'
}

/** 会话 talker（wxid / 群 id / 公众号 id）→ 工作区目录，weSaw 的目录名就是 talker */
let dirIndex: { at: number; map: Map<string, string> } | null = null

function workspaceDirs(): Map<string, string> {
  const now = Date.now()
  if (dirIndex && now - dirIndex.at < LIST_TTL_MS) return dirIndex.map
  const map = new Map<string, string>()
  for (const ws of walkWorkspaces()) map.set(ws.talker, ws.dir)
  dirIndex = { at: now, map }
  return map
}

/** weSaw 自带「最近会话」清单：备注名、最后消息时间、类型都由 app 给，不自己扫盘排 */
async function fetchRecentChats(): Promise<RecentChat[]> {
  const token = fs.readFileSync(WESAW_TOKEN, 'utf8').trim()
  const res = await fetch(`${WESAW_API}/recent_chat?limit=5000`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`weSaw recent_chat ${res.status}`)
  const body = (await res.json()) as { items?: RecentChat[] }
  return body.items ?? []
}

function chatKind(item: RecentChat): string {
  if (item.type === 'group' || (item.m_nsUsrName ?? '').endsWith('@chatroom')) return '群聊'
  return item.isOfficialAccount ? '公众号' : '联系人'
}

async function allRows(): Promise<WesawSessionRow[]> {
  const now = Date.now()
  if (listCache && now - listCache.at < LIST_TTL_MS) return listCache.rows
  const dirs = workspaceDirs()
  const rows: WesawSessionRow[] = []
  for (const item of await fetchRecentChats()) {
    const talker = item.m_nsUsrName ?? ''
    if (!talker) continue
    const dir = dirs.get(talker)
    const bind = dir ? readBinding(dir) : { cli: '', sessionId: '' }
    rows.push({
      id: Buffer.from(talker).toString('base64url'),
      name: (item.remark || item.m_nsNickName || talker).trim(),
      kind: chatKind(item),
      talker,
      cli: bind.cli,
      updatedAt: (item.lastTimestamp ?? 0) * 1000,
      summary: (item.summary ?? '').trim(),
      sub: subKind(item),
    })
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  listCache = { at: now, rows }
  return rows
}

/**
 * 列出 weSaw 最近会话（app 清单口径），最近活动在前。
 * q 过滤会话名与 talker；kind 按 weSaw 侧栏分类过滤（联系人／群聊／公众号）。
 * counts 是 q 过滤后各分类的条数，供侧栏分类标签显示。
 */
export async function listWesawSessions(
  opts: { limit?: number; offset?: number; q?: string; kind?: string; sub?: string } = {}
): Promise<WesawListPage> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 2000)
  const offset = Math.max(opts.offset ?? 0, 0)
  const q = (opts.q ?? '').trim().toLowerCase()
  const kind = (opts.kind ?? '').trim()
  const sub = (opts.sub ?? '').trim()
  const all = await allRows()
  const matched = q
    ? all.filter((r) => r.name.toLowerCase().includes(q) || r.talker.toLowerCase().includes(q))
    : all
  const counts: WesawListPage['counts'] = {
    all: matched.length,
    contacts: 0,
    groups: 0,
    official: 0,
    wechat: 0,
    wecom: 0,
    normal: 0,
    folded: 0,
    subscription: 0,
    service: 0,
  }
  for (const r of matched) {
    if (r.kind === '群聊') counts.groups += 1
    else if (r.kind === '公众号') counts.official += 1
    else counts.contacts += 1
    counts[r.sub] += 1
  }
  let rows = kind ? matched.filter((r) => r.kind === kind) : matched
  if (sub) rows = rows.filter((r) => r.sub === sub)
  return {
    sessions: rows.slice(offset, offset + limit),
    total: rows.length,
    hasMore: offset + limit < rows.length,
    counts,
  }
}

// ---- 正文（weSaw 显示口径：project.md 条目 + 未入账的助手消息）----
// weSaw 把 project.md 的工作纪要条目还原成 assistant 气泡（三种写法并存），
// 会话流水里没写进条目的助手回复补在后面；投喂用的微信批次是「聊天记录」，不展示。

const PROJECT_ENTRY_RE = /^#{2,3}\s+\**\s*(\d{4})[-‑–](\d{2})[-‑–](\d{2})(?:[ T](\d{2}):(\d{2}))?(?::\d{2})?\s*(.*)$/
const PROJECT_BULLET_RE = /^[-*]\s+\**\s*(\d{4})[-‑–](\d{2})[-‑–](\d{2})(?:[ T](\d{2}):(\d{2}))?\s*(.*)$/
const PROJECT_BARE_RE = /^\**\s*(\d{4})[-‑–](\d{2})[-‑–](\d{2})(?:[ T](\d{2}):(\d{2}))?(?::\d{2})?\s*\**\s*[—–：:-]\s*(.*)$/

interface ProjectEntry {
  text: string
  timestamp: number
}

/** 老工作区的 project.md 常是聊天逐条摘录（「- 2026-05-26 23:16 我方：…」）——
 *  那不是 agent 对话，是聊天记录，一律不进右栏（2026-11-19 高律师定）。 */
const CHAT_DIGEST_LINE = /^\s*[-*]?\s*\d{4}[-‑–]\d{2}[-‑–]\d{2}[^：:]{0,16}[：:]\s*(对方|我方)/

function isChatDigest(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim())
  if (!lines.length) return false
  const hits = lines.filter((l) => CHAT_DIGEST_LINE.test(l)).length
  return hits / lines.length >= 0.5
}

function parseProjectEntries(dir: string): ProjectEntry[] {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(dir, 'project.md'), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split(/\r?\n/)
  const matcher = lines.some((l) => PROJECT_ENTRY_RE.test(l))
    ? PROJECT_ENTRY_RE
    : lines.some((l) => PROJECT_BULLET_RE.test(l))
      ? PROJECT_BULLET_RE
      : PROJECT_BARE_RE
  const entries: ProjectEntry[] = []
  let current: { lines: string[]; time: number } | null = null
  const flush = () => {
    if (!current) return
    const text = current.lines.join('\n').trim()
    if (text && !isChatDigest(text)) entries.push({ text, timestamp: current.time })
  }
  for (const line of lines) {
    const hit = matcher.exec(line)
    if (!hit) {
      if (current) current.lines.push(line)
      continue
    }
    flush()
    const parsed = new Date(
      Number(hit[1]),
      Number(hit[2]) - 1,
      Number(hit[3]),
      hit[4] ? Number(hit[4]) : 0,
      hit[5] ? Number(hit[5]) : 0
    ).getTime()
    current = { lines: [line.trim()], time: Number.isFinite(parsed) ? parsed : 0 }
  }
  flush()
  return entries
}

/** qoder 会话 jsonl：message.role + content[].text，工具块丢弃 */
function parseQoder(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const role = row.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = row.message?.content
    const texts: string[] = []
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          const t = (part as { text?: string }).text
          if (t) texts.push(t)
        }
      }
    }
    const text = texts.join('\n').trim()
    if (!text) continue
    out.push({
      role,
      parts: [{ kind: 'text', text }],
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
    } as TranscriptMessage)
  }
  return out
}

function readRaw(file: string): string {
  const st = fs.statSync(file)
  if (st.size <= MAX_READ_BYTES) return fs.readFileSync(file, 'utf8')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES)
    fs.readSync(fd, buf, 0, MAX_READ_BYTES, st.size - MAX_READ_BYTES)
    const raw = buf.toString('utf8')
    return raw.slice(raw.indexOf('\n') + 1) // 丢掉被截断的首行
  } finally {
    fs.closeSync(fd)
  }
}

function isFeedPrompt(text: string): boolean {
  return text.startsWith('【微信消化') || text.includes('<wechat_msg_material>') || text.length > 1200
}

function messageText(m: TranscriptMessage): string {
  const parts = (m as unknown as { parts?: Array<{ kind?: string; text?: string }> }).parts ?? []
  return parts
    .filter((p) => p.kind === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n')
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()

export interface WesawTranscriptPage {
  exists: boolean
  messages: TranscriptMessage[]
  cli?: string
}

/**
 * 读一个 weSaw 会话的 agent 对话。id = talker（wxid / 群 id / 公众号 id）的 base64url。
 * 顺序：project.md 条目（旧→新）＋ 比最新条目更晚、且未被条目覆盖的助手回复。
 */
export function readWesawTranscript(id: string): WesawTranscriptPage {
  let talker: string
  try {
    talker = Buffer.from(id, 'base64url').toString('utf8')
  } catch {
    return { exists: false, messages: [] }
  }
  const dir = workspaceDirs().get(talker)
  if (!dir || !safeIsDir(dir)) return { exists: false, messages: [] }

  const bind = readBinding(dir)
  const file = bind.cli ? resolveTranscript(dir, bind.cli, bind.sessionId) : null
  let session: TranscriptMessage[] = []
  if (file) {
    try {
      const raw = readRaw(file)
      session =
        bind.cli === 'kimi' ? parseKimi(raw) : bind.cli === 'pi' ? parsePi(raw) : bind.cli === 'qoder' ? parseQoder(raw) : []
    } catch {
      session = []
    }
  }

  const entries = parseProjectEntries(dir)
  const entryBlob = entries.map((e) => normalize(e.text)).join('\n')
  const covered = (text: string): boolean => {
    const t = normalize(text)
    if (t.length < 40) return false
    return entryBlob.includes(t.slice(0, 40)) || entryBlob.includes(t.slice(-40))
  }
  const newestEntryTs = entries.reduce((max, e) => Math.max(max, e.timestamp), 0)
  const tail = session.filter((m) => {
    if (m.role !== 'assistant') return false
    const text = messageText(m)
    if (!text || isFeedPrompt(text)) return false
    const ts = m.timestamp ? Date.parse(m.timestamp) : 0
    return ts > newestEntryTs && !covered(text)
  })

  const messages: TranscriptMessage[] = []
  for (const e of entries) {
    messages.push({
      role: 'assistant',
      parts: [{ kind: 'text', text: e.text }],
      timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : null,
    })
  }
  for (const m of tail) messages.push(m)

  return { exists: messages.length > 0, messages, cli: bind.cli || undefined }
}
