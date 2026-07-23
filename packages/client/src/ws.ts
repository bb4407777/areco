// 单 WS 连接管理：指数退避重连（1s→30s+抖动）、消息分发、重连后回调（各视图重发 attach）、ack 聚合（50ms）
import { ref } from 'vue'
import type { ClientMsg, ServerMsg } from '../../shared/protocol'

type MsgHandler = (msg: ServerMsg) => void
type OpenHandler = () => void

const ACK_FLUSH_MS = 50

class WsClient {
  readonly connected = ref(false)
  private ws: WebSocket | null = null
  private retry = 0
  private reconnectTimer: number | null = null
  private msgHandlers = new Set<MsgHandler>()
  private openHandlers = new Set<OpenHandler>()
  private ackQueue = new Map<string, number>() // sessionId → 最新绝对 offset
  private ackTimer: number | null = null
  private closedByApp = false

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      this.retry = 0
      this.connected.value = true
      for (const h of this.openHandlers) h()
    }
    ws.onmessage = (event) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(event.data)) as ServerMsg
      } catch {
        return
      }
      for (const h of this.msgHandlers) h(msg)
    }
    ws.onclose = () => {
      // 竞态守卫：旧连接 CLOSING 期间 connect() 已建好新连接时，旧连接的迟发 close
      // 不得清掉新连接引用（否则 send 全静默失败、旧连接成孤儿）
      if (this.ws !== ws) return
      this.connected.value = false
      this.ws = null
      if (!this.closedByApp) this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose 会跟着触发 */
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    const delay = Math.min(30_000, 1000 * 2 ** this.retry) + Math.random() * 500
    this.retry += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  /** 立即重连：清掉退避计时器、归零退避指数。iOS 切后台杀 WS，回前台时退避可能还挂着 30s 长延迟 */
  reconnectNow() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.retry = 0
    this.connect()
  }

  /** ack 聚合：同会话只保留最大 offset，50ms 批量发送 */
  queueAck(sessionId: string, offset: number) {
    const prev = this.ackQueue.get(sessionId) ?? 0
    this.ackQueue.set(sessionId, Math.max(prev, offset))
    if (this.ackTimer !== null) return
    this.ackTimer = window.setTimeout(() => {
      this.ackTimer = null
      for (const [id, off] of this.ackQueue) this.send({ type: 'ack', sessionId: id, offset: off })
      this.ackQueue.clear()
    }, ACK_FLUSH_MS)
  }

  onMessage(handler: MsgHandler): () => void {
    this.msgHandlers.add(handler)
    return () => this.msgHandlers.delete(handler)
  }

  /** 连接（重）建立时触发：视图在此重发 attach */
  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler)
    return () => this.openHandlers.delete(handler)
  }
}

export const wsClient = new WsClient()
