// weSaw 会话只读视图：weSaw 每个联系人/群工作区都绑一个 agent 会话
//（工作区里的 .agent-session.json → { cli, sessionId }），正文就在该引擎自己的会话文件里。
// 与微信页（读 cc-connect 存档）并列的另一半：这里看的是「weSaw 里跟谁、agent 聊了什么」。
//
// 全部只读：只扫盘 + 读文件，不碰 weSaw 进程、不写任何文件。
// 引擎覆盖：kimi（~/.kimi-code）与 pi（~/.pi）；qoder/codebuddy 的会话布局另算，暂不出现在列表。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { TranscriptMessage } from '../../../shared/protocol'
import { parseKimi, parsePi } from './agent-transcript'

const DOC_ROOT = path.join(os.homedir(), 'Documents', 'weSaw', 'document')
const KIMI_INDEX = path.join(os.homedir(), '.kimi-code', 'session_index.jsonl')
const PI_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions')
/** 单次读盘的正文上限：超了只读尾部（会话文件头部是系统提示，正文都在后面） */
const MAX_READ_BYTES = 20 * 1024 * 1024

export interface WesawSessionRow {
  /** `${cli}:${sessionId}`，正文端点原样带回 */
  id: string
  /** 会话名：工作区 readme 的 name 字段（无则目录名） */
  name: string
  /** 联系人 / 群聊 / 公众号 */
  kind: string
  /** 微信 wxid 或群 id */
  talker: string
  cli: string
  /** 正文文件最后修改时间（毫秒） */
  updatedAt: number
  size: number
}

// ---- 会话文件索引（缓存，按目录 mtime / 文件 mtime 失效）----

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

/** 会话绑定 → 正文文件绝对路径；解析不到返回 null */
function resolveTranscript(cli: string, sessionId: string): string | null {
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
  return null
}

// ---- 会话名（readme frontmatter 的 name）----
// 2677 个工作区，每次请求都读 readme 太贵：按目录 mtime 缓存。
const nameCache = new Map<string, { mtime: number; name: string }>()

function sessionName(dir: string): string {
  const readme = path.join(dir, 'readme.md')
  let st: fs.Stats
  try {
    st = fs.statSync(readme)
  } catch {
    return path.basename(dir)
  }
  const hit = nameCache.get(dir)
  if (hit && hit.mtime === st.mtimeMs) return hit.name
  let name = ''
  try {
    const head = fs.readFileSync(readme, 'utf8').slice(0, 4096)
    const m = /^---\n([\s\S]*?)\n---/.exec(head)
    const fm = m?.[1] ?? ''
    const line = /^name:[ \t]*(.+)$/m.exec(fm)?.[1]?.trim()
    if (line) name = line.replace(/^["']|["']$/g, '')
  } catch {
    // 读不到就退回目录名
  }
  if (!name) name = path.basename(dir)
  nameCache.set(dir, { mtime: st.mtimeMs, name })
  return name
}

// ---- 列表 ----

/** 遍历 document/<kind>/<channel>/<目录> 三层的会话工作区 */
function walkWorkspaces(): Array<{ dir: string; kind: string; talker: string }> {
  const out: Array<{ dir: string; kind: string; talker: string }> = []
  for (const kind of ['contacts', 'groups', 'official']) {
    const kindDir = path.join(DOC_ROOT, kind)
    for (const channel of safeReaddir(kindDir)) {
      const channelDir = path.join(kindDir, channel)
      if (!safeIsDir(channelDir)) continue
      for (const name of safeReaddir(channelDir)) {
        const dir = path.join(channelDir, name)
        if (!safeIsDir(dir)) continue
        if (!fs.existsSync(path.join(dir, '.agent-session.json'))) continue
        out.push({ dir, kind: kindLabel(kind), talker: name })
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

function readBinding(dir: string): { cli: string; sessionId: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.agent-session.json'), 'utf8')) as {
      cli?: string
      sessionId?: string
    }
    if (!raw.cli || !raw.sessionId) return null
    return { cli: raw.cli, sessionId: raw.sessionId }
  } catch {
    return null
  }
}

export interface WesawListPage {
  sessions: WesawSessionRow[]
  total: number
  hasMore: boolean
}

/** 全量扫盘一次约 1.7s（2677 个工作区 + stat 正文）：整表缓存 60s，翻页/搜索都走缓存 */
let listCache: { at: number; rows: WesawSessionRow[] } | null = null
const LIST_TTL_MS = 60_000

function allRows(): WesawSessionRow[] {
  const now = Date.now()
  if (listCache && now - listCache.at < LIST_TTL_MS) return listCache.rows
  const rows: WesawSessionRow[] = []
  for (const ws of walkWorkspaces()) {
    const bind = readBinding(ws.dir)
    if (!bind) continue
    const file = resolveTranscript(bind.cli, bind.sessionId)
    if (!file) continue
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    if (!st.isFile() || st.size === 0) continue
    rows.push({
      id: `${bind.cli}:${bind.sessionId}`,
      name: sessionName(ws.dir),
      kind: ws.kind,
      talker: ws.talker,
      cli: bind.cli,
      updatedAt: Math.round(st.mtimeMs),
      size: st.size,
    })
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  listCache = { at: now, rows }
  return rows
}

/** 列出有正文可读的 weSaw 会话，最近活动在前。q 过滤会话名与 talker。 */
export function listWesawSessions(opts: { limit?: number; offset?: number; q?: string } = {}): WesawListPage {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const q = (opts.q ?? '').trim().toLowerCase()
  const rows = q
    ? allRows().filter((r) => r.name.toLowerCase().includes(q) || r.talker.toLowerCase().includes(q))
    : allRows()
  return { sessions: rows.slice(offset, offset + limit), total: rows.length, hasMore: offset + limit < rows.length }
}

export interface WesawTranscriptPage {
  exists: boolean
  messages: TranscriptMessage[]
  cli?: string
}

/** 读单个 weSaw 会话正文（整段返回；超上限只读尾部）。id 形如 `kimi:session_xxx`。 */
export function readWesawTranscript(id: string): WesawTranscriptPage {
  const sep = id.indexOf(':')
  if (sep <= 0) return { exists: false, messages: [] }
  const cli = id.slice(0, sep)
  const sessionId = id.slice(sep + 1)
  const file = resolveTranscript(cli, sessionId)
  if (!file) return { exists: false, messages: [] }
  let raw: string
  try {
    const st = fs.statSync(file)
    if (st.size > MAX_READ_BYTES) {
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES)
        fs.readSync(fd, buf, 0, MAX_READ_BYTES, st.size - MAX_READ_BYTES)
        raw = buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      raw = raw.slice(raw.indexOf('\n') + 1) // 丢掉被截断的首行
    } else {
      raw = fs.readFileSync(file, 'utf8')
    }
  } catch {
    return { exists: false, messages: [] }
  }
  const messages = cli === 'kimi' ? parseKimi(raw) : cli === 'pi' ? parsePi(raw) : []
  return { exists: true, messages, cli }
}
