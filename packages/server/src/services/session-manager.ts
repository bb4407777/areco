// 会话注册表：spawn/stop/kill/restart/archive/remove + autoStart + 启动恢复（server-restart 语义）+ 周期快照落盘
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { SessionSummary } from '../../../shared/protocol'
import type { TrafficState } from '../../../shared/traffic'
import type { AppConfig } from '../config'
import path from 'node:path'
import { Session } from './session'
import { TemplateStore, buildSpawnSpec, effectiveClaudeHome } from './templates'
import { Persistence } from './persistence'
import {
  agentKindOf,
  codexSessionIdOf,
  dropAgentTranscriptCache,
  kimiSessionIdOf,
  kimiTitleOf,
  locateAgentFile,
  locateClaudeTranscript,
  readAgentTrafficState,
  registerOccupancyProvider,
} from './agent-transcript'
import { NameTracker, nameCandidateOf } from './session-namer'
import { createLogger } from '../logger'
import { transcriptPath } from './transcript'
import { readClaudeTrafficState, transcriptFingerprint } from './traffic-monitor'

const log = createLogger('manager')

const PERIODIC_SNAPSHOT_MS = 60_000
const TRAFFIC_MONITOR_MS = 750
const NAME_EVOLVE_MS = 10_000

/**
 * 事件：
 *  - 'update' (summary)：某会话摘要变化
 *  - 'output' (sessionId, data, offset, epoch)
 *  - 'removed' (sessionId)
 *  - 'epoch' (sessionId)：restart 导致 epoch 变化，gateway 需对已 attach 连接重发快照
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private snapshotTimer: NodeJS.Timeout | null = null
  private trafficTimer: NodeJS.Timeout | null = null
  private nameTimer: NodeJS.Timeout | null = null
  private trafficFingerprints = new Map<string, string>()
  /** 演化命名增量扫描状态；stablePasses ≥ 2 的已退出会话封板不再轮询 */
  private nameTrackers = new Map<string, { path: string; tracker: NameTracker; stablePasses: number }>()

  constructor(
    private config: AppConfig,
    private templates: TemplateStore,
    private persistence: Persistence
  ) {
    super()
    // 注册全局占用闸：locate 全路径（traffic + transcript 读取）统一按"底层会话
    // 是否已被另一活会话占用"过滤候选，防止读取路径误绑别人的文件演化幽灵卡
    registerOccupancyProvider(
      (sessionId) => (sid) =>
        [...this.sessions.values()].some((s) => s.id !== sessionId && s.agentSessionId === sid && s.isRunning)
    )
  }

  // ---- 启动/关闭 ----

  restore() {
    for (const persisted of this.persistence.loadSessions()) {
      const session = new Session({
        id: persisted.id,
        name: persisted.name,
        templateId: persisted.templateId,
        command: persisted.command,
        args: persisted.args,
        cwd: persisted.cwd,
        color: persisted.color,
        claudeSessionId: persisted.claudeSessionId,
        claudeHome: persisted.claudeHome ?? null,
        createdAt: persisted.createdAt,
      })
      session.restoreFrom(persisted)
      const wasLive = persisted.status === 'running' || persisted.status === 'spawning' || persisted.status === 'stopping'
      if (wasLive) {
        session.exitReason = 'server-restart'
        session.exitedAt = Date.now()
      }
      session.promptCount = persisted.promptCount ?? 0
      this.wire(session)
      this.sessions.set(session.id, session)
    }
    if (this.sessions.size) log.info(`恢复 ${this.sessions.size} 个历史会话`)
    this.persist()
  }

  autoStart() {
    for (const template of this.templates.list()) {
      if (template.autoStart && template.enabled) {
        try {
          this.spawn(template.id, {})
        } catch (err) {
          log.error(`autoStart ${template.id} 失败`, err)
        }
      }
    }
  }

  startPeriodicSnapshots() {
    this.snapshotTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.isRunning) void this.saveSnapshotSafe(session)
      }
    }, PERIODIC_SNAPSHOT_MS)
    this.refreshTrafficStates()
    this.trafficTimer = setInterval(() => this.refreshTrafficStates(), TRAFFIC_MONITOR_MS)
    this.nameTimer = setInterval(() => this.refreshNames(), NAME_EVOLVE_MS)
  }

  async shutdown() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.trafficTimer) clearInterval(this.trafficTimer)
    if (this.nameTimer) clearInterval(this.nameTimer)
    const running = [...this.sessions.values()].filter((s) => s.isRunning)
    await Promise.allSettled(running.map((s) => this.saveSnapshotSafe(s)))
    for (const session of running) session.stop()
    this.persistence.flush()
  }

  // ---- 动词 ----

  spawn(
    templateId: string,
    opts: {
      cwd?: string
      name?: string
      resumeClaudeSessionId?: string
      extraArgs?: string[]
      agentBindingPrompt?: string
      /** 项目内 spawn：绑定 room 归属（删项目级联删专属会话用） */
      roomId?: string
    }
  ): SessionSummary {
    const template = this.templates.get(templateId)
    if (!template) throw new Error(`模板不存在: ${templateId}`)
    if (!template.enabled) throw new Error(`模板已停用: ${templateId}`)

    const runningCount = [...this.sessions.values()].filter((s) => s.isRunning).length
    const maxSessions = this.config.server.maxSessions
    if (maxSessions > 0 && runningCount >= maxSessions) {
      throw new Error(`运行中会话已达上限 ${maxSessions}`)
    }

    // 从历史恢复：claude --resume 只能有一个进程占用同一会话文件
    const claudeHome = effectiveClaudeHome(template)
    const resumeId = opts.resumeClaudeSessionId?.trim() || null
    if (resumeId) {
      if (claudeHome === null) throw new Error('该模板不是 claude 系，不支持恢复历史会话')
      const occupied = [...this.sessions.values()].find((s) => s.claudeSessionId === resumeId && s.isRunning)
      if (occupied) throw new Error(`该历史会话已在运行: ${occupied.name}`)
    }

    const sameTemplate = [...this.sessions.values()].filter((s) => s.templateId === templateId).length
    const customName = opts.name?.trim()
    // cwd 入口统一 trim：记录与 spawn 用同一份，带首尾空白的合法路径不再静默落到 HOME
    const cwd = opts.cwd?.trim() || template.cwd
    const session = new Session({
      id: crypto.randomUUID(),
      name: customName || `${template.name} #${sameTemplate + 1}`,
      autoNamed: !customName, // 占位名：首条 sendline 用第一句话替换
      templateId: template.id,
      command: template.command,
      args: template.args,
      cwd,
      color: template.color,
      claudeSessionId: resumeId ?? (claudeHome !== null ? crypto.randomUUID() : null),
      claudeHome,
      roomId: opts.roomId ?? null,
    })
    this.wire(session)
    this.sessions.set(session.id, session)
    if (opts.agentBindingPrompt) session.setAgentBindingPrompt(opts.agentBindingPrompt)
    session.spawnProcess(
      buildSpawnSpec(template, {
        cwd,
        claudeSessionId: session.claudeSessionId,
        resume: Boolean(resumeId),
        extraArgs: opts.extraArgs,
      })
    )
    this.persist()
    return session.toSummary()
  }

  get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`会话不存在: ${id}`)
    return session
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.toSummary())
  }

  stop(id: string) {
    this.get(id).stop()
  }

  kill(id: string) {
    this.get(id).kill()
  }

  /**
   * 重启。resume=true 时按 agent 能力原生恢复对话：
   *  - claude 系有 id → --resume <id>；无 id（模板 claudeHome 曾丢失的存量）→ 按定位文件回填转正
   *  - codex → `codex resume <session_id>`（rollout 首行 meta）
   *  - workbuddy(codebuddy) → `--resume <文件名 uuid>`
   *  - kimi → `-S <session_x>`（wire.jsonl 路径提取，须放命令行最后——走 extraArgs 天然在最后）
   *  - reasonix → `--resume` 原生选择器（其 CLI 无按 id 非交互恢复）
   * 恢复凭据找不到时退化为全新重启（不报错——能起来比报错有用）。
   */
  restart(id: string, resume = false): SessionSummary {
    const session = this.get(id)
    if (session.isRunning) throw new Error('会话仍在运行，请先停止')
    const template = this.templates.get(session.templateId)
    if (!template) throw new Error(`原模板已删除: ${session.templateId}`)
    session.archived = false // 归档态会话重启即回看板

    let extraArgs: string[] | undefined
    let resumeClaude = false
    let didResume = false
    let resumedTraffic: { state: Exclude<TrafficState, 'exited'>; fingerprint: string } | null = null
    if (resume) {
      const kind = agentKindOf(session.command)
      if (session.claudeSessionId) {
        resumeClaude = true
        didResume = true
      } else if (kind === 'reasonix') {
        extraArgs = ['--resume']
      } else if (kind === 'codex') {
        const file = locateAgentFile(session, kind)
        const sid = session.agentSessionId || (file ? codexSessionIdOf(file) : '')
        if (sid) {
          extraArgs = ['resume', sid]
          didResume = true
        }
      } else if (kind === 'workbuddy') {
        const file = locateAgentFile(session, kind)
        const sid = session.agentSessionId || (file ? path.basename(file, '.jsonl') : '')
        if (sid) {
          extraArgs = ['--resume', sid]
          didResume = true
        }
      } else if (kind === 'kimi') {
        const file = locateAgentFile(session, kind)
        const sid = session.agentSessionId || (file ? kimiSessionIdOf(file) : '')
        if (sid) {
          extraArgs = ['-S', sid]
          didResume = true
        }
      } else {
        const home = effectiveClaudeHome(template)
        const file = home ? locateClaudeTranscript(session, home) : null
        if (file) {
          session.claudeSessionId = path.basename(file, '.jsonl')
          session.claudeHome = home
          resumeClaude = true
          didResume = true
          log.info(`回填 claude 会话 id ${session.id.slice(0, 8)} → ${session.claudeSessionId}`)
        }
      }
      if (!didResume && !extraArgs) {
        // 用户点的是「恢复对话」却拿不到任何恢复凭据——静默开新会话必须留痕（reasonix 有 extraArgs 不算退化）
        log.warn(`恢复凭据未找到，退化为全新重启 ${session.id.slice(0, 8)}（${session.name}，${kind ?? 'claude'}）`)
      }
      if (didResume) {
        const source = this.trafficSnapshot(session)
        resumedTraffic = source
          ? { state: this.readTrafficState(session, source), fingerprint: source.fingerprint }
          : null
        // 重启前进程必已死（上方 isRunning 已拦截），尾部 working 只会是死 turn 残骸：
        // 钳为 needs-user，避免恢复后指纹不再变化、红灯卡死
        if (resumedTraffic?.state === 'working') resumedTraffic.state = 'needs-user'
      }
    } else {
      session.clearAgentBinding()
      // 非 resume 重启即换新对话文件：定位/解析缓存同步清掉，否则缓存命中旧路径，对话视图冻结在旧文件
      dropAgentTranscriptCache(session.id)
    }

    session.spawnProcess(
      buildSpawnSpec(template, {
        cwd: session.cwd,
        claudeSessionId: session.claudeSessionId,
        resume: resumeClaude,
        extraArgs,
      })
    )
    if (resumedTraffic) {
      session.setTrafficState(resumedTraffic.state)
      this.trafficFingerprints.set(session.id, resumedTraffic.fingerprint)
    }
    this.persist()
    this.emit('epoch', session.id)
    return session.toSummary()
  }

  /** 重命名：显式命名即转正（autoNamed 清除，之后 sendline/session-namer 都不再动它） */
  rename(id: string, name: string): SessionSummary {
    const session = this.get(id)
    const trimmed = name.replace(/\s+/g, ' ').trim()
    if (!trimmed) throw new Error('名称不能为空')
    session.name = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
    session.autoNamed = false
    this.nameTrackers.delete(id)
    this.persist()
    const summary = session.toSummary()
    this.emit('update', summary)
    return summary
  }

  /** 钉选/取消「总台」：只改标记，任何状态可切；加成员列表置顶认此字段（改名不影响）。
   *  钉选时顺手把会话重命名为「总台·<模板名>」（显式命名口径：autoNamed 锁定，session-namer 不再演化）；
   *  取消钉选不动名字（2026-07-21 维护者定） */
  setPinned(id: string, pinned: boolean): SessionSummary {
    const session = this.get(id)
    session.pinned = pinned
    if (pinned && !session.name.startsWith('总台')) {
      const tplName = this.templates.get(session.templateId)?.name ?? session.command.split('/').pop() ?? ''
      const name = `总台·${tplName}`
      if (name !== session.name) {
        session.name = name.length > 80 ? `${name.slice(0, 79)}…` : name
        session.autoNamed = false
        this.nameTrackers.delete(id)
      }
    }
    this.persist()
    const summary = session.toSummary()
    this.emit('update', summary)
    return summary
  }

  /** 归档/取消归档：只改看板可见性，元数据、终端快照、agent 对话日志全保留。
   *  运行中归档复用删除的"先停后归档"链路（维护者 2026-07-21）：标记 pendingArchive + stop，进程退出事件再落 archived */
  setArchived(id: string, archived: boolean): SessionSummary {
    const session = this.get(id)
    // 归档运行中会话：先优雅停止，exit 事件命中 pendingArchive 再设 archived（与 remove 先停后删同口径）
    if (archived && session.isRunning) {
      if (this.pendingArchive.has(session.id)) return session.toSummary() // 已在停止归档中，防重复
      this.pendingArchive.add(session.id)
      session.stop()
      return session.toSummary()
    }
    // 取消归档：若仍在「先停后归档」窗口内，一并摘掉 pendingArchive，否则进程退出事件仍会把它落 archived
    if (!archived) this.pendingArchive.delete(session.id)
    session.archived = archived
    this.persist()
    const summary = session.toSummary()
    this.emit('update', summary)
    return summary
  }

  /** 解绑项目归属（会话被移出项目时调用）：只解匹配的 roomId，防误清别的绑定 */
  unbindRoom(id: string, roomId: string) {
    const session = this.sessions.get(id)
    if (!session || session.roomId !== roomId) return
    session.roomId = null
    this.persist()
  }

  remove(id: string) {
    const session = this.get(id)
    // 运行中：先优雅停止（session.stop = SIGTERM → 5s 兜底 SIGKILL），进程退出事件再走完整删除。
    // 维护者 2026-07-20：分解为"先停再删"，比直接 SIGKILL 体面——给 agent 优雅退出机会，复用正规停止链路。
    if (session.isRunning) {
      if (this.pendingRemove.has(session.id)) return // 已在停止删除中，防重复触发
      this.pendingRemove.add(session.id)
      session.stop()
      return
    }
    this.cleanupRemoved(session)
  }

  /** 真正的删除清理：dispose + 摘除会话 + 清各路缓存 + emit removed（已退出 / 停止后调用） */
  private cleanupRemoved(session: Session) {
    session.dispose()
    this.sessions.delete(session.id)
    this.persistence.deleteSnapshot(session.id)
    dropAgentTranscriptCache(session.id)
    this.trafficFingerprints.delete(session.id)
    this.nameTrackers.delete(session.id)
    this.trustConfirmed.delete(session.id)
    this.pendingRemove.delete(session.id)
    this.pendingArchive.delete(session.id) // 与 pendingRemove 同口径清掉，防删除后残留标记泄漏
    this.persist()
    this.emit('removed', session.id)
  }

  // ---- 内部 ----

  /** 每会话已自动确认过 trust 页的 epoch（codebuddy 每个新进程都弹，答一次即可） */
  private trustConfirmed = new Map<string, number>()
  /** 运行中删除标记：remove 时先 stop，exit 事件命中此集合再走完整删除 */
  private pendingRemove = new Set<string>()
  /** 运行中归档标记：archive 时先 stop，exit 事件命中此集合再落 archived（与 pendingRemove 同链路） */
  private pendingArchive = new Set<string>()
  private static readonly TRUST_PROMPT = /Trust folder only|Enter to confirm • Esc to exit/
  private static readonly TRUST_WINDOW_MS = 120_000

  /**
   * codebuddy 每个新进程都弹「信任目录」确认页（cwd=HOME 时尤甚），会吞掉注入的首条输入。
   * 从 pty 输出检测到确认页即自动回车（默认选中 Trust folder only）——确定性过页，
   * 不赌启动时序；只在进程启动后 2 分钟内生效且每 epoch 一次，防对话正文同款文字误触发。
   */
  private maybeConfirmTrustPage(session: Session, data: string, epoch: number) {
    if (path.basename(session.command) !== 'codebuddy') return
    if (this.trustConfirmed.get(session.id) === epoch) return
    if (!session.isRunning || !session.startedAt) return
    if (Date.now() - session.startedAt > SessionManager.TRUST_WINDOW_MS) return
    // TUI 渲染的 ANSI 转义可能插在文字中间，先剥掉再匹配（仅启动窗口内有此开销）
    // eslint-disable-next-line no-control-regex
    const plain = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    if (!SessionManager.TRUST_PROMPT.test(plain)) return
    this.trustConfirmed.set(session.id, epoch)
    try {
      session.write('\r', { markWorking: false })
      log.info(`codebuddy trust 确认页自动回车 ${session.id.slice(0, 8)}（epoch ${epoch}）`)
    } catch {
      /* 会话可能恰好退出 */
    }
  }

  private wire(session: Session) {
    session.on('update', () => {
      this.persist()
      this.emit('update', session.toSummary())
    })
    session.on('output', (data: string, offset: number, epoch: number) => {
      this.maybeConfirmTrustPage(session, data, epoch)
      this.emit('output', session.id, data, offset, epoch)
    })
    session.on('exit', () => {
      if (this.pendingRemove.has(session.id)) {
        this.cleanupRemoved(session) // 待删除会话：退出即清，跳过存快照
        return
      }
      if (this.pendingArchive.has(session.id)) {
        // 待归档会话：停止完成即落 archived，保留快照与日志
        this.pendingArchive.delete(session.id)
        session.archived = true
        this.persist()
        this.emit('update', session.toSummary())
        void this.saveSnapshotSafe(session)
        return
      }
      void this.saveSnapshotSafe(session)
    })
  }

  private refreshTrafficStates() {
    for (const session of this.sessions.values()) {
      if (!session.isRunning) continue
      try {
        const source = this.trafficSnapshot(session)
        if (!source || this.trafficFingerprints.get(session.id) === source.fingerprint) {
          // 裸回车/粘贴触发的 working：transcript 2s 无动静说明没起任务，按现尾部重算兜底
          if (
            session.trafficState === 'working' &&
            session.workingFromInput &&
            Date.now() - session.trafficUpdatedAt > 2000
          ) {
            session.workingFromInput = false
            // source 为 null（transcript 缺失）时无尾可算，也要复位 working——否则红灯卡死。
            // 只动 workingFromInput 触发的假 working，真实任务状态（指纹变化分支）不受影响
            session.setTrafficState(source ? this.readTrafficState(session, source) : 'idle')
            continue
          }
          // 无 transcript 的通用会话（hermes/shell 等，agentKindOf 查无此 kind）：
          // sendline 提交的 working 没有任何路径复位（红灯卡死实锤 2026-07-22 Hermes #2）。
          // 兜底用输出活动：干活必持续输出，静默 15s 即闲。15s 余量覆盖慢模型 TTFB。
          if (!source && session.trafficState === 'working' && Date.now() - session.lastOutputAt > 15_000) {
            session.setTrafficState('idle')
          }
          continue
        }
        session.setTrafficState(this.readTrafficState(session, source))
        this.trafficFingerprints.set(session.id, source.fingerprint)
      } catch (err) {
        log.warn(`红绿灯判定失败 ${session.id.slice(0, 8)}`, err)
      }
    }
  }

  // ---- 演化命名（session-namer）----

  /**
   * 跟随 agent 原生标题/最新 prompt 演化会话名：只服务 autoNamed（未被手动 rename 锁定）会话。
   * claude 系只跟 custom-title（保留 Claude 自己的命名）；kimi 优先 state.json 原生标题；
   * codex/qclaw/reasonix/workbuddy 无原生标题时用最新用户 prompt 演化。增量扫描，10s 一轮。
   */
  private refreshNames() {
    for (const session of this.sessions.values()) {
      if (!session.autoNamed) {
        this.nameTrackers.delete(session.id)
        continue
      }
      const prev = this.nameTrackers.get(session.id)
      if (prev && !session.isRunning && prev.stablePasses >= 2) continue // 已退出且文件收尾，封板
      try {
        const source = this.trafficSource(session)
        if (!source) continue
        const st = fs.statSync(source.path)
        let entry = this.nameTrackers.get(session.id)
        if (!entry || entry.path !== source.path) {
          entry = { path: source.path, tracker: new NameTracker(), stablePasses: 0 }
          this.nameTrackers.set(session.id, entry)
        }
        entry.tracker.resetIfShrunk(st.size)
        const from = entry.tracker.cursor
        if (st.size === from) {
          entry.stablePasses += 1
          continue
        }
        entry.stablePasses = 0
        const fd = fs.openSync(source.path, 'r')
        try {
          const buf = Buffer.allocUnsafe(st.size - from)
          fs.readSync(fd, buf, 0, buf.length, from)
          entry.tracker.feed(buf, source.kind ?? 'claude')
        } finally {
          fs.closeSync(fd)
        }
        const candidate =
          source.kind === 'kimi'
            ? kimiTitleOf(source.path) || nameCandidateOf(entry.tracker, source.kind)
            : nameCandidateOf(entry.tracker, source.kind ?? 'claude')
        if (candidate && session.evolveName(candidate)) {
          log.info(`会话 ${session.id.slice(0, 8)} 演化改名 → ${candidate}`)
        }
      } catch (err) {
        log.warn(`演化命名失败 ${session.id.slice(0, 8)}`, err)
      }
    }
  }

  private trafficSnapshot(
    session: Session
  ): { path: string; kind: ReturnType<typeof agentKindOf>; fingerprint: string } | null {
    const source = this.trafficSource(session)
    if (!source) return null
    const fingerprint = transcriptFingerprint(source.path)
    if (!fingerprint) return null
    return { ...source, fingerprint }
  }

  private readTrafficState(
    session: Session,
    source = this.trafficSnapshot(session)
  ): Exclude<TrafficState, 'exited'> {
    if (!source) return 'working'
    return source.kind
      ? readAgentTrafficState(session, source.kind, source.path)
      : readClaudeTrafficState(source.path)
  }

  private trafficSource(session: Session): { path: string; kind: ReturnType<typeof agentKindOf> } | null {
    if (session.claudeSessionId) {
      const file = transcriptPath(session)
      return file ? { path: file, kind: null } : null
    }
    const kind = agentKindOf(session.command)
    if (kind) {
      // 占用闸：目标底层会话若已被另一活会话占用，bindFromPools 不绑也不读
      // （占用文件不进候选池；旧版"返回文件供读取"会让本卡读别人的 transcript 演化成幽灵卡）
      const occupied = (sid: string) =>
        [...this.sessions.values()].some((s) => s !== session && s.agentSessionId === sid && s.isRunning)
      const file = locateAgentFile(session, kind, occupied)
      return file ? { path: file, kind } : null
    }
    const template = this.templates.get(session.templateId)
    const home = template ? effectiveClaudeHome(template) : null
    const file = home ? locateClaudeTranscript(session, home) : null
    return file ? { path: file, kind: null } : null
  }

  private async saveSnapshotSafe(session: Session) {
    try {
      if (!session.hasLiveShadow) return
      const snap = await session.snapshot()
      this.persistence.saveSnapshot(session.id, snap)
    } catch (err) {
      log.warn(`快照失败 ${session.id.slice(0, 8)}`, err)
    }
  }

  private persist() {
    this.persistence.saveSessions(this.list())
  }
}
