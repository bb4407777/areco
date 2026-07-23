// 单会话对象：pty + @xterm/headless 影子终端 + produced/shadowProcessed 双计数器 + drain 内同步快照。
// 同一份字节流同时喂影子终端与浏览器，快照 offset 永远落在 chunk 边界（实现模式署名见仓根 NOTICE）。
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type { IPty } from 'node-pty'
import { spawn as ptySpawn } from 'node-pty'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ExitReason, SessionStatus, SessionSummary } from '../../../shared/protocol'
import { terminalInputStartsTask, screenHasPendingChoice, type TrafficState } from '../../../shared/traffic'
import type { SpawnSpec } from './templates'
import { promptLabel } from './history'
import { isNameWorthy } from './session-namer'
import { createLogger } from '../logger'

const log = createLogger('session')

const SHADOW_SCROLLBACK = 5000
const SERIALIZE_SCROLLBACK = 1000
const LAST_LINE_THROTTLE_MS = 1000
const STOP_GRACE_MS = 5000
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30

export interface SessionSnapshot {
  epoch: number
  data: string
  offset: number
  cols: number
  rows: number
  savedAt: number
}

export interface SessionInit {
  id: string
  name: string
  /** true = 名称是自动占位，首条 sendline 用第一句话替换 */
  autoNamed?: boolean
  templateId: string
  command: string
  args: string[]
  cwd: string
  color: string
  claudeSessionId: string | null
  claudeHome?: string | null
  /** claude 布局 transcript 的 projects 根（模板声明/自动探测解析结果；null = 无对话视图） */
  transcriptDir?: string | null
  /** 项目归属（room id）：项目内 spawn 的专属会话；缺省/null = 游离会话 */
  roomId?: string | null
  createdAt?: number
}

/**
 * 事件：
 *  - 'output' (data, offset, epoch)：pty 原始输出（offset = 块末尾累计位置）
 *  - 'update'：summary 字段变化（状态/lastLine/…）
 *  - 'exit'：进程退出（update 之外单发，供落盘快照）
 */
export class Session extends EventEmitter {
  readonly id: string
  name: string
  autoNamed: boolean
  readonly templateId: string
  readonly command: string
  readonly args: string[]
  cwd: string
  readonly color: string
  claudeSessionId: string | null
  // 可回填：claude 包装器无 id 的存量会话，原生恢复重启时按定位文件转正（见 manager.restart）
  claudeHome: string | null
  /** claude 布局 transcript 的 projects 根（spawn 时从模板解析并钉死） */
  transcriptDir: string | null
  agentSessionId: string | null
  agentBindingHash: string | null
  readonly createdAt: number

  status: SessionStatus = 'exited'
  pid: number | null = null
  epoch = 0
  startedAt: number | null = null
  exitedAt: number | null = null
  exitCode: number | null = null
  exitReason: ExitReason = null
  trafficState: TrafficState = 'exited'
  trafficUpdatedAt = Date.now()
  /** 本次 working 是终端键入（裸回车/粘贴）触发的：transcript 若无动静，监视器隔 2s 按尾部重算兜底 */
  workingFromInput = false
  lastLine = ''
  cols = DEFAULT_COLS
  rows = DEFAULT_ROWS
  promptCount = 0
  /** 首条 prompt 已落地命名过：之后 sendline 不再动名，演化交给 session-namer */
  firstPromptNamed = false
  totalOutputChars = 0
  /** 最近一次 pty 输出时间（无 transcript 的通用会话红绿灯兜底用：干活必有输出，静默即闲） */
  lastOutputAt = 0
  archived = false
  /** 钉选为「总台」：房间加成员列表置顶，改名不影响（命名演化可能改掉「总台」前缀） */
  pinned = false
  /** 项目归属（room id）：项目内 spawn 的专属会话随项目级联删除；null = 游离会话 */
  roomId: string | null

  /** 本进程生命周期内是否有过活的影子终端（restored 会话没有，attach 走落盘快照） */
  hasLiveShadow = false

  private pty: IPty | null = null
  private shadow: Terminal | null = null
  private serializer: SerializeAddon | null = null
  private produced = 0
  private shadowProcessed = 0
  private killedBy: 'stop' | 'kill' | null = null
  private stopTimer: NodeJS.Timeout | null = null
  private lastLineTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(init: SessionInit) {
    super()
    this.id = init.id
    this.name = init.name
    this.autoNamed = init.autoNamed ?? false
    this.templateId = init.templateId
    this.command = init.command
    this.args = init.args
    this.cwd = init.cwd
    this.color = init.color
    this.claudeSessionId = init.claudeSessionId
    this.claudeHome = init.claudeHome ?? null
    this.transcriptDir = init.transcriptDir ?? null
    this.agentSessionId = null
    this.agentBindingHash = null
    this.roomId = init.roomId ?? null
    this.createdAt = init.createdAt ?? Date.now()
  }

  /** 启动（或 restart 后再启动）。调用前必须处于非运行态。 */
  spawnProcess(spec: SpawnSpec) {
    if (this.pty) throw new Error(`会话 ${this.id} 已在运行`)
    this.epoch += 1
    this.produced = 0
    this.shadowProcessed = 0
    this.killedBy = null
    this.exitCode = null
    this.exitReason = null
    this.exitedAt = null
    this.setTrafficState('idle')
    this.cwd = spec.cwd
    this.rebuildShadow()

    this.status = 'spawning'
    try {
      this.pty = ptySpawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: spec.cwd,
        env: spec.env as { [key: string]: string },
      })
    } catch (err) {
      this.status = 'error'
      this.exitReason = 'crash'
      this.exitedAt = Date.now()
      this.setTrafficState('exited')
      this.emitUpdate()
      throw err
    }

    this.pid = this.pty.pid
    this.startedAt = Date.now()
    this.status = 'running'

    const currentEpoch = this.epoch
    this.pty.onData((data) => {
      if (this.epoch !== currentEpoch) return
      this.produced += data.length
      this.totalOutputChars += data.length
      this.lastOutputAt = Date.now()
      this.emit('output', data, this.produced, currentEpoch)
      this.shadow?.write(data, () => {
        if (this.epoch === currentEpoch) this.shadowProcessed += data.length
      })
      this.scheduleLastLine()
    })
    this.pty.onExit(({ exitCode }) => {
      if (this.epoch !== currentEpoch) return
      this.handleExit(exitCode)
    })

    log.info(`spawn ${this.name}（${this.id.slice(0, 8)}）pid=${this.pid} cwd=${spec.cwd} epoch=${this.epoch}`)
    this.emitUpdate()
  }

  private rebuildShadow() {
    this.shadow?.dispose()
    this.shadow = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: SHADOW_SCROLLBACK,
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.shadow.loadAddon(this.serializer)
    this.hasLiveShadow = true
  }

  /**
   * drain 后同步序列化：write('', cb) 的 cb 触发时，影子终端已消化到 shadowProcessed，
   * 且回调内同步取值+序列化期间不会有新块插入（JS 单线程），快照精确覆盖到 offset。
   */
  snapshot(): Promise<SessionSnapshot> {
    return new Promise((resolve, reject) => {
      if (!this.shadow || !this.serializer) {
        reject(new Error('无活动影子终端'))
        return
      }
      const shadow = this.shadow
      const epoch = this.epoch
      shadow.write('', () => {
        try {
          resolve({
            epoch,
            offset: this.shadowProcessed,
            data: this.serializer!.serialize({ scrollback: SERIALIZE_SCROLLBACK }),
            cols: this.cols,
            rows: this.rows,
            savedAt: Date.now(),
          })
        } catch (err) {
          reject(err as Error)
        }
      })
    })
  }

  resize(cols: number, rows: number) {
    const c = Math.max(2, Math.min(500, Math.floor(cols)))
    const r = Math.max(2, Math.min(200, Math.floor(rows)))
    if (c === this.cols && r === this.rows) return
    this.cols = c
    this.rows = r
    try {
      this.pty?.resize(c, r)
    } catch {
      /* pty 可能刚退出 */
    }
    this.shadow?.resize(c, r)
  }

  write(data: string, opts?: { markWorking?: boolean }) {
    if (this.status !== 'running' && this.status !== 'spawning') {
      throw new Error('会话未在运行')
    }
    if (opts?.markWorking !== false && terminalInputStartsTask(data) && this.trafficState !== 'working') {
      this.setTrafficState('working')
      this.workingFromInput = true
    }
    // 拆帧防粘贴误判：「文本+回车同帧到达」时 kimi/codebuddy 等 TUI 按粘贴处理，
    // 回车被当换行插入而非提交（手机端 IME 上屏后立刻点发送，两条 WS 消息极易并入
    // 同一 TCP 帧，用户表现为"字被吞/发送没反应"，2026-07-20 协议级复现）。
    // 与 sendline 同口径：尾回车延迟 300ms 单独写，模拟真实键入。单独一个 '\r' 不拆。
    if (data.length > 1 && data.endsWith('\r')) {
      this.pty?.write(data.slice(0, -1))
      setTimeout(() => {
        try {
          if (this.isRunning) this.pty?.write('\r')
        } catch {
          /* 会话可能已退出 */
        }
      }, 300)
      return
    }
    this.pty?.write(data)
  }

  sendline(text: string, opts?: { autoName?: boolean }) {
    // 先校验运行态再置 working（与 write() 同顺序）：已退出会话走到这里会抛错，
    // 若先置状态会留下持久化的假 working，无任何路径复位
    if (this.status !== 'running' && this.status !== 'spawning') {
      throw new Error('会话未在运行')
    }
    this.setTrafficState('working')
    this.workingFromInput = false // 明确提交任务：transcript 随即落盘，不做空转兜底重算
    // 尾部 CR/LF 一律剥掉，回车由本方法统一补一个：否则文本带尾回车时 write() 的尾回车
    // 拆分分支（见下）会再补一个，两个 \r 前后脚到达——codex 表现为"要按两次 enter"，
    // 或两回车并帧被 TUI 当粘贴、后一个沦为换行（2026-07-23 维护者报障 #1/#2 同源）。
    const body = text.replace(/[\r\n]+$/, '')
    // markWorking:false —— working 态本方法已显式置好，且 body 已无尾回车不触发 write 拆分
    if (body) this.write(body, { markWorking: false })
    this.writeEnterWhenSettled()
    this.promptCount += 1
    if (!this.agentSessionId) this.setAgentBindingPrompt(text)
    // 占位名会话：第一句话即会话名（与历史对话标题同口径）。程序化注入（交接档案提示等）传 autoName:false 跳过。
    // 只在首条「有意义」prompt 命名（好/ok/继续 等确认词不够格，占位名等下一条）；autoNamed 保持 true——
    // 之后由 session-namer 跟随 agent 原生标题/最新 prompt 演化，用户手动 rename 才把 autoNamed 转 false 永久锁定
    if (this.autoNamed && !this.firstPromptNamed && opts?.autoName !== false) {
      const label = promptLabel(text)
      if (label && isNameWorthy(label)) {
        this.firstPromptNamed = true
        this.name = label
        this.emitUpdate()
      }
    }
    this.emitUpdate()
  }

  /**
   * 文本写完后补一个提交回车。旧实现固定延迟 300ms——pty 忙/TUI 重绘慢时 \r 与残余文本并帧，
   * 被 kimi/codebuddy 等按粘贴处理、回车沦为换行（2026-07-23 报障 #2「enter 变换行」）。
   * 改为等 pty 输出安静一小段（TUI 已消化完文本、光标停稳）再补回车，使其作为独立击键被判为提交。
   * ENTER_QUIET_MS 远小于 onceQuiet 的首屏 1200ms：只需跨过 TUI 的粘贴合帧窗口（实测数十 ms）。
   * ENTER_MAX_WAIT_MS 兜底：持续输出的会话不会让回车无限拖着不发。
   */
  private writeEnterWhenSettled() {
    const startAt = this.lastOutputAt
    const startedTs = Date.now()
    const tryFire = () => {
      if (!this.isRunning) return
      const quietFor = Date.now() - this.lastOutputAt
      const waited = Date.now() - startedTs
      // 输出已安静足够久，或等满兜底上限：补回车提交
      if (quietFor >= Session.ENTER_QUIET_MS || waited >= Session.ENTER_MAX_WAIT_MS) {
        try {
          this.pty?.write('\r')
        } catch {
          /* 会话可能已退出 */
        }
        return
      }
      setTimeout(tryFire, Session.ENTER_QUIET_MS)
    }
    // 首次等一个安静窗口起步（startAt 仅用于说明语义：从本次写入后的输出算起）
    void startAt
    setTimeout(tryFire, Session.ENTER_QUIET_MS)
  }

  /** 演化改名（session-namer 专用）：未被手动 rename 锁定才生效；autoNamed 保持 true 可持续演化 */
  evolveName(label: string): boolean {
    if (!this.autoNamed) return false
    const name = label.trim()
    if (!name || name === this.name) return false
    this.name = name
    this.emitUpdate()
    return true
  }

  bindAgentSession(id: string) {
    if (!id || this.agentSessionId === id) return
    this.agentSessionId = id
    this.emitUpdate()
  }

  setAgentBindingPrompt(text: string) {
    if (this.agentSessionId || this.agentBindingHash || !text.trim()) return
    this.agentBindingHash = crypto.createHash('sha256').update(normalizeBindingText(text)).digest('hex')
    this.emitUpdate()
  }

  clearAgentBinding() {
    if (!this.agentSessionId && !this.agentBindingHash) return
    this.agentSessionId = null
    this.agentBindingHash = null
    this.emitUpdate()
  }

  setTrafficState(state: TrafficState) {
    if (this.trafficState === state) return
    this.trafficState = state
    this.trafficUpdatedAt = Date.now()
    this.emitUpdate()
  }

  pause() {
    try {
      this.pty?.pause()
    } catch {
      /* ignore */
    }
  }

  resume() {
    try {
      this.pty?.resume()
    } catch {
      /* ignore */
    }
  }

  stop() {
    if (!this.pty) return
    this.killedBy = this.killedBy ?? 'stop'
    this.status = 'stopping'
    this.emitUpdate()
    try {
      this.pty.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    // 重复 stop 会覆盖 stopTimer 句柄：先清掉旧定时器，否则孤定时器到点 SIGKILL 误伤 restart 后的新进程
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      if (this.pty) {
        log.warn(`${this.name} SIGTERM ${STOP_GRACE_MS}ms 未退出，升级 SIGKILL`)
        try {
          this.pty.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, STOP_GRACE_MS)
  }

  kill() {
    if (!this.pty) return
    this.killedBy = 'kill'
    try {
      this.pty.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }

  get isRunning(): boolean {
    return this.status === 'running' || this.status === 'spawning' || this.status === 'stopping'
  }

  /**
   * 输出安静 quietMs 后回调一次（TUI 首屏画完的近似）：交接提示等程序化注入用它
   * 替代固定延时——冷启动 10s+ 的 agent，固定 3s 会把提示打进启动画面丢失。
   * maxWaitMs 兜底：一直有输出（spinner 动画等）也最迟在此时限触发；会话提前退出即取消。
   */
  /** trust 确认页特征（与 session-manager.TRUST_PROMPT 一致）；onceQuiet 遇它不计 quiet */
  private static readonly TRUST_PAGE_RE = /Trust folder only|Enter to confirm • Esc to exit/
  /** 启动下限：spawn 后多久内不允许 onceQuiet fire。codex 经 zsh -ilc 冷启动有数秒静默窗口，
   *  quiet 若在此期间 fire，注入文本会落在 TUI 接管 tty（raw mode）之前——canonical 模式下
   *  \r 被 ICRNL 转成 \n，只换行不提交，agent 一直等用户手动回车（2026-07-21 实锤） */
  private static readonly MIN_BOOT_MS = 8000
  /** 提交回车的安静窗口：跨过 TUI 粘贴合帧窗口即可（实测数十 ms），取 120ms 留裕量 */
  private static readonly ENTER_QUIET_MS = 120
  /** 提交回车兜底上限：持续输出的会话不让回车无限拖着；到点无条件补 \r */
  private static readonly ENTER_MAX_WAIT_MS = 2000
  onceQuiet(fn: () => void, quietMs = 1200, maxWaitMs = 30_000) {
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const fire = () => {
      if (done) return
      // 启动下限未满足则延后重试，不消耗这次 fire（maxTimer 早 fire 同理被兜住）
      const bootElapsed = Date.now() - (this.startedAt ?? this.createdAt)
      if (bootElapsed < Session.MIN_BOOT_MS) {
        quietTimer = setTimeout(fire, Session.MIN_BOOT_MS - bootElapsed)
        return
      }
      done = true
      cleanup()
      if (this.isRunning) fn()
    }
    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(maxTimer)
      this.off('output', onOutput)
      this.off('exit', onExit)
    }
    // trust 页检测用滚动窗口（剥 ANSI 后的最近 2KB）：TUI 渲染的转义码可能插在
    // 文字中间、长文本也可能被切成多个 chunk——直接对原始 data 匹配会双双落空
    //（maybeConfirmTrustPage 同坑，那边先剥 ANSI 才匹配得上）。2026-07-21 实锤：
    // 未剥 ANSI 时此修复形同虚设，note 照样在 trust 等待期 fire 被吞。
    let trustTail = ''
    // eslint-disable-next-line no-control-regex
    const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
    const onOutput = (data: string) => {
      if (quietTimer) clearTimeout(quietTimer)
      // trust 确认页等待期不算 quiet：note 若在此 fire 会被打进 trust 页吞掉
      //（codebuddy resume 踩过：note 进 trust 输入被吞，agent 进对话后空待命）。
      // trust 页输出跳过本次计时，等 trust 确认后的下一段输出（进对话）再开始倒计时
      // eslint-disable-next-line no-control-regex
      trustTail = (trustTail + data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')).slice(-2000)
      if (Session.TRUST_PAGE_RE.test(trustTail)) return
      // 纯 OSC 序列（如 codex 空转 spinner 的窗口标题刷新，~100ms 一次）不算活动：
      // 否则 quiet 计时被无限重置，注入恒拖满 maxWaitMs 才发
      if (!data.replace(OSC_RE, '').trim()) return
      quietTimer = setTimeout(fire, quietMs)
    }
    const onExit = () => {
      done = true
      cleanup()
    }
    const maxTimer = setTimeout(fire, maxWaitMs)
    this.on('output', onOutput)
    this.on('exit', onExit)
    // spawn 后完全无输出的极端情形：quiet 计时也从现在起算（空串不匹配 trust，正常计时）
    onOutput('')
  }

  private handleExit(exitCode: number) {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    this.pty = null
    this.pid = null
    this.exitedAt = Date.now()
    this.exitCode = exitCode
    this.exitReason =
      this.killedBy === 'stop' ? 'user-stop' : this.killedBy === 'kill' ? 'user-kill' : exitCode === 0 ? 'exit' : 'crash'
    this.status = 'exited'
    this.setTrafficState('exited')
    this.computeLastLine()
    log.info(`exit ${this.name}（${this.id.slice(0, 8)}）code=${exitCode} reason=${this.exitReason}`)
    this.emitUpdate()
    this.emit('exit')
  }

  /** 影子终端屏幕尾部若干行（对话模式「终端尾屏」面板用）：只读 buffer，不 attach、不扰动 pty 尺寸 */
  screenTail(maxLines = 16): string[] {
    if (!this.shadow) return []
    const buffer = this.shadow.buffer.active
    const lines: string[] = []
    let seenContent = false
    for (let y = buffer.length - 1; y >= 0 && lines.length < maxLines; y--) {
      const line = buffer.getLine(y)?.translateToString(true) ?? ''
      if (!seenContent && !line.trim()) continue // 跳过底部空白，保留内容区内部空行（菜单排版）
      seenContent = true
      lines.unshift(line)
    }
    return lines
  }

  /** 尾屏是否停在选择/确认对话框（claude 权限框/信任页只画在 TUI 里、不进 transcript）：黄灯兜底用 */
  hasPendingChoiceOnScreen(): boolean {
    return screenHasPendingChoice(this.screenTail(10))
  }

  /** 从影子终端 buffer 自底向上取第一个非空行（alt-screen 感知，替代 raw 流剥 ANSI） */
  private computeLastLine() {
    if (!this.shadow) return
    const buffer = this.shadow.buffer.active
    for (let y = buffer.length - 1; y >= 0; y--) {
      const line = buffer.getLine(y)?.translateToString(true).trim()
      if (line) {
        if (line !== this.lastLine) {
          this.lastLine = line.slice(0, 200)
          this.emitUpdate()
        }
        return
      }
    }
  }

  private scheduleLastLine() {
    if (this.lastLineTimer) return
    this.lastLineTimer = setTimeout(() => {
      this.lastLineTimer = null
      if (!this.disposed) this.computeLastLine()
    }, LAST_LINE_THROTTLE_MS)
  }

  private emitUpdate() {
    this.emit('update')
  }

  /** 恢复自持久化（服务器重启后）：无进程、无影子终端，attach 走落盘快照 */
  restoreFrom(persisted: Partial<SessionSummary>) {
    this.status = 'exited'
    this.pid = null
    this.epoch = persisted.epoch ?? 0
    this.startedAt = persisted.startedAt ?? null
    this.exitedAt = persisted.exitedAt ?? Date.now()
    this.exitCode = persisted.exitCode ?? null
    this.exitReason = persisted.exitReason ?? null
    this.trafficState = 'exited'
    this.trafficUpdatedAt = persisted.trafficUpdatedAt ?? Date.now()
    this.lastLine = persisted.lastLine ?? ''
    this.cols = persisted.cols ?? DEFAULT_COLS
    this.rows = persisted.rows ?? DEFAULT_ROWS
    this.promptCount = persisted.promptCount ?? 0
    // 重启前已发过 prompt 的占位名会话，首句命名已发生，sendline 不再抢 namer 的演化
    this.firstPromptNamed = this.promptCount > 0
    this.totalOutputChars = persisted.outputChars ?? 0
    this.archived = persisted.archived ?? false
    this.pinned = persisted.pinned ?? false
    this.autoNamed = persisted.autoNamed ?? false
    this.agentSessionId = persisted.agentSessionId ?? null
    this.agentBindingHash = persisted.agentBindingHash ?? null
    this.roomId = persisted.roomId ?? null // 旧 sessions.json 无此字段：补 null（游离），下一次落盘自然迁移
    this.hasLiveShadow = false
  }

  dispose() {
    this.disposed = true
    if (this.stopTimer) clearTimeout(this.stopTimer)
    if (this.lastLineTimer) clearTimeout(this.lastLineTimer)
    try {
      this.pty?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    this.pty = null
    this.shadow?.dispose()
    this.shadow = null
  }

  toSummary(): SessionSummary {
    return {
      id: this.id,
      name: this.name,
      autoNamed: this.autoNamed,
      templateId: this.templateId,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      color: this.color,
      status: this.status,
      pid: this.pid,
      epoch: this.epoch,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      exitCode: this.exitCode,
      exitReason: this.exitReason,
      trafficState: this.trafficState,
      trafficUpdatedAt: this.trafficUpdatedAt,
      lastLine: this.lastLine,
      cols: this.cols,
      rows: this.rows,
      claudeSessionId: this.claudeSessionId,
      claudeHome: this.claudeHome,
      transcriptDir: this.transcriptDir,
      agentSessionId: this.agentSessionId,
      agentBindingHash: this.agentBindingHash,
      promptCount: this.promptCount,
      outputChars: this.totalOutputChars,
      archived: this.archived,
      pinned: this.pinned,
      roomId: this.roomId,
    }
  }
}

function normalizeBindingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
