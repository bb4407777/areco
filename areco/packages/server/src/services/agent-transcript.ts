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

export function agentKindOf(command: string, harness?: string | null): AgentKind | null {
  if (harness === 'codex') return 'codex'
  if (harness === 'workbuddy') return 'workbuddy'
  if (harness === 'reasonix') return 'reasonix'
  if (harness === 'kimi') return 'kimi'
  if (harness === 'hermes') return 'qclaw'
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
/** P2-10 locate 失败退避账本：sessionId → 连败次数 + 下次允许扫盘时刻。
 *  前 LOCATE_BACKOFF_AFTER 次不退避（qclaw 冷启 ~5s 内 transcript 才落盘，退避早了拖绑定），
 *  之后 750ms 起倍增到上限；成功定位/清缓存即复位。 */
const locateFailCache = new Map<string, { fails: number; nextAt: number }>()
const LOCATE_BACKOFF_AFTER = 8
const LOCATE_BACKOFF_MAX_MS = 30_000

/**
 * 占用闸提供者（2026-07-22 幽灵卡根治）：由 SessionManager 构造时注册。
 * locate 有两类调用方——trafficSource 显式传 occupied；transcript 读取
 * （readAgentTranscript/readAgentTrafficState） historically 不传，形成
 * "traffic 有闸、读取无闸"双轨：读取路径照样能把别人的文件绑到本卡并锁进缓存。
 * 注册后 locate 全路径统一套闸（显式参数优先，provider 兜底）。
 */
type OccupiedCheck = (nativeId: string) => boolean
let occupancyProvider: ((sessionId: string) => OccupiedCheck | undefined) | null = null
let uniqueFallbackProvider: ((sessionId: string, kind: AgentKind) => boolean) | null = null
export function registerOccupancyProvider(provider: (sessionId: string) => OccupiedCheck | undefined): void {
  occupancyProvider = provider
}

/**
 * 无内容证据的唯一候选兜底只适合单卡启动竞态；同 cwd 有多个未绑定同类会话时必须关闭，
 * 否则先轮询到的卡会抢走后启动会话的文件。由 SessionManager 提供全局会话视角。
 */
export function registerUniqueFallbackProvider(
  provider: (sessionId: string, kind: AgentKind) => boolean,
): void {
  uniqueFallbackProvider = provider
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
 * WorkBuddy 桌面端会按 cwd 的 realpath 写项目目录；macOS 上 /tmp 会变成 /private/tmp。
 * Areco 会话仍保留调用方原始 cwd，因此定位时两种 slug 都要覆盖。
 */
export function workbuddyProjectSlugs(cwd: string): string[] {
  const paths = [cwd]
  try {
    paths.push(fs.realpathSync(cwd))
  } catch {
    /* cwd 已不存在时只用原值，恢复仍可走 agentSessionId + 历史目录兜底 */
  }
  return [
    ...new Set(
      paths.flatMap((value) => [
        // 官方 CodeBuddy CLI 使用 Claude 风格：所有非 ASCII 字母数字都替换为连字符。
        cwdToSlug(value).replace(/^-+/, ''),
        // WorkBuddy Desktop 保留中文和标点，仅把路径分隔符替换为连字符。
        value.replace(/[\\/]/g, '-').replace(/^-+/, ''),
      ]),
    ),
  ]
}

/**
 * 只收集生命周期窗口内候选。绑定优先级：原生 session id → 首条输入哈希 →
 * 旧会话“卡片名 = 首条用户消息标题”唯一一致（均先本 epoch 窗口再全生命周期）。
 * WorkBuddy 到此为止：无唯一内容证据不绑定；其他 agent 的兼容兜底见 bindFromPools。
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
  session: Pick<Session, 'startedAt' | 'createdAt'>,
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

/** 桥接 PTY 会在真正创建/恢复 WorkBuddy 会话后打印确定性原生 UUID。 */
export function workbuddyNativeSessionIdFromOutput(text: string): string {
  const matches = [
    ...text.matchAll(
      /\[WorkBuddy\]\s*已(?:创建|恢复)会话\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/giu,
    ),
  ]
  return matches.at(-1)?.[1]?.toLowerCase() ?? ''
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

function exactAgentFile(session: { agentSessionId: string | null }, kind: AgentKind, files: string[]): string | null {
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

export interface BindingOptions {
  occupied?: (nativeId: string) => boolean
  /** 仅用于单会话启动竞态兼容；跨会话共享 cwd 时由管理器关闭。 */
  allowUniqueFallback?: boolean
}

/** 单池证据匹配：输入哈希唯一命中；无哈希时接受原生标题或首条用户消息与卡片名一致 */
function evidenceMatch(session: BindingTarget, kind: AgentKind, candidates: string[]): string | null {
  // 内容证据必须唯一。相同首句/标题跨历史重复时，mtime 不能证明归属。
  const byPromptHash = session.agentBindingHash
    ? candidates.filter((file) => {
        const text = firstUserText(file, kind)
        return text !== '' && bindingHash(text) === session.agentBindingHash
      })
    : []
  // 相同首句（如“在吗？”）可能跨多份历史文件重复；这不是唯一归属证据。
  // 确定性 ID 缺失时宁可暂不绑定，也不能按 mtime 猜其中一份。
  if (byPromptHash.length === 1) return byPromptHash[0]
  if (byPromptHash.length > 1) return null

  // 旧数据没有输入哈希：仅接受原生标题或首条用户消息明确一致的候选。
  if (session.agentBindingHash) return null
  const name = normalized(session.name).replace(/…$/, '')
  const byAgentTitle = candidates.filter((file) => legacyAgentTitleMatches(name, agentFileTitle(file, kind)))
  if (byAgentTitle.length === 1) return byAgentTitle[0]
  if (byAgentTitle.length > 1) return null

  const byLegacyName = candidates.filter((file) => {
    const text = normalized(firstUserText(file, kind))
    const handoffTitle = handoffTitleFromPrompt(text)
    return name.length >= 4 && (text === name || text.startsWith(name) || handoffTitle === name)
  })
  return byLegacyName.length === 1 ? byLegacyName[0] : null
}

/**
 * 池匹配（绑定副作用在此）：顺序 ① 本 epoch 窗口唯一内容证据 ② 仅非 WorkBuddy agent
 * 可在管理器许可时使用本 epoch 唯一非空文件兼容兜底 ③ 全生命周期唯一内容证据。
 * WorkBuddy 完全禁止时间/mtime 猜绑：歧义或无证据直接返回 null。
 *
 * 占用过滤（2026-07-22 幽灵卡根治）：已被另一张在册卡拥有的底层文件一律不进池。
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
  options: BindingOptions | ((nativeId: string) => boolean) = {},
): string | null {
  // 兼容既有测试/调用方的 occupied 函数形态；新代码用 options 传全局兜底许可。
  const occupied = typeof options === 'function' ? options : options.occupied
  const allowUniqueFallback =
    typeof options === 'function' ? true : (options.allowUniqueFallback ?? true)
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

  // WorkBuddy 新会话现由 --session-id / PTY UUID 确定性绑定；历史卡也只接受唯一内容证据，
  // 完全取消时间窗唯一候选兜底。其他 agent 暂保留有首条凭据的单卡竞态兼容。
  if (!matched && kind !== 'workbuddy' && session.agentBindingHash && allowUniqueFallback && epochPool.length === 1) {
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
      `占用冲突：${kind} 会话 ${session.id.slice(0, 8)} 想绑底层会话 ${nativeId.slice(0, 8)}，但已被另一张在册卡拥有——跳过本轮，待重扫`,
    )
    return null
  }
  session.bindAgentSession(nativeId)
  log.info(`绑定 ${kind} 会话 ${session.id.slice(0, 8)} ↔ ${nativeId}`)
  return matched
}

export interface BindCandidateTarget extends BindingTarget {
  agentSessionId: string | null
  createdAt: number
  startedAt: number | null
  exitedAt: number | null
  isRunning: boolean
}

export function bindCandidate(
  session: BindCandidateTarget,
  kind: AgentKind,
  files: string[],
  occupied?: (nativeId: string) => boolean,
): string | null {
  const exact = exactAgentFile(session, kind, files)
  if (exact) {
    // 精确恢复同样守占用闸：目标底层会话已被另一会话占用时返回 null（待原卡处理），
    // 否则两张卡会同读一份 transcript，重演幽灵卡。
    const exactId = nativeSessionId(exact, kind)
    if (exactId && occupied?.(exactId)) {
      log.warn(
        `占用冲突：${kind} 会话 ${session.id.slice(0, 8)} 精确恢复的底层会话 ${exactId.slice(0, 8)} 已被另一会话占用——跳过本轮`,
      )
      return null
    }
    return exact
  }
  // 一旦已有原生 ID（尤其 WorkBuddy 启动前 --session-id 预分配），文件尚未落盘时只能等待；
  // 绝不能回退到内容/时间猜测并覆盖这份确定性身份。
  if (session.agentSessionId) return null

  const exitedAt = session.isRunning ? null : session.exitedAt
  const epochPool = sessionFileCandidates(files, session.startedAt ?? session.createdAt, exitedAt)
  const lifetimePool = candidatesWithEpochFallback(files, session, exitedAt)
  return bindFromPools(session, kind, epochPool, lifetimePool, {
    occupied,
    allowUniqueFallback: uniqueFallbackProvider?.(session.id, kind) ?? true,
  })
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
  // 空文件命中不锁死：占位文件之后可能才出现真正写内容的那个，重扫升级。
  // 非空缓存也必须重过占用闸：所有权可在缓存建立后因 restore/dedup 发生变化。
  const hit = locateCache.get(session.id)
  if (hit) {
    const st = statSafe(hit.path)
    const cachedId = nativeSessionId(hit.path, kind)
    // codex 恢复把活文件轮换成新 rollout：运行中若缓存的还是本 epoch 之前出生的文件，
    // 视为陈旧重扫，等新 rollout 落盘后接管（正常会话的文件生于 epoch 附近，不受影响）。
    const preEpochStale =
      kind === 'codex' &&
      session.isRunning &&
      st !== null &&
      (st.birthtimeMs || st.mtimeMs) < (session.startedAt ?? session.createdAt) - BIRTH_SLACK_MS
    if (st && st.size > 0 && !preEpochStale && (!cachedId || !gate?.(cachedId))) return hit.path
    locateCache.delete(session.id)
  }
  // P2-10 失败退避：locate 被红绿灯每 750ms + captureTick 每 1s 反复调，永远定位不到的
  // 会话（transcript 未写盘的适配器、qclaw 冷启 turn 中）此前每次都全量扫目录+打 2 行日志
  // （launchd.out.log 末 20MB 中 locate 行占 86%）。前 8 次不退避（qclaw 冷启 ~5s 内正常
  // 发现，不拖绑定），此后指数退避到 30s 上限；日志只在状态转折打（首败一行、成败转换一行）。
  const failState = locateFailCache.get(session.id)
  if (failState && Date.now() < failState.nextAt) return null
  const startedAt = session.startedAt ?? session.createdAt

  let files: string[] = []
  if (kind === 'workbuddy') {
    // claude 同款 slug 规则去掉前导 '-'（/Users/alice → Users-alice）。
    // codebuddy CLI 通常写 ~/.codebuddy/projects；WorkBuddy 桌面客户端直接写 ~/.workbuddy/projects。
    // cwd 同时覆盖原值与 realpath（macOS /tmp → /private/tmp），避免桌面桥接会话无法绑定。
    const slugs = workbuddyProjectSlugs(session.cwd)
    files = slugs.flatMap((slug) => [
      ...listFiles(path.join(os.homedir(), '.codebuddy', 'projects', slug), '.jsonl'),
      ...listFiles(path.join(os.homedir(), '.workbuddy', 'projects', slug), '.jsonl'),
    ])
  } else if (kind === 'codex') {
    const root = path.join(os.homedir(), '.codex', 'sessions')
    if (session.agentSessionId) {
      try {
        files = fs
          .readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => path.join(root, name))
          .filter((file) => codexSessionIdOf(file) === session.agentSessionId)
        // codex resume 用同一 session id 回放历史写新 rollout：同 id 多文件时最新那份才是
        // 活文件（旧文件在恢复那刻冻结），排最前让 uniqueAgentFiles/exactAgentFile 都取它。
        files.sort((a, b) => {
          const bs = statSafe(b)
          const as = statSafe(a)
          return (bs ? bs.birthtimeMs || bs.mtimeMs : 0) - (as ? as.birthtimeMs || as.mtimeMs : 0)
        })
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

  if (found) {
    locateFailCache.delete(session.id)
    if (found !== hit?.path) {
      locateCache.set(session.id, { path: found })
      log.info(`定位 ${kind} 会话文件 ${session.id.slice(0, 8)} → ${path.basename(found)}`)
    }
  } else {
    const fails = (failState?.fails ?? 0) + 1
    const nextAt = fails >= LOCATE_BACKOFF_AFTER
      ? Date.now() + Math.min(750 * 2 ** (fails - LOCATE_BACKOFF_AFTER), LOCATE_BACKOFF_MAX_MS)
      : 0
    locateFailCache.set(session.id, { fails, nextAt })
    // 状态转折才打：首败一行（成功→失败/初见即失败）；持续失败沉默（旧版每次 2 行是日志洪水主力）
    if (fails === 1) log.info(`[locate] ${kind} ${session.id.slice(0, 8)} 未找到（连败退避接管，恢复时打「定位」行）`)
  }
  return found
}

/**
 * claude 系包装器（如 bin/c5）会话缺 claudeSessionId 时的兜底：模板 claudeHome 曾丢失导致
 * spawn 没注入 --session-id，claude 用内部随机 id 写 transcript——按 cwd-slug + 时间窗定位。
 * 排除 agent-*.jsonl（子 agent transcript，不是会话主文件）。
 */
export function locateClaudeTranscript(session: Session, home: string): string | null {
  return locateClaudeLayoutTranscript(session, path.join(home, '.claude', 'projects'))
}

/**
 * claude 布局通用定位（qoder 等衍生 CLI 的 transcriptDir 会话）：<projectsDir>/<cwd-slug>/ 下
 * 按时间窗取最新 jsonl，语义同 locateClaudeTranscript。
 */
export function locateClaudeLayoutTranscript(session: Session, projectsDir: string): string | null {
  const hit = locateCache.get(session.id)
  if (hit) {
    const st = statSafe(hit.path)
    if (st && st.size > 0) return hit.path
  }
  const dir = path.join(projectsDir, cwdToSlug(session.cwd))
  const files = listFiles(dir, '.jsonl').filter((f) => !path.basename(f).startsWith('agent-'))
  // 候选按创建时间升序，取最后一个 = 最新创建——「续最后一次运行」语义，与 bindFromPools 取最近写入对齐
  const candidates = candidatesWithEpochFallback(files, session, session.isRunning ? null : session.exitedAt)
  const found = candidates[candidates.length - 1] ?? null
  if (found && found !== hit?.path) {
    locateCache.set(session.id, { path: found })
    log.info(`定位 claude 布局会话文件 ${session.id.slice(0, 8)} → ${path.basename(found)}`)
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

/** WorkBuddy 桌面会话把系统上下文和真人指令封在同一 input_text，座舱只显示/绑定真实指令。 */
export function workbuddyUserQuery(text: string): string {
  const matches = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gu)]
  const query = matches.at(-1)?.[1]?.trim()
  return query || text
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
        if (role === 'user') text = workbuddyUserQuery(text)
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
      else if (payload.type === 'agent_message') {
        // Codex 新版会把过程更新和最终答复都记为 agent_message，只能按 phase 区分。
        // traffic monitor 只读文件尾窗；重型 turn 超过尾窗后 task_started 会被挤出去，
        // 此时 commentary 是仍在工作的强证据，不能再退回“assistant 文本=结论”的旧启发式。
        if (payload.phase === 'commentary') state = 'working'
        else if (payload.phase === 'final_answer') state = 'conclusion'
      }
      continue
    }
    if (obj.type !== 'response_item') continue
    if (payload.type === 'function_call') {
      const name = String(payload.name ?? '').toLowerCase()
      if (name === 'request_user_input' || name === 'requestuserinput') {
        const callId = String(payload.call_id ?? payload.id ?? '')
        if (callId) pendingInputCalls.add(callId)
        state = 'needs-user'
      } else state = 'working'
    } else if (payload.type === 'function_call_output') {
      const callId = String(payload.call_id ?? '')
      if (callId) pendingInputCalls.delete(callId)
      state = 'working'
    } else if (
      payload.type === 'reasoning' ||
      payload.type === 'custom_tool_call' ||
      payload.type === 'custom_tool_call_output'
    ) {
      // gpt-5.6 等新版 Codex 的 thinking/exec 走 reasoning + custom_tool_call*，
      // 旧 parser 全部忽略，task_started 离开 512KB 尾窗后就会把正在思考误判为已出结论。
      state = 'working'
    } else if (payload.type === 'message') {
      if (payload.phase === 'commentary') state = 'working'
      else if (payload.phase === 'final_answer') state = 'conclusion'
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

/**
 * 流量状态只取文件尾部这么多字节。
 *
 * 为什么要限：本函数被 session-manager 的 traffic monitor 每 750ms 调一次，而它此前
 * 读的是**整个** transcript：
 *   · 非 codex 走 loadMessages，缓存键是 path:mtimeMs:size —— 一个正在干活的 agent
 *     每次写入都改 mtime 和 size，于是缓存**永远命中不了**，每 750ms 全量读+全量解析；
 *   · codex 分支连缓存都没有，无条件 readFileSync 整个文件。
 * 两个几十 MB rollout 的会话同时干活，就是每秒上百 MB 的同步读 + 全量 JSONL 解析
 * 压在 event loop 上，挤掉 PTY 分发、WS 心跳和 2 秒一次的 relay tick。
 *
 * 而流量状态只由**最后一条** assistant 消息决定，尾部窗口足够。512KB 能装下很多条记录，
 * 极端情况（单条超大记录）最坏是这一 tick 判不出来、下一 tick 文件再长一点就判出来了，
 * 不会误判成别的状态（trafficStateFromMessages 找不到消息时返回 working，与原先空文件同解）。
 */
const TRAFFIC_TAIL_BYTES = Number(process.env.ARECO_TRAFFIC_TAIL_BYTES || 512 * 1024)

export function readAgentTrafficState(
  session: Session,
  kind: AgentKind,
  knownFilePath?: string
): Exclude<TrafficState, 'exited'> {
  const filePath = knownFilePath ?? locate(session, kind)
  if (!filePath) return 'working'
  if (kind === 'codex') return trafficStateFromCodex(readTailText(filePath, TRAFFIC_TAIL_BYTES))
  // 走 readAgentFileAllMessages 的尾部窗口（同一套「对齐行首、丢残首行」口径），
  // 不再走 loadMessages —— 那条路的缓存对干活中的 agent 恒失效，等于每次全量读。
  return trafficStateFromMessages(readAgentFileAllMessages(filePath, kind, TRAFFIC_TAIL_BYTES))
}

export function dropAgentTranscriptCache(sessionId: string) {
  parseCache.delete(sessionId)
  locateCache.delete(sessionId)
  locateFailCache.delete(sessionId) // 会话重启/解绑后立即恢复全速重扫，不背旧退避
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

/** captureTick 增量读（2026-07-30 P1-7）用的三个小口子：路径定位 / 追加型判断 / 片段解析 */
export function locateAgentTranscriptPath(session: Session, kind: AgentKind): string | null {
  return locate(session, kind)
}

/** 该 agent 的 transcript 是否纯追加写入（可按字节锚增量读；reasonix replace 帧不在此列） */
export function isAppendOnlyAgentKind(kind: AgentKind): boolean {
  return APPEND_ONLY_KINDS.has(kind)
}

/** 解析 transcript 文本片段（追加型 JSONL 的行彼此独立，增量段可独立解析） */
export function parseAgentIncrement(raw: string, kind: AgentKind): TranscriptMessage[] {
  return parseAgentRaw(raw, kind)
}

/**
 * 交接用全量读取：取文件尾部 maxBytes 内的完整行消息（截断对齐到行首，残首行丢弃），
 * 与 history.ts readHistoryAllMessages 同口径；不走 parseCache（交接是一次性动作）。
 */
/** 读文件尾部 maxBytes 内的完整文本：对齐到行首，残缺的首行丢弃。 */
function readTailText(filePath: string, maxBytes: number): string {
  const st = statSafe(filePath)
  if (!st) return ''
  const from = Math.max(0, st.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(st.size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
  } finally {
    fs.closeSync(fd)
  }
  const text = buf.toString('utf8')
  if (from === 0) return text
  const nl = text.indexOf('\n')
  return nl >= 0 ? text.slice(nl + 1) : ''
}

export function readAgentFileAllMessages(
  filePath: string,
  kind: AgentKind,
  maxBytes = 4 * 1024 * 1024
): TranscriptMessage[] {
  return parseAgentRaw(readTailText(filePath, maxBytes), kind)
}

/** sessionHandoff 用：分页接口只回最后一页（PAGE_MESSAGES 条），交接要全量，否则丢前文 */
export function readAgentAllMessages(session: Session, kind: AgentKind): TranscriptMessage[] {
  const filePath = locate(session, kind)
  return filePath ? readAgentFileAllMessages(filePath, kind) : []
}
