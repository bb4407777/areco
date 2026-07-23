// 非 claude 系 agent 的座舱对话视图：直读各 agent 自己的会话落盘——
// 不解析终端流，去 agent 的数据层拿结构化对话。
//   codex     ~/.codex/sessions/YYYY/MM/DD/rollout-<本地时间>-<uuid>.jsonl（response_item 流）
//   workbuddy ~/.workbuddy/projects/<cwd-slug>/<uuid>.jsonl（message/reasoning/function_call 行）
//   reasonix  ~/.reasonix/sessions/*.events.jsonl（每行 type=replace 全量帧，尾行即全量对话）
// 会话文件 ↔ 座舱 pty 的关联：首次由首条输入哈希/旧交接档案标题确定，随后把原生 session id
// 持久化到 sessions.json；日常读取只认该映射，不再按时间猜。
//   qclaw     ~/.qclaw/agents/main/sessions/<uuid>.jsonl（type=message 行，role=user/assistant/toolResult）
//   kimi      ~/.kimi-code/sessions/<wd_xxx>/session_<uuid>/agents/main/wire.jsonl
//             （turn.prompt/steer 用户输入 + context.append_loop_event 事件流；标题在同会话目录 state.json）
// 游标语义：消息序号（claude 路径是字节）——两者对客户端都是不透明的单调游标；
// reasonix 的 replace 帧可能整体收缩，total < cursor 时回尾页（带 start，客户端按整页替换）。
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type { TranscriptMessage, TranscriptPage, TranscriptPart } from '../../../shared/protocol'
import { trafficStateFromMessages, type TrafficState } from '../../../shared/traffic'
import type { Session } from './session'
import { cwdToSlug } from './transcript'
import { createLogger } from '../logger'
import { DATA_DIR } from '../config'

const log = createLogger('agent-transcript')

const PAGE_MESSAGES = 80
const MAX_PART_TEXT = 20_000
const MAX_TOOL_TEXT = 2_000
const MAX_META_LINE_BYTES = 1024 * 1024
const HANDOFF_DIR = path.join(DATA_DIR, 'handoff')
// 会话启动到 agent 建文件的宽限（agent 初始化有延迟；时钟粒度留余量）
const BIRTH_SLACK_MS = 60_000

export type AgentKind = 'codex' | 'workbuddy' | 'reasonix' | 'qclaw' | 'kimi'

export function agentKindOf(command: string): AgentKind | null {
  const base = path.basename(command)
  if (base === 'codex') return 'codex'
  if (base === 'codebuddy') return 'workbuddy'
  if (base === 'reasonix') return 'reasonix'
  if (base === 'kimi') return 'kimi'
  if (base.startsWith('qclaw')) return 'qclaw'
  if (base === 'hermes') return 'qclaw'
  return null
}

// ---- 会话文件定位 ----

interface Located {
  path: string
}

const locateCache = new Map<string, Located>()

/**
 * 占用闸提供者（2026-07-22 幽灵卡根治）：由 SessionManager 构造时注册。
 * locate 有两类调用方——trafficSource 显式传 occupied；transcript 读取
 * （readAgentTranscript/readAgentTrafficState） historically 不传，形成
 * "traffic 有闸、读取无闸"双轨：读取路径照样能把别人的文件绑到本卡并锁进缓存。
 * 注册后 locate 全路径统一套闸（显式参数优先，provider 兜底）。
 */
type OccupiedCheck = (nativeId: string) => boolean
let occupancyProvider: ((sessionId: string) => OccupiedCheck | undefined) | null = null
export function registerOccupancyProvider(provider: (sessionId: string) => OccupiedCheck | undefined): void {
  occupancyProvider = provider
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(suffix))
      .map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

/**
 * 只收集生命周期窗口内候选。绑定优先级：原生 session id → 首条输入哈希 →
 * 旧会话“卡片名 = 首条用户消息标题”唯一一致（均先本 epoch 窗口再全生命周期）→
 * 本 epoch 窗口内唯一非空文件兜底（启动竞态吞字会让内容证据全灭，见 bindFromPools）。
 */
function sessionFileCandidates(
  files: string[],
  startedAt: number,
  exitedAt: number | null
): string[] {
  const inWindow: Array<{ f: string; birth: number; size: number }> = []
  for (const f of files) {
    const st = statSafe(f)
    if (!st) continue
    const birth = st.birthtimeMs || st.mtimeMs
    if (birth < startedAt - BIRTH_SLACK_MS) continue
    if (exitedAt !== null && birth > exitedAt + BIRTH_SLACK_MS) continue
    inWindow.push({ f, birth, size: st.size })
  }
  const nonEmpty = inWindow.filter((x) => x.size > 0)
  const pool = nonEmpty.length ? nonEmpty : inWindow
  pool.sort((a, b) => a.birth - b.birth)
  return pool.map((x) => x.f)
}

/**
 * 当前 epoch 与整个卡片生命周期候选去重。这里只枚举，不决定归属。
 */
function candidatesWithEpochFallback(
  files: string[],
  session: Session,
  exitedAt: number | null
): string[] {
  return [
    ...new Set([
      ...sessionFileCandidates(files, session.startedAt ?? session.createdAt, exitedAt),
      ...sessionFileCandidates(files, session.createdAt, exitedAt),
    ]),
  ]
}

function codexDayDirs(startedAt: number): string[] {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const dirs: string[] = []
  for (const offset of [-1, 0, 1]) {
    const d = new Date(startedAt + offset * 86_400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    dirs.push(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
  }
  return [...new Set(dirs)]
}

function readFirstLine(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < MAX_META_LINE_BYTES) {
      const size = Math.min(16 * 1024, MAX_META_LINE_BYTES - offset)
      const buf = Buffer.allocUnsafe(size)
      const n = fs.readSync(fd, buf, 0, size, offset)
      if (n <= 0) break
      const chunk = buf.subarray(0, n)
      const newline = chunk.indexOf(0x0a)
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk)
      offset += newline >= 0 ? newline : n
      if (newline >= 0) break
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** codex rollout 首行 session_meta；新版首行含完整 instructions，常超过 4KB。 */
export function codexMeta(file: string): { cwd?: string; session_id?: string; id?: string } {
  try {
    const meta = JSON.parse(readFirstLine(file)) as {
      type?: string
      payload?: { cwd?: string; session_id?: string; id?: string }
    }
    return meta.type === 'session_meta' ? (meta.payload ?? {}) : {}
  } catch {
    return {}
  }
}

function codexMetaCwd(file: string): string {
  return codexMeta(file).cwd ?? ''
}

/** codex 原生恢复用：定位到的 rollout 文件 → 其内部 session id */
export function codexSessionIdOf(file: string): string {
  const meta = codexMeta(file)
  return meta.session_id || meta.id || ''
}

export function locateAgentFile(
  session: Session,
  kind: AgentKind,
  occupied?: (nativeId: string) => boolean,
): string | null {
  return locate(session, kind, occupied)
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function bindingHash(text: string): string {
  return crypto.createHash('sha256').update(normalized(text)).digest('hex')
}

function firstUserText(file: string, kind: AgentKind): string {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const messages =
      kind === 'codex'
        ? parseCodex(raw)
        : kind === 'workbuddy'
          ? parseWorkbuddy(raw)
          : kind === 'reasonix'
            ? parseReasonix(raw)
            : kind === 'kimi'
              ? parseKimi(raw)
              : parseQclaw(raw)
    const first = messages.find((m) => m.role === 'user')
    return (
      first?.parts
        .filter((part): part is Extract<TranscriptPart, { kind: 'text' }> => part.kind === 'text')
        .map((part) => part.text)
        .join('\n') ?? ''
    )
  } catch {
    return ''
  }
}

/** kimi 原生恢复用（`-S <id>`）：wire.jsonl 路径里的 session_<uuid>（basename 只会得到 "wire"） */
export function kimiSessionIdOf(file: string): string {
  return /(session_[0-9a-fA-F-]+)/.exec(file)?.[1] ?? ''
}

function nativeSessionId(file: string, kind: AgentKind): string {
  if (kind === 'codex') return codexSessionIdOf(file)
  if (kind === 'reasonix') return path.basename(file, '.events.jsonl')
  if (kind === 'kimi') return kimiSessionIdOf(file)
  return path.basename(file, '.jsonl')
}

function uniqueAgentFiles(files: string[], kind: AgentKind): string[] {
  const seen = new Set<string>()
  return files.filter((file) => {
    const key = nativeSessionId(file, kind) || file
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function workbuddyTitle(raw: string): string {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as { type?: string; aiTitle?: unknown }
      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') return normalized(obj.aiTitle)
    } catch {
      continue
    }
  }
  return ''
}

/** kimi 会话标题：wire.jsonl 上两级目录（<sessionDir>/agents/main → <sessionDir>）state.json 的
 *  自动标题；「New Session」是未起题的占位默认值，视为无标题 */
export function kimiTitleOf(file: string): string {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(path.dirname(file), '..', '..', 'state.json'), 'utf8')
    ) as { title?: unknown }
    const title = typeof state.title === 'string' ? state.title : ''
    return title === 'New Session' ? '' : normalized(title)
  } catch {
    return ''
  }
}

function agentFileTitle(file: string, kind: AgentKind): string {
  if (kind === 'workbuddy') {
    try {
      return workbuddyTitle(fs.readFileSync(file, 'utf8'))
    } catch {
      return ''
    }
  }
  if (kind === 'kimi') return kimiTitleOf(file)
  return ''
}

function titleMatchKey(text: string): string {
  return normalized(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/技能/g, 'skill')
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

export function legacyAgentTitleMatches(sessionName: string, agentTitle: string): boolean {
  const sessionKey = titleMatchKey(sessionName.replace(/…$/, ''))
  return sessionKey.length >= 4 && sessionKey === titleMatchKey(agentTitle)
}

function exactAgentFile(session: Session, kind: AgentKind, files: string[]): string | null {
  if (!session.agentSessionId) return null
  // codex/kimi 的文件名都不是原生 id（rollout 时间戳 / 固定 wire.jsonl），按文件内/路径里的原生 id 比对
  if (kind === 'codex' || kind === 'kimi') {
    return files.find((file) => nativeSessionId(file, kind) === session.agentSessionId) ?? null
  }
  const suffix = kind === 'reasonix' ? '.events.jsonl' : '.jsonl'
  return files.find((file) => path.basename(file, suffix) === session.agentSessionId) ?? null
}

export function handoffTitleFromPrompt(text: string): string {
  const embedded = /完整记录（来自\s+(.+?)），读完/.exec(text)?.[1]
  if (embedded) return normalized(embedded)

  const match = /^先读\s+(.+?)\s+——/.exec(text)
  if (!match) return ''
  const file = path.resolve(match[1])
  if (path.dirname(file) !== HANDOFF_DIR || path.extname(file) !== '.md') return ''
  try {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 12)
    const title = head.find((line) => line.startsWith('- 标题：'))
    return normalized(title?.slice('- 标题：'.length) ?? '')
  } catch {
    return ''
  }
}

/** bindFromPools/evidenceMatch 需要的最小会话面（测试注入字面量即可，绕开 Session 的 node-pty/xterm 依赖） */
export interface BindingTarget {
  id: string
  name: string
  agentBindingHash: string | null
  bindAgentSession(id: string): void
}

/** 单池证据匹配：输入哈希唯一命中；无哈希时接受原生标题或首条用户消息与卡片名一致 */
function evidenceMatch(session: BindingTarget, kind: AgentKind, candidates: string[]): string | null {
  // 同证据强度多候选（反复恢复失败留下的同名复读文件）取最近写入的——用户要续的是最后一次同名对话；
  // 时间只用于在证据并列时打破平局，无证据纯凭时间的候选仍一律不绑
  const latestOf = (files: string[]): string =>
    files.reduce((a, b) => ((statSafe(a)?.mtimeMs ?? 0) >= (statSafe(b)?.mtimeMs ?? 0) ? a : b))
  const byPromptHash = session.agentBindingHash
    ? candidates.filter((file) => {
        const text = firstUserText(file, kind)
        return text !== '' && bindingHash(text) === session.agentBindingHash
      })
    : []
  if (byPromptHash.length >= 1) return latestOf(byPromptHash)

  // 旧数据没有输入哈希：仅接受原生标题或首条用户消息明确一致的候选。
  if (session.agentBindingHash) return null
  const name = normalized(session.name).replace(/…$/, '')
  const byAgentTitle = candidates.filter((file) => legacyAgentTitleMatches(name, agentFileTitle(file, kind)))
  if (byAgentTitle.length >= 1) return latestOf(byAgentTitle)

  const byLegacyName = candidates.filter((file) => {
    const text = normalized(firstUserText(file, kind))
    const handoffTitle = handoffTitleFromPrompt(text)
    return name.length >= 4 && (text === name || text.startsWith(name) || handoffTitle === name)
  })
  return byLegacyName.length >= 1 ? latestOf(byLegacyName) : null
}

/**
 * 池匹配（绑定副作用在此）：顺序 ① 本 epoch 窗口证据 ② 本 epoch 窗口唯一非空文件兜底
 * ③ 全生命周期证据（同名复读文件并列时取最近写入）——恢复语义是「续上最后一次运行」，
 * 所以窗口内唯一非空文件优先于旧运行留下的标题证据；窗口漂移/占位文件被清理时落到 ③。
 *
 * 占用过滤（2026-07-22 幽灵卡根治）：已被另一活会话占用的底层文件一律不进池。
 * 同 cwd 秒级连开两个同类 agent 时，后启动者的 wire 文件常尚未落盘，窗口内唯一候选
 * 是前者的文件——不过滤就会被「唯一候选兜底」抢走，卡片接着读别人的 transcript
 * 并被 session-namer 改名成幽灵卡（kimi 双会话 37s 连开实锤）。过滤后后启动者
 * 返回 null 不锁缓存，等自己的文件落盘后重扫即可正确绑定。
 */
export function bindFromPools(
  session: BindingTarget,
  kind: AgentKind,
  epochPool: string[],
  lifetimePool: string[],
  occupied?: (nativeId: string) => boolean,
): string | null {
  if (occupied) {
    const free = (pool: string[]) =>
      pool.filter((file) => {
        const id = nativeSessionId(file, kind)
        return !id || !occupied(id)
      })
    epochPool = free(epochPool)
    lifetimePool = free(lifetimePool)
  }
  let matched = evidenceMatch(session, kind, epochPool)

  if (!matched && epochPool.length === 1) {
    const only = epochPool[0]
    if ((statSafe(only)?.size ?? 0) > 0) {
      matched = only
      log.info(`按 epoch 窗口唯一候选兜底匹配 ${kind} ${session.id.slice(0, 8)} → ${path.basename(only)}`)
    }
  }

  if (!matched) matched = evidenceMatch(session, kind, lifetimePool)

  if (!matched) return null
  const nativeId = nativeSessionId(matched, kind)
  if (!nativeId) return null
  if (occupied?.(nativeId)) {
    // 竞态安全网：池已按占用预过滤，走到这说明文件在过滤后被另一会话抢走。
    // 不绑也不读——返回 null 让下轮重扫，绝不把别人的 transcript 挂到本卡上
    // （旧行为"返回文件供读取"正是幽灵卡/幽灵命名的来源，2026-07-22 移除）。
    log.warn(
      `占用冲突：${kind} 会话 ${session.id.slice(0, 8)} 想绑底层会话 ${nativeId.slice(0, 8)}，但已被另一活会话占用——跳过本轮，待重扫`,
    )
    return null
  }
  session.bindAgentSession(nativeId)
  log.info(`绑定 ${kind} 会话 ${session.id.slice(0, 8)} ↔ ${nativeId}`)
  return matched
}

function bindCandidate(
  session: Session,
  kind: AgentKind,
  files: string[],
  occupied?: (nativeId: string) => boolean,
): string | null {
  const exact = exactAgentFile(session, kind, files)
  if (exact) {
    // 精确恢复同样守占用闸：目标底层会话已被另一活会话占用时返回 null（待重扫/人工处理），
    // 否则两张活卡会同读一份 transcript，重演幽灵卡。
    const exactId = nativeSessionId(exact, kind)
    if (exactId && occupied?.(exactId)) {
      log.warn(
        `占用冲突：${kind} 会话 ${session.id.slice(0, 8)} 精确恢复的底层会话 ${exactId.slice(0, 8)} 已被另一活会话占用——跳过本轮`,
      )
      return null
    }
    return exact
  }

  const exitedAt = session.isRunning ? null : session.exitedAt
  const epochPool = sessionFileCandidates(files, session.startedAt ?? session.createdAt, exitedAt)
  const lifetimePool = candidatesWithEpochFallback(files, session, exitedAt)
  return bindFromPools(session, kind, epochPool, lifetimePool, occupied)
}

/**
 * kimi 会话 wire 定位：优先读索引 session_index.jsonl 按 workDir 过滤（候选 = <sessionDir>/agents/main/wire.jsonl，
 * 存在才收）；索引读不到时兜底扫 sessions/*\/session_*，按各自 state.json 的 workDir 过滤。
 * agents/agent-N/ 是子代理 wire，一律不收。
 */
function kimiWireFiles(cwd: string): string[] {
  const root = path.join(os.homedir(), '.kimi-code')
  const wireOf = (sessionDir: string) => path.join(sessionDir, 'agents', 'main', 'wire.jsonl')
  try {
    const fromIndex: string[] = []
    for (const line of fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { sessionDir?: unknown; workDir?: unknown }
        if (row.workDir !== cwd || typeof row.sessionDir !== 'string') continue
        const wire = wireOf(row.sessionDir)
        if (statSafe(wire)) fromIndex.push(wire)
      } catch {
        continue
      }
    }
    if (fromIndex.length) return fromIndex
  } catch {
    /* 索引缺失/损坏 → 走全量扫描兜底 */
  }
  const files: string[] = []
  let wdDirs: string[] = []
  try {
    wdDirs = fs
      .readdirSync(path.join(root, 'sessions'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, 'sessions', d.name))
  } catch {
    return []
  }
  for (const wdDir of wdDirs) {
    let sessDirs: string[] = []
    try {
      sessDirs = fs
        .readdirSync(wdDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('session_'))
        .map((d) => path.join(wdDir, d.name))
    } catch {
      continue
    }
    for (const sessDir of sessDirs) {
      const wire = wireOf(sessDir)
      if (!statSafe(wire)) continue
      try {
        const state = JSON.parse(fs.readFileSync(path.join(sessDir, 'state.json'), 'utf8')) as { workDir?: unknown }
        if (state.workDir !== cwd) continue
      } catch {
        continue // 读不出 workDir 的不收，避免串到别的 cwd
      }
      files.push(wire)
    }
  }
  return files
}

function locate(session: Session, kind: AgentKind, occupied?: (nativeId: string) => boolean): string | null {
  // 显式 occupied 优先；未传时回退到 SessionManager 注册的全局占用闸（读取路径同样需要）
  const gate = occupied ?? occupancyProvider?.(session.id)
  // 空文件命中不锁死：占位文件之后可能才出现真正写内容的那个，重扫升级
  const hit = locateCache.get(session.id)
  if (hit) {
    const st = statSafe(hit.path)
    if (st && st.size > 0) return hit.path
  }
  const startedAt = session.startedAt ?? session.createdAt
  const exitedAt = session.isRunning ? null : session.exitedAt

  log.info(`[locate] ${kind} ${session.id.slice(0, 8)} startedAt=${startedAt} exitedAt=${exitedAt} cwd=${session.cwd}`)

  let files: string[] = []
  if (kind === 'workbuddy') {
    // claude 同款 slug 规则去掉前导 '-'（/Users/alice → Users-alice）。
    // 真身目录是 ~/.codebuddy/projects（codebuddy CLI 落盘处）；~/.workbuddy/projects
    // 里是历史软链快照（新会话文件不会出现），仅作兜底。
    const slug = cwdToSlug(session.cwd).replace(/^-+/, '')
    files = [
      ...listFiles(path.join(os.homedir(), '.codebuddy', 'projects', slug), '.jsonl'),
      ...listFiles(path.join(os.homedir(), '.workbuddy', 'projects', slug), '.jsonl'),
    ]
  } else if (kind === 'codex') {
    const root = path.join(os.homedir(), '.codex', 'sessions')
    if (session.agentSessionId) {
      try {
        files = fs
          .readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => path.join(root, name))
          .filter((file) => codexSessionIdOf(file) === session.agentSessionId)
      } catch {
        files = []
      }
    } else {
      files = codexDayDirs(startedAt)
        .flatMap((d) => listFiles(d, '.jsonl'))
        .filter((f) => codexMetaCwd(f) === session.cwd)
    }
  } else if (kind === 'qclaw') {
    const sessDir = path.join(os.homedir(), '.qclaw', 'agents', 'main', 'sessions')
    files = listFiles(sessDir, '.jsonl').filter(
      (f) => !path.basename(f).includes('trajectory') && path.basename(f) !== 'sessions.json'
    )
  } else if (kind === 'kimi') {
    files = kimiWireFiles(session.cwd)
  } else {
    files = listFiles(path.join(os.homedir(), '.reasonix', 'sessions'), '.events.jsonl')
  }
  const found = bindCandidate(session, kind, uniqueAgentFiles(files, kind), gate)

  if (found && found !== hit?.path) {
    locateCache.set(session.id, { path: found })
    log.info(`定位 ${kind} 会话文件 ${session.id.slice(0, 8)} → ${path.basename(found)}`)
  } else if (!found) {
    log.info(`[locate] ${kind} ${session.id.slice(0, 8)} 未找到`)
  }
  return found
}

/**
 * claude 系包装器（如 bin/c5）会话缺 claudeSessionId 时的兜底：模板 claudeHome 曾丢失导致
 * spawn 没注入 --session-id，claude 用内部随机 id 写 transcript——按 cwd-slug + 时间窗定位。
 * 排除 agent-*.jsonl（子 agent transcript，不是会话主文件）。
 */
export function locateClaudeTranscript(session: Session, home: string): string | null {
  const hit = locateCache.get(session.id)
  if (hit) {
    const st = statSafe(hit.path)
    if (st && st.size > 0) return hit.path
  }
  const dir = path.join(home, '.claude', 'projects', cwdToSlug(session.cwd))
  const files = listFiles(dir, '.jsonl').filter((f) => !path.basename(f).startsWith('agent-'))
  // 候选按创建时间升序，取最后一个 = 最新创建——「续最后一次运行」语义，与 bindFromPools 取最近写入对齐
  const candidates = candidatesWithEpochFallback(files, session, session.isRunning ? null : session.exitedAt)
  const found = candidates[candidates.length - 1] ?? null
  if (found && found !== hit?.path) {
    locateCache.set(session.id, { path: found })
    log.info(`定位 claude 会话文件 ${session.id.slice(0, 8)} → ${path.basename(found)}`)
  }
  return found
}

// ---- 各家格式 → TranscriptMessage ----

function textPart(text: string): TranscriptPart {
  return { kind: 'text', text: text.slice(0, MAX_PART_TEXT) }
}

function msgOf(role: 'user' | 'assistant', parts: TranscriptPart[], timestamp: string | null = null): TranscriptMessage {
  return { role, parts, timestamp }
}

function isoOf(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

export function parseWorkbuddy(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const ts = isoOf(obj.timestamp)
    switch (obj.type) {
      case 'message': {
        const role = obj.role
        if (role !== 'user' && role !== 'assistant') break
        let text = ''
        for (const block of (obj.content as Array<Record<string, unknown>>) ?? []) {
          const t = block?.type
          if (t === 'input_text' || t === 'output_text' || t === 'text') text += String(block.text ?? '')
        }
        if (text.trim()) out.push(msgOf(role, [textPart(text)], ts))
        break
      }
      case 'reasoning': {
        // 思考正文在 rawContent/content 的 *_text 块里（content 常为空数组）
        let text = ''
        for (const src of [obj.rawContent, obj.content]) {
          if (text || !Array.isArray(src)) continue
          for (const block of src as Array<Record<string, unknown>>) {
            if (typeof block?.type === 'string' && block.type.endsWith('_text')) text += String(block.text ?? '')
          }
        }
        if (text.trim()) out.push(msgOf('assistant', [{ kind: 'thinking', text: text.slice(0, MAX_PART_TEXT) }], ts))
        break
      }
      case 'function_call': {
        const name = String((obj as { name?: unknown }).name ?? 'tool')
        let input = ''
        const args = (obj as { arguments?: unknown; input?: unknown }).arguments ?? (obj as { input?: unknown }).input
        try {
          input = typeof args === 'string' ? args : JSON.stringify(args ?? '', null, 2)
        } catch {
          input = String(args)
        }
        out.push(msgOf('assistant', [{ kind: 'tool_use', name, input: input.slice(0, MAX_TOOL_TEXT) }], ts))
        break
      }
      case 'function_call_result': {
        const o = obj as { output?: unknown; result?: unknown; content?: unknown; error?: unknown; status?: unknown }
        let v = o.output ?? o.result ?? o.content
        // output 常见形态 {type:'text', text:'…'}，剥壳取正文
        if (v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') v = (v as { text: string }).text
        let text = ''
        try {
          text = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
        } catch {
          text = String(v)
        }
        const isError = Boolean(o.error) || (typeof o.status === 'string' && o.status.includes('error'))
        out.push(
          msgOf('user', [
            { kind: 'tool_result', text: (text || '（空结果）').slice(0, MAX_TOOL_TEXT), isError },
          ], ts)
        )
        break
      }
    }
  }
  return out
}

/** codex 注入的 AGENTS.md/environment_context 引导消息，不是用户输入 */
function isCodexContext(text: string): boolean {
  return text.startsWith('# AGENTS.md instructions') && text.includes('<environment_context>')
}

export function parseCodex(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'response_item') continue
    const payload = (obj.payload ?? {}) as Record<string, unknown>
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null
    const itemType = payload.type
    if (itemType === 'function_call') {
      const name = String(payload.name ?? 'tool')
      const argsRaw = payload.arguments
      const input = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? '')
      out.push(msgOf('assistant', [{ kind: 'tool_use', name, input: input.slice(0, MAX_TOOL_TEXT) }], ts))
      continue
    }
    if (itemType === 'function_call_output') {
      const o = payload.output
      let text = ''
      if (typeof o === 'string') text = o
      else if (o && typeof o === 'object') text = String((o as { content?: unknown }).content ?? JSON.stringify(o))
      out.push(msgOf('user', [{ kind: 'tool_result', text: (text || '（空结果）').slice(0, MAX_TOOL_TEXT), isError: false }], ts))
      continue
    }
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') continue
    let text = ''
    const content = payload.content
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block?.type === 'string' && block.type.endsWith('_text')) text += String(block.text ?? '')
      }
    }
    text = text.trim()
    if (!text || (role === 'user' && isCodexContext(text))) continue
    out.push(msgOf(role, [textPart(text)], ts))
  }
  return out
}

export function trafficStateFromCodex(raw: string): Exclude<TrafficState, 'exited'> {
  let state: Exclude<TrafficState, 'exited'> | null = null
  const pendingInputCalls = new Set<string>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = (obj.payload ?? {}) as Record<string, unknown>
    if (obj.type === 'event_msg') {
      if (payload.type === 'task_started') state = 'working'
      else if (payload.type === 'task_complete') state = 'conclusion'
      else if (payload.type === 'turn_aborted') state = 'needs-user' // 中断无结论，会话空等输入
      continue
    }
    if (obj.type !== 'response_item') continue
    if (payload.type === 'function_call') {
      const name = String(payload.name ?? '').toLowerCase()
      if (name === 'request_user_input' || name === 'requestuserinput') {
        const callId = String(payload.call_id ?? payload.id ?? '')
        if (callId) pendingInputCalls.add(callId)
        state = 'needs-user'
      }
    } else if (payload.type === 'function_call_output') {
      const callId = String(payload.call_id ?? '')
      if (callId && pendingInputCalls.delete(callId)) state = 'working'
    }
  }

  return state ?? trafficStateFromMessages(parseCodex(raw))
}

/** qclaw（openclaw TUI）：每行 JSON，type=message 往下拿 message.role/content */
export function parseQclaw(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'message') continue
    const msg = (obj.message ?? {}) as Record<string, unknown>
    const role = msg.role as string
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null
    // 出错终止的 assistant：content 为空但 stopReason=error，补错误文本让尾态可判 conclusion 而非卡红
    if (role === 'assistant' && msg.stopReason === 'error') {
      const detail = typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
      out.push(msgOf('assistant', [textPart(detail ? `（出错：${String(msg.errorMessage).trim()}）` : '（出错终止）')], ts))
      continue
    }
    let content = msg.content
    let text = ''
    const toolParts: TranscriptPart[] = []
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block?.text === 'string') text += block.text
        // toolCall 块不能丢：丢了会把「文本+工具调用」误判成纯文本结论（绿灯拍打）
        if (block?.type === 'toolCall') {
          let input = ''
          try {
            input = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '')
          } catch {
            input = String(block.arguments)
          }
          toolParts.push({ kind: 'tool_use', name: String(block.name ?? 'tool'), input: input.slice(0, MAX_TOOL_TEXT) })
        }
      }
    }
    text = text.trim()
    const parts: TranscriptPart[] = text ? [textPart(text), ...toolParts] : toolParts
    if (!parts.length) continue
    if (role === 'user' || role === 'assistant') {
      out.push(msgOf(role, parts, ts))
    } else if (role === 'toolResult') {
      out.push(msgOf('user', [{ kind: 'tool_result', text: text.slice(0, MAX_TOOL_TEXT), isError: false }], ts))
    }
  }
  return out
}

/**
 * kimi（Kimi Code CLI）wire.jsonl：每行 JSON，顶层 type + 毫秒 epoch time。
 * 用户输入只看 turn.prompt / turn.steer（steer 是中途插话）——context.append_message 只是
 * user 消息的镜像（origin:user）或系统注入（origin:injection），整体忽略以免重复。
 * 对话主体在 context.append_loop_event：content.part（text/think）、tool.call、tool.result；
 * step.begin/end 与 metadata、llm 系、usage、tools 系、permission、swarm_mode 等噪声行一律忽略。
 */
export function parseKimi(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const ts = isoOf(obj.time)
    if (obj.type === 'turn.prompt' || obj.type === 'turn.steer') {
      let text = ''
      for (const block of (obj.input as Array<Record<string, unknown>>) ?? []) {
        if (block?.type === 'text') text += String(block.text ?? '')
      }
      if (!text.trim()) continue
      // 真假用户输入两层辨（2026-07-23 维护者报障：子 agent 回报跑到右侧）：
      // 1) origin.kind：background_task/cron_job 等合成消息直接算 notice；无 origin 旧格式按用户兜底
      // 2) 文本信封：剥掉 system-reminder 块后，剩余为空（纯提醒）或以 <task-notification>/
      //    <notification>/<cron-fire> 开头（运行时合成 turn 常标 origin:user，单靠 origin 漏网）
      // notice 段归左侧，不冒充用户指令；role 仍记 user：traffic 只看 text 段，通知到达后保持 working。
      const origin = obj.origin as Record<string, unknown> | undefined
      const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      const synthetic =
        stripped === '' || /^<(task-notification|notification[\s>]|cron-fire[\s>])/.test(stripped)
      if ((!origin || origin.kind === 'user') && !synthetic) out.push(msgOf('user', [textPart(text)], ts))
      else out.push(msgOf('user', [{ kind: 'notice', text: text.slice(0, MAX_PART_TEXT) }], ts))
      continue
    }
    if (obj.type !== 'context.append_loop_event') continue
    const event = (obj.event ?? {}) as Record<string, unknown>
    if (event.type === 'content.part') {
      const part = (event.part ?? {}) as Record<string, unknown>
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        out.push(msgOf('assistant', [textPart(part.text)], ts))
      } else if (part.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
        out.push(msgOf('assistant', [{ kind: 'thinking', text: part.think.slice(0, MAX_PART_TEXT) }], ts))
      }
      continue
    }
    if (event.type === 'tool.call') {
      const name = String(event.name ?? 'tool')
      let input = ''
      try {
        input = typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? '', null, 2)
      } catch {
        input = String(event.args)
      }
      out.push(msgOf('assistant', [{ kind: 'tool_use', name, input: input.slice(0, MAX_TOOL_TEXT) }], ts))
      continue
    }
    if (event.type === 'tool.result') {
      // result 实测多为对象 {output:...}，也有 JSON 字符串形态；剥壳取 output，剥不动用原串。
      // isError 字段可能为 null——result 里带 error 才算错
      let result: unknown = event.result
      if (typeof result === 'string') {
        try {
          result = JSON.parse(result)
        } catch {
          /* 非 JSON 原串直接用 */
        }
      }
      let text = ''
      let hasError = Boolean(event.isError)
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>
        if (r.error) hasError = true
        const v = r.output ?? r.error
        try {
          text = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
        } catch {
          text = String(v)
        }
      } else if (typeof result === 'string') {
        text = result
      }
      out.push(
        msgOf('user', [{ kind: 'tool_result', text: (text || '（空结果）').slice(0, MAX_TOOL_TEXT), isError: hasError }], ts)
      )
      continue
    }
  }
  return out
}

/** reasonix：取最后一个完整行的 replace 帧（全量），前面的旧帧全部忽略 */
export function parseReasonix(raw: string): TranscriptMessage[] {
  const lines = raw.split('\n').filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    let frame: { messages?: Array<Record<string, unknown>> }
    try {
      frame = JSON.parse(lines[i]) as { messages?: Array<Record<string, unknown>> }
    } catch {
      continue // 尾行可能是写了一半的帧，退上一行
    }
    if (!Array.isArray(frame.messages)) continue
    const out: TranscriptMessage[] = []
    for (const m of frame.messages) {
      const role = m.role
      const content = typeof m.content === 'string' ? m.content : ''
      if (role === 'user') {
        if (content.trim()) out.push(msgOf('user', [textPart(content)]))
      } else if (role === 'assistant') {
        const parts: TranscriptPart[] = []
        const thinking = typeof m.reasoning_content === 'string' ? m.reasoning_content : ''
        if (thinking.trim()) parts.push({ kind: 'thinking', text: thinking.slice(0, MAX_PART_TEXT) })
        if (content.trim()) parts.push(textPart(content))
        for (const call of (m.tool_calls as Array<Record<string, unknown>>) ?? []) {
          const fn = (call?.function ?? call) as { name?: unknown; arguments?: unknown }
          const input = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? '')
          parts.push({ kind: 'tool_use', name: String(fn.name ?? 'tool'), input: input.slice(0, MAX_TOOL_TEXT) })
        }
        if (parts.length) out.push(msgOf('assistant', parts))
      } else if (role === 'tool') {
        out.push(
          msgOf('user', [
            { kind: 'tool_result', text: (content || '（空结果）').slice(0, MAX_TOOL_TEXT), isError: false },
          ])
        )
      }
    }
    return out
  }
  return []
}

// ---- 读取 + 消息级分页 ----

interface ParsedCache {
  path: string
  mtimeMs: number
  size: number
  messages: TranscriptMessage[]
}

const parseCache = new Map<string, ParsedCache>()

function parseAgentRaw(raw: string, kind: AgentKind): TranscriptMessage[] {
  return kind === 'workbuddy'
    ? parseWorkbuddy(raw)
    : kind === 'codex'
      ? parseCodex(raw)
      : kind === 'qclaw'
        ? parseQclaw(raw)
        : kind === 'kimi'
          ? parseKimi(raw)
          : parseReasonix(raw)
}

function loadMessages(sessionId: string, filePath: string, kind: AgentKind): TranscriptMessage[] {
  const st = statSafe(filePath)
  if (!st) return []
  const hit = parseCache.get(sessionId)
  if (hit && hit.path === filePath && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.messages
  const messages = parseAgentRaw(fs.readFileSync(filePath, 'utf8'), kind)
  parseCache.set(sessionId, { path: filePath, mtimeMs: st.mtimeMs, size: st.size, messages })
  return messages
}

export function readAgentTrafficState(
  session: Session,
  kind: AgentKind,
  knownFilePath?: string
): Exclude<TrafficState, 'exited'> {
  const filePath = knownFilePath ?? locate(session, kind)
  if (!filePath) return 'working'
  if (kind === 'codex') return trafficStateFromCodex(fs.readFileSync(filePath, 'utf8'))
  return trafficStateFromMessages(loadMessages(session.id, filePath, kind))
}

export function dropAgentTranscriptCache(sessionId: string) {
  parseCache.delete(sessionId)
  locateCache.delete(sessionId)
}

/**
 * 分页决策（纯函数，便于单测）：before 向前翻页 / 首载尾页 / 真收缩重置 / 抖动容差 / 增量。
 * 抖动容差（2026-07-23 手机端"跳到顶上又被拉下来"报障）：追加型 JSONL（kimi/codex/qclaw/
 * workbuddy）流式写入有半行窗口，解析条数瞬时少一两条——小亏空不重置（重置=整页替换→
 * 内容骤减、浏览器把视口钳到顶、再被拉回底，iOS 上肉眼可见），不动游标空答一轮等恢复；
 * 大亏空（真截断/文件轮换）才回尾页。reasonix replace 帧是真收缩，不在此列。
 */
const APPEND_ONLY_KINDS: ReadonlySet<AgentKind> = new Set(['kimi', 'codex', 'qclaw', 'workbuddy'])
const JITTER_TOLERANCE = 4

export function paginateMessages(
  messages: TranscriptMessage[],
  kind: AgentKind,
  opts: { cursor: number; before?: number }
): TranscriptPage {
  const total = messages.length
  if (opts.before !== undefined) {
    const end = Math.max(0, Math.min(opts.before, total))
    const start = Math.max(0, end - PAGE_MESSAGES)
    return { exists: true, messages: messages.slice(start, end), cursor: end, start, hasMore: start > 0 }
  }
  const jitter = APPEND_ONLY_KINDS.has(kind) && total < opts.cursor && opts.cursor - total <= JITTER_TOLERANCE
  if (opts.cursor === 0 || (total < opts.cursor && !jitter)) {
    const start = Math.max(0, total - PAGE_MESSAGES)
    return { exists: true, messages: messages.slice(start), cursor: total, start, hasMore: start > 0 }
  }
  if (total < opts.cursor) return { exists: true, messages: [], cursor: opts.cursor } // 抖动：游标不动，空答等恢复
  return { exists: true, messages: messages.slice(opts.cursor), cursor: total }
}

export function readAgentTranscript(
  session: Session,
  kind: AgentKind,
  opts: { cursor: number; before?: number }
): TranscriptPage {
  const filePath = locate(session, kind)
  if (!filePath) return { exists: false, messages: [], cursor: 0 }
  const messages = loadMessages(session.id, filePath, kind)
  return paginateMessages(messages, kind, opts)
}

/**
 * 交接用全量读取：取文件尾部 maxBytes 内的完整行消息（截断对齐到行首，残首行丢弃），
 * 与 history.ts readHistoryAllMessages 同口径；不走 parseCache（交接是一次性动作）。
 */
export function readAgentFileAllMessages(
  filePath: string,
  kind: AgentKind,
  maxBytes = 4 * 1024 * 1024
): TranscriptMessage[] {
  const st = statSafe(filePath)
  if (!st) return []
  const from = Math.max(0, st.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(st.size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
  } finally {
    fs.closeSync(fd)
  }
  let text = buf.toString('utf8')
  if (from > 0) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }
  return parseAgentRaw(text, kind)
}

/** sessionHandoff 用：分页接口只回最后一页（PAGE_MESSAGES 条），交接要全量，否则丢前文 */
export function readAgentAllMessages(session: Session, kind: AgentKind): TranscriptMessage[] {
  const filePath = locate(session, kind)
  return filePath ? readAgentFileAllMessages(filePath, kind) : []
}
