// Hermes agent-bridge Node 侧（MVP）：client + manager。
//
// 依据 /tmp/bridge-design/design.md 的协议描述从零编写（该设计说明不含任何
// hermes-studio / frakio-work 代码，可安全用于 Apache-2.0）。
//
// 协议形状（设计 §0）：Unix socket + 换行分隔 JSON + 短连接请求-响应。
// 服务端永不主动推送——流式输出与事件全靠客户端轮询 get_output，用
// cursor（文本偏移）/ event_cursor（事件偏移）双游标拉增量。
//
// 分工：AgentBridgeClient 只管发请求；AgentBridgeManager 管 Python sidecar
// 子进程（先 ping 探测已有实例，命中即 attach，否则 spawn 并等 stdout 就绪行）。
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENTRY_DIR, ROOT_DIR } from '../config'

// sidecar 路径探测与 config.ts 的 nearEntry 同口径：esbuild 打成 dist/server/index.cjs
// 单文件后 __dirname 不再是源码目录，必须按布局候选找（仓库根 → bundle 布局 → dev 布局）。
const SIDECAR = (() => {
  const rel = ['packages', 'server', 'agent-bridge', 'hermes_bridge.py']
  const candidates = [
    path.join(ROOT_DIR, ...rel),
    path.resolve(ENTRY_DIR, '..', '..', ...rel),
    path.resolve(ENTRY_DIR, '..', '..', '..', ...rel),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!
})()
const READY_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 310_000 // 要盖住 sidecar 端 wait:true 的 300s
const POLL_INTERVAL_MS = 100

export interface BridgeRequest {
  action: string
  [k: string]: unknown
}

export interface BridgeResponse {
  ok: boolean
  error?: string
  error_type?: string
  [k: string]: unknown
}

export interface BridgeEvent {
  type: string
  ts?: number
  [k: string]: unknown
}

export interface OutputChunk {
  run_id: string
  session_id: string
  status: 'running' | 'complete' | 'error' | 'interrupted'
  output: string
  delta: string
  cursor: number
  events: BridgeEvent[]
  event_cursor: number
  done: boolean
  result?: unknown
  error?: string | null
}

export interface ChatOptions {
  session_id?: string
  message: string
  model?: string
  provider?: string
  instructions?: string
  toolsets?: string[]
  conversation_history?: unknown[]
  wait?: boolean
  timeout?: number
}

export interface BridgeManagerOptions {
  /** 派生 endpoint 的键；同一 key 的 manager 会 attach 到同一个 sidecar */
  key?: string
  endpoint?: string
  python?: string
  hermesConfig?: string
  hermesHome?: string
  provider?: string
  model?: string
}

function endpointForKey(key: string): string {
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return `ipc:///tmp/hermes-agent-bridge-${digest}.sock`
}

function socketPath(endpoint: string): string {
  return endpoint.startsWith('ipc://') ? endpoint.slice('ipc://'.length) : endpoint
}

// ---------------------------------------------------------------- client

export class AgentBridgeClient {
  constructor(public readonly endpoint: string) {}

  /** 短连接请求-响应：新建连接、写一行 JSON、读到换行为响应、关闭。 */
  request<T extends BridgeResponse = BridgeResponse>(req: BridgeRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath(this.endpoint))
      const chunks: Buffer[] = []
      let settled = false
      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.destroy()
        fn()
      }
      const timer = setTimeout(
        () => done(() => reject(new Error(`bridge 请求超时（${req.action}，${timeoutMs}ms）`))),
        timeoutMs,
      )
      sock.on('connect', () => {
        sock.write(JSON.stringify(req) + '\n')
        sock.end() // 短连接：写完即半关，让服务端知道请求结束
      })
      sock.on('data', (d) => chunks.push(d))
      sock.on('error', (err) => done(() => reject(err)))
      sock.on('close', () => {
        done(() => {
          const raw = Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')
          if (!raw) return reject(new Error(`bridge 空响应（${req.action}）`))
          try {
            resolve(JSON.parse(raw) as T)
          } catch {
            reject(new Error(`bridge 响应不是 JSON（${req.action}）: ${raw.slice(0, 200)}`))
          }
        })
      })
    })
  }

  ping() {
    return this.request({ action: 'ping' }, 5_000)
  }

  chat(opts: ChatOptions) {
    return this.request({ action: 'chat', ...opts })
  }

  getOutput(runId: string, cursor = 0, eventCursor = 0) {
    return this.request<BridgeResponse & OutputChunk>({
      action: 'get_output',
      run_id: runId,
      cursor,
      event_cursor: eventCursor,
    })
  }

  getResult(runId: string) {
    return this.request<BridgeResponse & OutputChunk>({ action: 'get_result', run_id: runId })
  }

  interrupt(sessionId: string, message?: string) {
    return this.request({ action: 'interrupt', session_id: sessionId, message })
  }

  steer(sessionId: string, text: string) {
    return this.request<{ ok: boolean; steered: boolean }>({ action: 'steer', session_id: sessionId, text })
  }

  status(sessionId: string) {
    return this.request({ action: 'status', session_id: sessionId })
  }

  list() {
    return this.request({ action: 'list' })
  }

  destroy(sessionId: string) {
    return this.request({ action: 'destroy', session_id: sessionId })
  }

  shutdown() {
    return this.request({ action: 'shutdown' }, 5_000)
  }

  /**
   * 拉模型流式核心（设计 §0 关键推论）：每 ~100ms 轮询一次 get_output，
   * 推进双游标，把 delta 与 events 交给 onChunk，直到 done。
   */
  async streamOutput(
    runId: string,
    onChunk: (chunk: OutputChunk) => void,
    opts: { intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<OutputChunk> {
    let cursor = 0
    let eventCursor = 0
    const interval = opts.intervalMs ?? POLL_INTERVAL_MS
    for (;;) {
      if (opts.signal?.aborted) throw new Error('streamOutput 被取消')
      const resp = await this.getOutput(runId, cursor, eventCursor)
      if (!resp.ok) throw new Error(`get_output 失败: ${resp.error}`)
      cursor = resp.cursor
      eventCursor = resp.event_cursor
      onChunk(resp)
      if (resp.done) return resp
      await new Promise((r) => setTimeout(r, interval))
    }
  }
}

// ---------------------------------------------------------------- manager

export class AgentBridgeManager {
  private client: AgentBridgeClient | null = null
  private child: ChildProcess | null = null
  private readonly endpoint: string

  constructor(private readonly opts: BridgeManagerOptions = {}) {
    this.endpoint = opts.endpoint ?? endpointForKey(opts.key ?? 'default')
  }

  /** 先 ping 探测已有 sidecar，命中则 attach；否则 spawn 并等就绪行。 */
  async ensureReady(): Promise<AgentBridgeClient> {
    if (this.client) return this.client
    const candidate = new AgentBridgeClient(this.endpoint)
    try {
      const pong = await candidate.ping()
      if (pong.ok) {
        this.client = candidate
        return candidate
      }
    } catch {
      // 没命中——socket 不存在或对端已死，走 spawn
    }
    // 僵尸 socket 文件清掉，避免 sidecar bind 冲突（sidecar 自己也会 unlink，双保险）
    try {
      fs.unlinkSync(socketPath(this.endpoint))
    } catch {
      /* 不存在就算了 */
    }
    return this.spawn()
  }

  private spawn(): Promise<AgentBridgeClient> {
    const o = this.opts
    const args = [
      SIDECAR,
      '--endpoint', this.endpoint,
      '--hermes-config', o.hermesConfig ?? path.join(os.homedir(), '.qclaw-hermes', 'config.yaml'),
      '--hermes-home', o.hermesHome ?? path.join(os.homedir(), '.hermes-agent-bridge'),
      '--provider', o.provider ?? 'qclaw',
      '--model', o.model ?? 'pool-deepseek-v4-flash',
    ]
    const child = spawn(o.python ?? 'python3', args, { stdio: ['ignore', 'pipe', 'inherit'] })
    this.child = child

    return new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`sidecar 就绪超时（${READY_TIMEOUT_MS}ms）`))
      }, READY_TIMEOUT_MS)
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout?.removeAllListeners('data')
        child.removeAllListeners('exit')
      }
      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        try {
          const msg = JSON.parse(line)
          if (msg.event === 'ready') {
            cleanup()
            this.client = new AgentBridgeClient(msg.endpoint ?? this.endpoint)
            resolve(this.client)
          } else if (msg.event === 'error') {
            cleanup()
            reject(new Error(`sidecar 启动失败: ${msg.error}`))
          }
        } catch {
          /* 非 JSON 的 stdout 行忽略 */
        }
      })
      child.on('exit', (code) => {
        cleanup()
        this.client = null
        this.child = null
        reject(new Error(`sidecar 提前退出（code=${code}）`))
      })
    })
  }

  /** 优雅停机：先发 shutdown，副作用是 sidecar 级联清会话；超时再 SIGTERM。 */
  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.shutdown()
      } catch {
        /* 已经死了就不用 shut */
      }
    }
    const child = this.child
    if (child && !child.killed) {
      const exited = new Promise((r) => child.once('exit', r))
      setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* 竞态退出 */
        }
      }, 2_000).unref()
      await exited
    }
    this.client = null
    this.child = null
  }
}
