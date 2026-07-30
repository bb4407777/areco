// 历史对话浏览：不建索引库，直接扫盘——
// 列表 = 扫 projects/ 只 stat + 封顶头部扫描提元信息（按 path+mtime+size 缓存）；
// 正文 = 字节块从尾部倒序分页，永不整文件灌给手机端。
// 数据源：~/.claude/projects 与 ~/.reasonix/projects（reasonix 是 claude-code 同构，jsonl 同格式）；
// kimi 走本文件原生层（三层布局独立扫描）；codex/workbuddy 等在 chatlog 统一层。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import type { HistoryEntry, HistoryListPage, HistoryTranscriptPage, TranscriptMessage } from '../../../shared/protocol'
import { parseTranscriptLine } from './transcript'
import { parseKimi } from './agent-transcript'
import { chatlogEntries, isChatlogSource } from './chatlog'

// 头部扫描上限：cwd/首条用户输入/首个时间戳都落在文件头部，但 file-history-snapshot
// 行可能很大，给足余量；扫完仍无用户输入且文件更大时不下结论（保留条目、标题走兜底）
const HEAD_SCAN_BYTES = 512 * 1024
// 正文单页字节块；块内无完整行（超长行）时倍增，直到上限
const PAGE_CHUNK_BYTES = 512 * 1024
const PAGE_CHUNK_MAX = 8 * 1024 * 1024

export interface HistoryRoot {
  source: string
  dir: string
}

// 注意：reasonix 的 ~/.reasonix/projects 是 letta 事件格式（sessions/*.events.jsonl），
// 不是 claude transcript，解析不了，故不作为历史源。
export function defaultHistoryRoots(): HistoryRoot[] {
  const roots: HistoryRoot[] = [{ source: 'claude', dir: path.join(os.homedir(), '.claude', 'projects') }]
  // 隔离 HOME 的 claude 分身（如 bin/c5 的 fable）：~/.homes/<name>/.claude/projects，只读不支持恢复。
  // 与 chatlog 统一层的源名（codex 等）冲突的目录名跳过，路由按源名分发不能二义
  const homesRoot = path.join(os.homedir(), '.homes')
  for (const name of safeReaddir(homesRoot)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || roots.some((r) => r.source === name) || isChatlogSource(name)) continue
    const dir = path.join(homesRoot, name, '.claude', 'projects')
    if (fs.existsSync(dir)) roots.push({ source: name, dir })
  }
  return roots
}

/** QClaw 历史源：扫描 ~/.qclaw/agents/main/sessions/ 下的 .jsonl */
function qclawEntries(): HistoryEntry[] {
  const sessDir = path.join(os.homedir(), '.qclaw', 'agents', 'main', 'sessions')
  const entries: HistoryEntry[] = []
  for (const name of safeReaddir(sessDir)) {
    if (!name.endsWith('.jsonl') || name.includes('trajectory') || name === 'sessions.json') continue
    const filePath = path.join(sessDir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0) continue
    const head = readHead(filePath, stat.size)
    const firstLine = head.split('\n')[0]?.trim()
    let title = name.slice(0, -'.jsonl'.length).slice(0, 8)
    let createdMs = stat.birthtimeMs || 0
    if (firstLine) {
      try {
        const obj = JSON.parse(firstLine)
        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
        if (!Number.isNaN(ts)) createdMs = ts
      } catch {
        /* 忽略 */
      }
    }
    entries.push({
      source: 'qclaw',
      project: 'main',
      id: name.slice(0, -'.jsonl'.length),
      title,
      cwd: '',
      mtimeMs: stat.mtimeMs,
      createdMs,
      size: stat.size,
      liveSessionId: null,
      resumable: false,
    })
  }
  return entries
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$|^-[A-Za-z0-9._-]+$/

// ---- kimi 原生层 ----
// kimi 落盘三层布局：~/.kimi-code/sessions/<wd_slug>/session_<uuid>/{state.json, agents/main/wire.jsonl}，
// 塞不进 scanRaw 的 <root>/<project>/<id>.jsonl 两层假设，仿 qclaw 独立扫描 + controller 独立分支。
// state.json 自带 title/workDir/createdAt，列表元信息不碰 wire 正文；agents/agent-N/ 是子代理 wire，不收。
const KIMI_SESSION_ID = /^session_[0-9a-fA-F-]+$/

export function kimiSessionsRoot(): string {
  return path.join(os.homedir(), '.kimi-code', 'sessions')
}

function kimiWireOf(sessionDir: string): string {
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl')
}

interface KimiState {
  title?: unknown
  workDir?: unknown
  createdAt?: unknown
  lastPrompt?: unknown
}

function readKimiState(sessionDir: string): KimiState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')) as KimiState
  } catch {
    return null
  }
}

/** kimi 历史条目：扫 sessions/<wd>/<session_*>；「New Session」是未起题的占位默认值，回退 lastPrompt → id 前 8 位 */
export function kimiEntries(root = kimiSessionsRoot()): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const wd of safeReaddir(root)) {
    const wdDir = path.join(root, wd)
    for (const name of safeReaddir(wdDir)) {
      if (!KIMI_SESSION_ID.test(name)) continue
      const sessionDir = path.join(wdDir, name)
      const wire = kimiWireOf(sessionDir)
      let stat: fs.Stats
      try {
        stat = fs.statSync(wire)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size === 0) continue
      const state = readKimiState(sessionDir)
      const rawTitle =
        typeof state?.title === 'string' && state.title.trim() && state.title !== 'New Session' ? state.title : ''
      const lastPrompt = typeof state?.lastPrompt === 'string' ? state.lastPrompt : ''
      const createdMs = typeof state?.createdAt === 'string' ? Date.parse(state.createdAt) || 0 : 0
      entries.push({
        source: 'kimi',
        project: wd,
        id: name,
        title: promptLabel(rawTitle || lastPrompt) || name.slice(0, 8),
        cwd: typeof state?.workDir === 'string' ? state.workDir : '',
        mtimeMs: stat.mtimeMs,
        createdMs,
        size: stat.size,
        liveSessionId: null,
        resumable: false, // 由 controller 按有无启用的 kimi 模板填
      })
    }
  }
  return entries
}

/** kimi source/project/id → 校验后的 wire.jsonl 绝对路径（防路径穿越） */
export function resolveKimiWire(project: string, id: string, root = kimiSessionsRoot()): string {
  if (!SAFE_SEGMENT.test(project) || project.includes('..')) throw new Error('项目名不合法')
  if (!KIMI_SESSION_ID.test(id)) throw new Error('会话 id 不合法')
  const filePath = kimiWireOf(path.join(root, project, id))
  if (!filePath.startsWith(root + path.sep)) throw new Error('路径不合法')
  if (!fs.existsSync(filePath)) throw new Error('历史会话不存在')
  return filePath
}

/** kimi 会话工作目录：wire 上两级（<sessionDir>/agents/main → <sessionDir>）state.json 的 workDir（恢复要回原 cwd） */
export function kimiWorkDirOf(wirePath: string): string {
  const state = readKimiState(path.join(path.dirname(wirePath), '..', '..'))
  return typeof state?.workDir === 'string' ? state.workDir : ''
}

/** kimi 行解析适配器：wire 每行至多产一条消息（parseKimi 吃多行串，喂单行取首条） */
export function kimiParseLine(line: string): TranscriptMessage | null {
  return parseKimi(line)[0] ?? null
}



interface FileMeta {
  title: string
  cwd: string
  createdMs: number
  hasPrompt: boolean
}

interface RawEntry {
  source: string
  project: string
  id: string
  filePath: string
  mtimeMs: number
  size: number
}

// ---- slash command 信封（<command-name> 等成对标签整段剥除）----

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ENVELOPE =
  /<(command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g

export function promptLabel(raw: string): string {
  const command = COMMAND_NAME.exec(raw)?.[1]?.trim()
  const cleaned = command || raw.replace(COMMAND_ENVELOPE, '').replace(/\s+/g, ' ').trim()
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('\n')
  }
  return ''
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function readHead(filePath: string, size: number): string {
  const bytes = Math.min(size, HEAD_SCAN_BYTES)
  if (bytes <= 0) return ''
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    fs.readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function scanHeadMeta(filePath: string, size: number): FileMeta {
  let cwd = ''
  let createdMs = 0
  let title = ''
  let hasPrompt = false
  for (const line of readHead(filePath, size).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue // 半行/被截断的尾行
    }
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd
    if (!createdMs && typeof row.timestamp === 'string') {
      const ms = Date.parse(row.timestamp)
      if (!Number.isNaN(ms)) createdMs = ms
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle.trim()) {
      title = row.customTitle.trim().slice(0, 80)
      hasPrompt = true
    }
    if (!hasPrompt && row.type === 'user' && row.isMeta !== true && row.isSidechain !== true) {
      const text = userText((row.message as { content?: unknown } | undefined)?.content)
      const label = text ? promptLabel(text) : ''
      if (label) {
        title = label
        hasPrompt = true
      }
    }
    if (cwd && createdMs && hasPrompt) break
  }
  return { title, cwd, createdMs, hasPrompt }
}

/** meta 缓存：mtime+size 一致即命中，历史文件不再重复读头 */
const metaCache = new Map<string, FileMeta & { mtimeMs: number; size: number }>()

function metaFor(entry: RawEntry): FileMeta {
  const hit = metaCache.get(entry.filePath)
  if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) return hit
  let meta: FileMeta
  try {
    meta = scanHeadMeta(entry.filePath, entry.size)
  } catch {
    meta = { title: '', cwd: '', createdMs: 0, hasPrompt: false }
  }
  metaCache.set(entry.filePath, { ...meta, mtimeMs: entry.mtimeMs, size: entry.size })
  return meta
}

function scanRaw(roots: HistoryRoot[]): RawEntry[] {
  const out: RawEntry[] = []
  for (const root of roots) {
    for (const project of safeReaddir(root.dir)) {
      const dir = path.join(root.dir, project)
      for (const name of safeReaddir(dir)) {
        if (!name.endsWith('.jsonl')) continue
        if (name.startsWith('agent-')) continue // 子 agent transcript，不是独立会话
        const filePath = path.join(dir, name)
        let stat: fs.Stats
        try {
          stat = fs.statSync(filePath)
        } catch {
          continue
        }
        if (!stat.isFile() || stat.size === 0) continue
        out.push({
          source: root.source,
          project,
          id: name.slice(0, -'.jsonl'.length),
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        })
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function toEntry(raw: RawEntry, meta: FileMeta): HistoryEntry {
  return {
    source: raw.source,
    project: raw.project,
    id: raw.id,
    title: meta.title || (meta.cwd ? path.basename(meta.cwd) : raw.id.slice(0, 8)),
    cwd: meta.cwd,
    mtimeMs: raw.mtimeMs,
    createdMs: meta.createdMs,
    size: raw.size,
    liveSessionId: null,
    resumable: false, // 由 controller 按「source 的 HOME 有无对应模板」填
  }
}

/** 无用户输入且头部已扫全的会话是空壳（只有 mode/snapshot 元数据行），不进列表 */
function isNoise(raw: RawEntry, meta: FileMeta): boolean {
  return !meta.hasPrompt && raw.size <= HEAD_SCAN_BYTES
}

/**
 * ripgrep 搜 transcript 正文（claude/reasonix 等文件式源），返回命中文件的绝对路径集合。
 * -l 只列文件名、-i 忽略大小写、-F 字面量（防正则元字符）；本地单用户服务，spawnSync 短阻塞可接受。
 * rg 退出码：0=有命中、1=无命中、>1=出错（超时/坏正则）；status===null=被信号终止。
 */
function searchBodyByRg(roots: HistoryRoot[], q: string): Set<string> {
  const needle = q.trim()
  if (!needle) return new Set()
  const dirs = roots.map((r) => r.dir).filter((d) => fs.existsSync(d))
  if (!dirs.length) return new Set()
  try {
    const res = spawnSync('rg', ['-l', '-i', '-F', '--', needle, ...dirs], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (res.error || res.status === null || res.status > 1) return new Set()
    return new Set(res.stdout.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

export function listHistory(
  roots: HistoryRoot[],
  opts: { limit: number; offset: number; q?: string }
): HistoryListPage {
  const raws = scanRaw(roots)
  const q = opts.q?.trim().toLowerCase()
  // q 不止搜标题/cwd/id：用 ripgrep 扫 transcript 正文（claude/reasonix 文件式源），命中文件也纳入。
  // kimi/qclaw/chatlog 各自机制不同，暂仍按元信息搜。
  const bodyHits = q ? searchBodyByRg(roots, opts.q!.trim()) : null

  const matched: HistoryEntry[] = []
  for (const raw of raws) {
    const meta = metaFor(raw)
    if (isNoise(raw, meta)) continue
    if (q) {
      const hay = `${meta.title}\n${meta.cwd}\n${raw.id}`.toLowerCase()
      if (!hay.includes(q) && !bodyHits?.has(raw.filePath)) continue
    }
    matched.push(toEntry(raw, meta))
  }
  // chatlog 统一层：codex/reasonix/cc-connect/workbuddy（claude 走上面的原生路径）
  for (const entry of chatlogEntries()) {
    if (q) {
      const hay = `${entry.title}\n${entry.source}\n${entry.id}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    matched.push(entry)
  }
  // QClaw 原生源：直接扫描 ~/.qclaw/agents/main/sessions/
  for (const entry of qclawEntries()) {
    if (q) {
      const hay = `${entry.title}\n${entry.source}\n${entry.id}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    matched.push(entry)
  }
  // kimi 原生层：扫 ~/.kimi-code/sessions（三层布局，不进 scanRaw）
  for (const entry of kimiEntries()) {
    if (q) {
      const hay = `${entry.title}\n${entry.cwd}\n${entry.id}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    matched.push(entry)
  }
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const entries = matched.slice(opts.offset, opts.offset + opts.limit)
  return { entries, total: matched.length, hasMore: opts.offset + opts.limit < matched.length }
}

/** source/project/id → 校验后的绝对路径；任何一段不合法都抛错（防路径穿越） */
export function resolveHistoryFile(roots: HistoryRoot[], source: string, project: string, id: string): string {
  const root = roots.find((r) => r.source === source)
  if (!root) throw new Error(`历史源不存在: ${source}`)
  if (!SAFE_SEGMENT.test(project) || project.includes('..')) throw new Error('项目名不合法')
  if (!SAFE_SEGMENT.test(id) || id.includes('..')) throw new Error('会话 id 不合法')
  const filePath = path.join(root.dir, project, `${id}.jsonl`)
  if (!filePath.startsWith(root.dir + path.sep)) throw new Error('路径不合法')
  if (!fs.existsSync(filePath)) throw new Error('历史会话不存在')
  return filePath
}

/**
 * 尾部倒序分页：返回 [start,end) 字节区间内的完整行消息。
 * before 缺省 = 文件末尾；下一页传 before=上页 start。行边界规则：
 * 区间起点向后对齐到首个换行符之后（start>0 时），终点对齐到最后一个换行符。
 * parseLine 按源格式换：claude 系用默认 parseTranscriptLine，kimi 传 kimiParseLine。
 */
export function readHistoryPage(
  filePath: string,
  before?: number,
  parseLine: (line: string) => TranscriptMessage | null = parseTranscriptLine
): HistoryTranscriptPage {
  const size = fs.statSync(filePath).size
  const end = Math.max(0, Math.min(before ?? size, size))
  if (end === 0) return { messages: [], start: 0, end: 0, hasMore: false }

  let chunk = PAGE_CHUNK_BYTES
  for (;;) {
    const from = Math.max(0, end - chunk)
    const fd = fs.openSync(filePath, 'r')
    let buf: Buffer
    try {
      buf = Buffer.alloc(end - from)
      fs.readSync(fd, buf, 0, buf.length, from)
    } finally {
      fs.closeSync(fd)
    }

    // 起点对齐：from>0 时首行是上一页的尾巴，跳过（属于更早那页）
    let lineStart = 0
    if (from > 0) {
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        // 整块没有一个换行：单行超过块大小，倍增重读
        if (chunk >= PAGE_CHUNK_MAX || chunk >= end) {
          // 单行超 8MB 仍无换行：放弃解析本块，但绝不能把 end=文件当前 size 返回（客户端拿 end
          // 当增量游标，会把未对齐数据标成已消费）。游标退到块前 from，start=from 让「加载更早」
          // 传 before=from 跳过该超长行、继续向前找完整行（hasMore=true：from 之前确有内容）
          return { messages: [], start: from, end: from, hasMore: true }
        }
        chunk = Math.min(chunk * 2, PAGE_CHUNK_MAX)
        continue
      }
      lineStart = nl + 1
    }
    // 终点对齐：只消费到最后一个换行（防半行；历史文件一般以换行收尾）
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl < lineStart) {
      if (chunk >= PAGE_CHUNK_MAX || chunk >= end) {
        // 块内只剩一条未写完的半截行：不能返回 end=文件当前 size（客户端拿 end 当增量游标，
        // 半截行补全后也读不回，首条消息永久缺失）。end 回退到最后一个完整行边界——
        // from>0 时块内唯一完整行止于 lastNl；from=0（全文件就一条半行）退到 0，
        // 下次轮询/首载即可重新读到补全后的行。start=from 让向前翻页跳过本块继续找完整行
        const boundary = from > 0 ? from + lastNl + 1 : 0
        return { messages: [], start: from, end: boundary, hasMore: from > 0 }
      }
      chunk = Math.min(chunk * 2, PAGE_CHUNK_MAX)
      continue
    }

    const absStart = from + lineStart
    const absEnd = from + lastNl + 1
    const messages = []
    for (const line of buf.subarray(lineStart, lastNl + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      const msg = parseLine(line)
      if (msg) messages.push(msg)
    }
    return { messages, start: absStart, end: absEnd, hasMore: absStart > 0 }
  }
}

/** 全量读取（供跨 agent 交接）：取文件尾部 maxBytes 内的完整行消息；parseLine 同 readHistoryPage */
export function readHistoryAllMessages(
  filePath: string,
  maxBytes = 4 * 1024 * 1024,
  parseLine: (line: string) => TranscriptMessage | null = parseTranscriptLine
): TranscriptMessage[] {
  const size = fs.statSync(filePath).size
  const from = Math.max(0, size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
  } finally {
    fs.closeSync(fd)
  }
  let lineStart = 0
  if (from > 0) {
    const nl = buf.indexOf(0x0a)
    if (nl < 0) return []
    lineStart = nl + 1
  }
  const messages = []
  for (const line of buf.subarray(lineStart).toString('utf8').split('\n')) {
    if (!line.trim()) continue
    const msg = parseLine(line)
    if (msg) messages.push(msg)
  }
  return messages
}

/** 恢复会话所需的落点信息：cwd 从 transcript 头部读（--resume 必须回到原 cwd 才能找到会话） */
export function historyCwd(filePath: string): string {
  const size = fs.statSync(filePath).size
  return scanHeadMeta(filePath, size).cwd
}
