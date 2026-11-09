// 语音输入 WS：/ws/asr 与主 /ws 分开，二进制音频不进 JSON 协议；
// 鉴权复用 verifyUpgrade，音频透传给本机 Python ASR sidecar。
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { AuthService } from '../services/auth'
import type { AppConfig } from '../config'
import type { AsrService } from '../services/asr'
import { verifyUpgrade } from '../middleware/auth'
import { createLogger } from '../logger'

const log = createLogger('asr-ws')
const PENDING_LIMIT = 4000 // sidecar 启动期间最多缓存 4000 条（约 20s 音频）

export class AsrGateway {
  private wss = new WebSocketServer({ noServer: true })

  constructor(
    private asr: AsrService,
    private auth: AuthService,
    private config: AppConfig
  ) {}

  mount(server: HttpServer) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://placeholder')
      if (url.pathname !== '/ws/asr') return // 其余路径交给主 Gateway
      const verdict = verifyUpgrade(req, this.auth, this.config)
      if (!verdict.ok) {
        log.warn(`ASR WS 拒绝（${verdict.status}）：${verdict.reason}`)
        socket.write(`HTTP/1.1 ${verdict.status} ${verdict.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws))
    })
  }

  private onConnection(client: WebSocket) {
    let upstream: WebSocket | null = null
    let closed = false
    const pending: { data: Buffer; binary: boolean }[] = []

    const fail = (code: number, reason: string) => {
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
    }

    this.asr
      .ensureStarted()
      .then(() => {
        if (closed) return
        upstream = new WebSocket(`ws://${this.asr.address}/asr`)
        upstream.on('open', () => {
          for (const item of pending) upstream?.send(item.data, { binary: item.binary })
          pending.length = 0
        })
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
        })
        upstream.on('close', () => fail(1000, 'asr closed'))
        upstream.on('error', (err) => {
          log.warn('ASR sidecar 连接错误', err)
          fail(1011, 'asr error')
        })
      })
      .catch((err) => {
        log.error('ASR sidecar 启动失败', err)
        fail(1013, 'asr unavailable')
      })

    client.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(buf, { binary: isBinary })
      } else if (pending.length < PENDING_LIMIT) {
        pending.push({ data: buf, binary: isBinary })
      }
    })
    client.on('close', () => {
      closed = true
      pending.length = 0
      upstream?.close()
    })
    client.on('error', (err) => log.warn('ASR 客户端 WS 错误', err))
  }

  shutdown() {
    for (const client of this.wss.clients) client.close(1001, 'server shutdown')
  }
}
