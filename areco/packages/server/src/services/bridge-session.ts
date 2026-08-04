// BridgeSession：hermes-bridge harness 的会话形态——不拉 pty，走 agent-bridge
// sidecar（设计 /tmp/bridge-design/design.md §5）。
//
// 与 pty 会话的关系：复用父类的 shadow 影子终端 / snapshot / 双计数器 / onceQuiet，
// 把 bridge 的流式增量与工具事件翻译成终端字节流喂进去——下游（屏幕尾屏、lastLine、
// 快照落盘、WS output 订阅）全部无感。trafficState 不再靠心跳猜：chat 起 = working，
// run done = idle，destroy = exited（设计 §5 第 5 点「收益最大处」）。
//
// MVP 取舍：审批/澄清事件只能看不能批（sidecar 还没接审批回调），原样渲进输出流；
// 恢复对话（restart resume）不支持——sidecar 会话在内存里，areco 重启即新对话。
import { Session, type SessionInit } from './session'
import type { SpawnSpec } from './templates'
import { ensureBridgeRuntime } from './bridge-runtime'
import type { AgentBridgeClient, BridgeEvent } from './agent-bridge'
import { promptLabel } from './history'
import { isNameWorthy } from './session-namer'
import { createLogger } from '../logger'

const log = createLogger('bridge-session')

/** bridge 会话无 TUI 冷启动：onceQuiet 注入不需要 8s/4s 下限，半秒足够 sidecar 就绪后第一轮开始 */
const BRIDGE_MIN_BOOT_MS = 500

export class BridgeSession extends Session {
  private client: AgentBridgeClient | null = null
  private runActive = false
  private abort: AbortController | null = null

  constructor(init: SessionInit) {
    super(init)
  }

  /** bridge 会话 id 直接用 areco 会话 id：一一对应，destroy/status 都按它找 */
  private get bridgeSessionId(): string {
    return this.id
  }

  override spawnProcess(spec: SpawnSpec) {
    if (this.isRunning) throw new Error(`会话 ${this.id} 已在运行`)
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
    this.abort = new AbortController()

    this.status = 'spawning'
    this.startedAt = Date.now()
    this.emitUpdate()

    const currentEpoch = this.epoch
    void ensureBridgeRuntime()
      .then((client) => {
        if (this.epoch !== currentEpoch || this.disposed) return
        this.client = client
        this.status = 'running'
        log.info(`bridge spawn ${this.name}（${this.id.slice(0, 8)}）epoch=${this.epoch} model=${this.bridgeModel ?? '默认'}`)
        this.emitUpdate()
      })
      .catch((err) => {
        if (this.epoch !== currentEpoch || this.disposed) return
        log.error(`bridge sidecar 不可用 ${this.id.slice(0, 8)}`, err)
        this.ingestLine(`\x1b[31m[bridge] sidecar 启动失败：${(err as Error).message}\x1b[0m`)
        this.exitCode = 1
        this.handleExit(1) // killedBy 为空 → reason=crash
      })
  }

  /** 文本+回车 = 提交一轮；孤立控制键没有 TUI 可去，丢弃（续跑脚本注入的 'continue\r' 天然走通） */
  override write(data: string, opts?: { markWorking?: boolean }) {
    void opts
    if (this.status !== 'running' && this.status !== 'spawning') throw new Error('会话未在运行')
    if (data.length > 1 && data.endsWith('\r')) {
      this.sendline(data.slice(0, -1))
      return
    }
    if (data === '\r' || !data.trim()) return
    // 无尾回车的裸文本：当作插话尝试（运行中 steer，空闲时攒不出完整指令，忽略）
    if (this.runActive && this.client) {
      void this.client.steer(this.bridgeSessionId, data).catch(() => {})
    }
  }

  override sendline(text: string, opts?: { autoName?: boolean }) {
    if (this.status !== 'running' && this.status !== 'spawning') throw new Error('会话未在运行')
    const body = text.replace(/[\r\n]+$/, '')
    if (!body.trim()) return
    this.promptCount += 1
    if (!this.agentSessionId) this.setAgentBindingPrompt(text)
    // 占位名命名与父类同口径（父类 sendline 的 pty 写入路径不可复用，命名逻辑平移）
    if (this.autoNamed && !this.firstPromptNamed && opts?.autoName !== false) {
      const label = promptLabel(text)
      if (label && isNameWorthy(label)) {
        this.firstPromptNamed = true
        this.name = label
      }
    }
    // bridge 没有 TUI 回显：用户输入要自己画进输出流，否则终端视图里看不到发了什么
    this.ingestLine(`\x1b[36m>>> ${body}\x1b[0m`)
    this.setTrafficState('working')
    this.workingFromInput = false
    this.emitUpdate()

    if (this.runActive) {
      // 运行中插话：不新起轮（sidecar 对忙会话的 chat 会拒）
      void this.client?.steer(this.bridgeSessionId, body).catch((err) => {
        this.ingestLine(`\x1b[31m[bridge] 插话失败：${(err as Error).message}\x1b[0m`)
      })
      return
    }
    this.runActive = true
    void this.pump(body)
  }

  /** 一轮对话：chat → streamOutput 拉流 → 增量与事件译进输出流 → done 收场 */
  private async pump(message: string) {
    const client = this.client
    const currentEpoch = this.epoch
    if (!client) {
      this.runActive = false
      this.setTrafficState('idle')
      return
    }
    const [providerOverride, modelOverride] = splitModel(this.bridgeModel)
    try {
      const resp = await client.chat({
        session_id: this.bridgeSessionId,
        message,
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(providerOverride ? { provider: providerOverride } : {}),
      })
      if (!resp.ok || typeof resp.run_id !== 'string') {
        throw new Error(resp.error ?? 'chat 未返回 run_id')
      }
      const final = await client.streamOutput(
        resp.run_id,
        (chunk) => {
          if (this.epoch !== currentEpoch || this.disposed) return
          if (chunk.delta) this.ingest(chunk.delta)
          for (const event of chunk.events) this.renderEvent(event)
          //  traffic 监控有「15s 无输出→idle」兜底：流在动就钉回 working
          if (this.trafficState !== 'working') this.setTrafficState('working')
        },
        { signal: this.abort?.signal },
      )
      if (this.epoch !== currentEpoch || this.disposed) return
      if (final.status === 'error') {
        this.ingestLine(`\x1b[31m[bridge] 本轮出错：${final.error ?? '未知'}\x1b[0m`)
      } else if (final.status === 'interrupted') {
        this.ingestLine(`\x1b[33m[bridge] 已打断\x1b[0m`)
      }
    } catch (err) {
      if (this.epoch !== currentEpoch || this.disposed) return
      if (this.abort?.signal.aborted) return // stop/kill 触发的取消不算错
      this.ingestLine(`\x1b[31m[bridge] ${(err as Error).message}\x1b[0m`)
    } finally {
      if (this.epoch === currentEpoch && !this.disposed) {
        this.runActive = false
        if (this.isRunning) this.setTrafficState('idle')
        this.emitUpdate()
      }
    }
  }

  /** 工具/生命周期事件 → 终端流里的灰字一行（审批类 MVP 只展示，批不了） */
  private renderEvent(event: BridgeEvent) {
    switch (event.type) {
      case 'tool.started':
        this.ingestLine(`\x1b[2m🔧 ${event.name ?? 'tool'} ${String(event.args_preview ?? '').slice(0, 120)}\x1b[0m`)
        break
      case 'tool.completed':
        this.ingestLine(
          event.is_error
            ? `\x1b[31m⚠️ ${event.name ?? 'tool'} ${String(event.result_preview ?? '').slice(0, 200)}\x1b[0m`
            : `\x1b[2m↩︎ ${String(event.result_preview ?? '').slice(0, 200)}\x1b[0m`,
        )
        break
      default:
        // lifecycle/run.error 等其余事件不进终端流（噪声），以后接事件总线再消费
        break
    }
  }

  /** 增量文本 → 输出流 + shadow（CRLF 规范化：xterm 的 \n 不回车） */
  private ingest(text: string) {
    if (!text) return
    const data = text.replace(/\r?\n/g, '\r\n')
    this.produced += data.length
    this.totalOutputChars += data.length
    this.lastOutputAt = Date.now()
    this.emit('output', data, this.produced, this.epoch)
    this.shadow?.write(data, () => {
      this.shadowProcessed += data.length
    })
    this.scheduleLastLine()
  }

  /** 自成一行的系统/事件文本（自带前后 CRLF，与流式增量分隔开） */
  private ingestLine(line: string) {
    this.ingest(`\r\n${line}\r\n`)
  }

  override pause() {
    /* bridge 无 pty 可暂停 */
  }

  override resume() {
    /* bridge 无 pty 可恢复 */
  }

  override stop() {
    if (!this.isRunning) return
    this.killedBy = this.killedBy ?? 'stop'
    this.status = 'stopping'
    this.emitUpdate()
    this.teardownBridge()
    this.handleExit(0) // killedBy='stop' → user-stop
  }

  override kill() {
    if (!this.isRunning) return
    this.killedBy = 'kill'
    this.teardownBridge()
    this.handleExit(143) // SIGKILL 语义；reason 由 killedBy='kill' 决定
  }

  /** 打断当前轮 + 销毁 sidecar 侧会话（幂等；sidecar 不可达也只记日志） */
  private teardownBridge() {
    this.abort?.abort()
    const client = this.client
    if (client) {
      void client
        .destroy(this.bridgeSessionId)
        .catch((err) => log.warn(`bridge destroy 失败 ${this.id.slice(0, 8)}`, err))
    }
  }

  /** onceQuiet 注入下限：bridge 无 TUI 冷启动，500ms 足够 */
  protected override minBootMs(): number {
    const env = Number(process.env.ARECO_MIN_BOOT_MS)
    if (Number.isFinite(env) && env > 0) return env
    return BRIDGE_MIN_BOOT_MS
  }

  override dispose() {
    this.abort?.abort()
    super.dispose()
  }
}

/** 'provider/model' 拆开；裸模型名 provider 用 sidecar 默认 */
function splitModel(raw: string | null): [string | null, string | null] {
  const s = raw?.trim()
  if (!s) return [null, null]
  const slash = s.indexOf('/')
  if (slash > 0) return [s.slice(0, slash), s.slice(slash + 1)]
  return [null, s]
}
