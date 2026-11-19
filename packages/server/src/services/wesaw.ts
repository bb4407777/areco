// weSaw 会话只读视图：照搬 weSaw 自己的显示口径——
//   左：会话列表＝weSaw 的「最近会话」（app 自带接口 /api/v1/recent_chat，含备注名与最后消息时间）
//   右：agent 对话＝该工作区 project.md 的工作纪要条目 + 引擎会话里尚未入账的助手回复
// 不读微信聊天原文、不展示工作区路径与文件清单（2026-11-19 高律师定）。
//
// 正文统一从 CodeBuddy 会话读（2026-11-19 高律师令「kimi 和 qoder 已经过时很久了，统一用 CodeBuddy」）：
// 绑定仍是 kimi/pi 的老工作区，实际在跑的是 CodeBuddy，按 cwd 取最近一份 CodeBuddy 会话；
// 只有该工作区根本没有 CodeBuddy 会话时才回落老引擎的会话文件。
// 全部只读：只读接口 + 扫盘 + 读文件，不碰 weSaw 进程、不写任何文件。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { TranscriptMessage } from '../../../shared/protocol'
import { parseKimi, parsePi } from './agent-transcript'

const DOC_ROOT = path.join(os.homedir(), 'Documents', 'weSaw', 'document')
const KIMI_INDEX = path.join(os.homedir(), '.kimi-code', 'session_index.jsonl')
const PI_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions')
const CB_ROOT = path.join(os.homedir(), '.codebuddy', 'projects')
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
  /** 绑定里记的引擎名（老工作区多为 kimi/pi），无绑定为空；正文实际按 CodeBuddy 读 */
  cli: string
  /** 最后一条消息摘要（weSaw 会话行第二行，原样取 app 的 summary） */
  summary: string
  /** 二级分类：微信/企业微信、群聊/折叠的群聊、订阅号/服务号 */
  sub: WesawSubKind
  /** 状态灯（与 weSaw 会话行同口径）：busy 红／todo 黄／idle 绿，无工作区为空 */
  agent: '' | 'busy' | 'todo' | 'idle'
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

/** codebuddy：~/.codebuddy/projects/<cwd 非字母数字换横线、去前导横线>/<sessionId>.jsonl */
function cbProjectDir(workspaceDir: string): string {
  const slug = path.resolve(workspaceDir).replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '')
  return path.join(CB_ROOT, slug)
}

function cbSessionFile(workspaceDir: string, sessionId: string): string | null {
  if (!/^[0-9a-f][0-9a-f-]{7,}$/i.test(sessionId)) return null
  const file = path.join(cbProjectDir(workspaceDir), `${sessionId}.jsonl`)
  return fs.existsSync(file) ? file : null
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

interface Resolved {
  file: string | null
  /** 实际读到正文的那一路（旧绑定工作区也会是 codebuddy） */
  cli: string
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 绑定 + 工作区 → 正文文件。正文统一优先 CodeBuddy：绑定是 codebuddy 就认它的 sessionId，
 * 否则取该 cwd 下最近一份 CodeBuddy 会话；老引擎（kimi/pi）只在没有 CodeBuddy 会话、
 * 或老会话比 CodeBuddy 还新时才用。qoder 不再读取（已过时）。
 */
function resolveTranscript(workspaceDir: string, cli: string, sessionId: string): Resolved {
  const cbBound = cli === 'codebuddy' ? cbSessionFile(workspaceDir, sessionId) : null
  const cbFile = cbBound ?? newestJsonl(cbProjectDir(workspaceDir))

  let legacy: string | null = null
  if (cli === 'kimi') {
    const dir = kimiDirs().get(sessionId)
    if (dir) {
      const file = path.join(dir, 'agents', 'main', 'wire.jsonl')
      if (fs.existsSync(file)) legacy = file
    }
  } else if (cli === 'pi') {
    const file = piFiles().get(sessionId)
    if (file && fs.existsSync(file)) legacy = file
  }

  if (cbFile && (!legacy || mtimeOf(cbFile) >= mtimeOf(legacy))) return { file: cbFile, cli: 'codebuddy' }
  if (legacy) return { file: legacy, cli }
  return { file: cbFile, cli: cbFile ? 'codebuddy' : '' }
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

/** 工作区 readme 的 name（frontmatter），按文件 mtime 缓存；无 readme 返回空 */
const readmeNameCache = new Map<string, { mtime: number; name: string }>()

function readmeName(dir: string): string {
  const file = path.join(dir, 'readme.md')
  try {
    const mtime = fs.statSync(file).mtimeMs
    const hit = readmeNameCache.get(dir)
    if (hit && hit.mtime === mtime) return hit.name
    const m = fs.readFileSync(file, 'utf8').slice(0, 2000).match(/^name:\s*(.+)$/m)
    const name = m ? m[1].replace(/^["']|["']$/g, '').trim() : ''
    readmeNameCache.set(dir, { mtime, name })
    return name
  } catch {
    return ''
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
  wechatNickname?: string
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

/** 列表 id（base64url）→ talker；解不出或没有该工作区返回 null */
export function wesawTalkerOf(id: string): string | null {
  let talker = ''
  try {
    talker = Buffer.from(id, 'base64url').toString('utf8')
  } catch {
    return null
  }
  return workspaceDirs().has(talker) ? talker : null
}

/** talker → 工作区绝对路径；没有该工作区返回 null */
export function wesawWorkspaceDir(talker: string): string | null {
  const dir = workspaceDirs().get(talker)
  return dir && safeIsDir(dir) ? dir : null
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
    const nick = (item.m_nsNickName ?? '').trim()
    rows.push({
      id: Buffer.from(talker).toString('base64url'),
      // weSaw 缓存重载期间 recent_chat 的昵称会回填成 id 本身：此时用工作区 readme 的 name
      // 兜底，实在没有才显示 id（2026-11-19 高律师「怎么经常用微信号显示出来」）。
      name: (
        item.remark ||
        item.wechatNickname ||
        (nick && nick !== talker ? nick : '') ||
        (dir ? readmeName(dir) : '') ||
        talker
      ).trim(),
      kind: chatKind(item),
      talker,
      cli: bind.cli,
      updatedAt: (item.lastTimestamp ?? 0) * 1000,
      summary: (item.summary ?? '').trim(),
      sub: subKind(item),
      agent: '',
    })
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  listCache = { at: now, rows }
  return rows
}

// ---- 状态灯（照 weSaw SessionItem 三态：busy 红 > todo 黄 > idle 绿，无工作区不亮）----

/** weSaw 未完成待办：status=open 按 source.wxid / source.talker 汇总（app 每 5 分钟刷新同源） */
const TODOS_FILE = path.join(os.homedir(), 'Documents', 'weSaw', 'todos.json')
let todoIndex: { at: number; byWxid: Map<string, number>; byName: Map<string, number> } | null = null

function todoCounts(): { byWxid: Map<string, number>; byName: Map<string, number> } {
  if (todoIndex && Date.now() - todoIndex.at < 30_000) return todoIndex
  const byWxid = new Map<string, number>()
  const byName = new Map<string, number>()
  try {
    const data = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8')) as {
      items?: Array<{ status?: string; source?: { talker?: string; wxid?: string } }>
    }
    for (const item of data.items ?? []) {
      if (item.status !== 'open') continue
      const wxid = (item.source?.wxid ?? '').trim()
      const name = (item.source?.talker ?? '').trim()
      if (wxid) byWxid.set(wxid, (byWxid.get(wxid) ?? 0) + 1)
      if (name) byName.set(name, (byName.get(name) ?? 0) + 1)
    }
  } catch {
    /* 文件缺失按无待办 */
  }
  todoIndex = { at: Date.now(), byWxid, byName }
  return todoIndex
}

/** 工作区运行锁：.agent-run.lock（{pid, startedAt}），超 20 分钟视为僵锁 */
const RUN_LOCK_NAME = '.agent-run.lock'
const RUN_LOCK_STALE_MS = 20 * 60 * 1000

function agentBusy(dir: string): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, RUN_LOCK_NAME), 'utf8')) as {
      pid?: number
      startedAt?: number
    }
    if (Date.now() - (info.startedAt ?? 0) > RUN_LOCK_STALE_MS) return false
    if (!info.pid) return true
    try {
      process.kill(info.pid, 0)
      return true
    } catch {
      return false
    }
  } catch {
    return false
  }
}

function agentStateOf(row: WesawSessionRow, dir: string | undefined): WesawSessionRow['agent'] {
  if (!dir) return ''
  if (agentBusy(dir)) return 'busy'
  const t = todoCounts()
  if ((t.byWxid.get(row.talker) ?? 0) > 0 || (t.byName.get(row.name) ?? 0) > 0) return 'todo'
  if (fs.existsSync(path.join(dir, '.agent-session.json'))) return 'idle'
  return ''
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
  const dirs = workspaceDirs()
  return {
    sessions: rows
      .slice(offset, offset + limit)
      .map((r) => ({ ...r, agent: agentStateOf(r, dirs.get(r.talker)) })),
    total: rows.length,
    hasMore: offset + limit < rows.length,
    counts,
  }
}

// ---- 正文（weSaw 显示口径：project.md 条目 + 未入账的助手消息）----
// weSaw 把 project.md 的工作纪要条目还原成 assistant 气泡（三种写法并存），
// 会话流水里没写进条目的助手回复补在后面；user 侧照旧走会话流水。

const PROJECT_ENTRY_RE = /^#{2,3}\s+\**\s*(\d{4})[-‑–](\d{2})[-‑–](\d{2})(?:[ T](\d{2}):(\d{2}))?(?::\d{2})?\s*(.*)$/
const PROJECT_BULLET_RE = /^[-*]\s+\**\s*(\d{4})[-‑–](\d{2})[-‑–](\d{2})(?:[ T](\d{2}):(\d{2}))?\s*(.*)$/
const PROJECT_BARE_RE = /^\**\s*(\d{4})[-‑–](\d{2})[-‑–](\d{2})(?:[ T](\d{2}):(\d{2}))?(?::\d{2})?\s*\**\s*[—–：:-]\s*(.*)$/

interface ProjectEntry {
  text: string
  timestamp: number
}

/** project.md → 条目，保持文件序（weSaw 写的时候最新在上，合并时再翻正） */
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
    if (text) entries.push({ text, timestamp: current.time })
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

/** 注入的联系人上下文信封（与 weSaw 同一口径：只留标记后面用户真正说的那句） */
const INJECTED_CONTEXT_RE = /\n\n---\n\n(用户消息|来信提醒|来信补投|每日来信汇总|会话换届交接|建档引导)：/

/** 用户气泡：剥掉 system-reminder 与投喂信封，合成的运行时提示不还原 */
function stripUserText(raw: string): string {
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!text) return ''
  if (/^<(task-notification|notification[\s>]|cron-fire[\s>])/.test(text)) return ''
  const marker = INJECTED_CONTEXT_RE.exec(text)
  if (marker) {
    const body = text.slice(marker.index + marker[0].length).trim()
    text = marker[1] === '用户消息' || !body ? body : `【${marker[1]}】${body}`
  }
  return text
}

type Row = {
  type?: string
  id?: string
  role?: string
  timestamp?: number | string
  content?: unknown
  message?: { role?: string; id?: string; content?: unknown }
}

function rowContent(row: Row): Array<Record<string, unknown>> {
  const raw = row.message?.content ?? row.content
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

function rowTime(row: Row): number {
  const ts = row.timestamp
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/**
 * codebuddy 会话 jsonl：type='message' 行，role 在顶层；
 * user 块是 input_text（带 tool_result 的是工具回包，跳过），assistant 块是 output_text；
 * 同一 message.id 的多帧取末帧（快照会增长）。
 */
function parseCodebuddy(raw: string): TranscriptMessage[] {
  const items: Array<{ key: string; msg: TranscriptMessage }> = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (row.type !== 'message') continue
    const role = (row.role ?? row.message?.role) as string | undefined
    if (role !== 'user' && role !== 'assistant') continue
    const blocks = rowContent(row)
    if (role === 'user' && blocks.some((b) => b?.type === 'tool_result' || b?.type === 'tool_output')) continue
    const text = blocks
      .map((b) => (b?.type === 'output_text' || b?.type === 'input_text' ? String(b.text ?? '') : ''))
      .join('')
      .trim()
    if (!text) continue
    const shown = role === 'user' ? stripUserText(text) : text
    if (!shown) continue
    const ts = rowTime(row)
    const msg = {
      role,
      parts: [{ kind: 'text', text: shown }],
      timestamp: ts ? new Date(ts).toISOString() : null,
    } as unknown as TranscriptMessage
    const key = String(row.message?.id ?? row.id ?? '')
    if (key) {
      const at = items.findIndex((x) => x.key === key)
      if (at >= 0) {
        items[at].msg = msg
        continue
      }
    }
    items.push({ key, msg })
  }
  return items.map((x) => x.msg)
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
 * 合并口径与 weSaw 一致：会话流水的 user 消息 ＋ project.md 条目（翻成旧→新）
 * ＋ 比最新条目更晚、且未被条目覆盖的助手回复，按时间正序排。
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
  const resolved = resolveTranscript(dir, bind.cli, bind.sessionId)
  let session: TranscriptMessage[] = []
  if (resolved.file) {
    try {
      const raw = readRaw(resolved.file)
      session =
        resolved.cli === 'codebuddy'
          ? parseCodebuddy(raw)
          : resolved.cli === 'kimi'
            ? parseKimi(raw)
            : resolved.cli === 'pi'
              ? parsePi(raw)
              : []
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

  const tsOf = (m: TranscriptMessage): number => {
    const iso = (m as unknown as { timestamp?: string | null }).timestamp
    const parsed = iso ? Date.parse(iso) : NaN
    return Number.isNaN(parsed) ? 0 : parsed
  }

  const users = session.filter((m) => m.role === 'user')
  const tail = session.filter((m) => {
    if (m.role !== 'assistant') return false
    const text = messageText(m)
    if (!text) return false
    return tsOf(m) > newestEntryTs && !covered(text)
  })
  const projectMsgs: TranscriptMessage[] = entries
    .slice()
    .reverse()
    .map(
      (e) =>
        ({
          role: 'assistant',
          parts: [{ kind: 'text', text: e.text }],
          timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        }) as unknown as TranscriptMessage
    )

  const messages = [...users, ...projectMsgs, ...tail].sort((a, b) => {
    const ta = tsOf(a) || Number.MAX_SAFE_INTEGER
    const tb = tsOf(b) || Number.MAX_SAFE_INTEGER
    return ta - tb
  })

  return { exists: messages.length > 0, messages, cli: resolved.cli || undefined }
}
