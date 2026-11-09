// 单 WS 连接管理：指数退避重连（1s→30s+抖动）、消息分发、重连后回调（各视图重发 attach）、ack 聚合（50ms）
// 发送可靠性：sendline 带请求号，服务端收下回 sendline-ack；等不到回执就判「这帧没送到」，
// 把原文还给调用方（PromptBar 放回输入框）。心跳 ping 专治 iOS 切后台后的「看着 OPEN、其实已断」假连接。
import { ref } from 'vue'
import type { ClientMsg, ServerMsg } from '../../shared/protocol'

type MsgHandler = (msg: ServerMsg) => void
type OpenHandler = () => void
type AckWaiter = { resolve: (ok: boolean) => void; timer: number }

const ACK_FLUSH_MS = 50
const SENDLINE_ACK_MS = 8000
const PING_MS = 20_000
const PONG_STALE_MS = 45_000

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
  private seq = 0
  private pendingSends = new Map<string, AckWaiter>()
  private pingTimer: number | null = null
  private lastPongAt = Date.now()
  /** 服务端是否会回 sendline-ack：init 里报协议版本 ≥2 才算，旧服务端不读回执（否则每条都误判没送到） */
  private ackSupported = false

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      this.retry = 0
      this.connected.value = true
      this.lastPongAt = Date.now()
      this.startPing()
      for (const h of this.openHandlers) h()
    }
    ws.onmessage = (event) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(event.data)) as ServerMsg
      } catch {
        return
      }
      if (msg.type === 'init') {
        this.ackSupported = (msg.protocolVersion ?? 0) >= 2
      }
      if (msg.type === 'pong') {
        this.lastPongAt = Date.now()
        return
      }
      if (msg.type === 'sendline-ack') {
        this.settle(msg.id, true)
        return
      }
      for (const h of this.msgHandlers) h(msg)
    }
    ws.onclose = () => {
      // 竞态守卫：旧连接 CLOSING 期间 connect() 已建好新连接时，旧连接的迟发 close
      // 不得清掉新连接引用（否则 send 全静默失败、旧连接成孤儿）
      if (this.ws !== ws) return
      this.connected.value = false
      this.ackSupported = false
      this.ws = null
      this.stopPing()
      // 连接没了，等回执的一律判没送到，调用方好把文字放回输入框
      this.settleAll(false)
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

  /** 发一句话并等服务端回执：true = 服务端确实收下；false = 没送到（连接断/回执超时），调用方留着原文 */
  sendline(sessionId: string, text: string): Promise<boolean> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    // 旧服务端（协议 <2）不认 id、不回执：按老路子发出即算成功，免得每条都误报「没送出去」
    if (!this.ackSupported) return Promise.resolve(this.send({ type: 'sendline', sessionId, text }))
    const id = `${Date.now().toString(36)}-${++this.seq}`
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pendingSends.delete(id)
        // 回执超时基本就是假连接：主动断开，触发重连，别让后面的消息继续往死 socket 里倒
        this.forceReconnect()
        resolve(false)
      }, SENDLINE_ACK_MS)
      this.pendingSends.set(id, { resolve, timer })
      if (!this.send({ type: 'sendline', sessionId, text, id })) {
        this.settle(id, false)
      }
    })
  }

  private settle(id: string | undefined, ok: boolean) {
    if (!id) return
    const waiter = this.pendingSends.get(id)
    if (!waiter) return
    this.pendingSends.delete(id)
    clearTimeout(waiter.timer)
    waiter.resolve(ok)
  }

  private settleAll(ok: boolean) {
    for (const id of [...this.pendingSends.keys()]) this.settle(id, ok)
  }

  /** 心跳：连上就开始打 ping，回音断掉 45s 即认定假连接，主动断开重连 */
  private startPing() {
    this.stopPing()
    this.pingTimer = window.setInterval(() => {
      if (Date.now() - this.lastPongAt > PONG_STALE_MS) {
        this.forceReconnect()
        return
      }
      this.send({ type: 'ping' })
    }, PING_MS)
  }

  private stopPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
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

  /** 回前台/重回在线时调：连接看着 OPEN 但久无回音（iOS 切后台的典型状态）就直接换一条 */
  reconnectIfStale() {
    if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastPongAt > PONG_STALE_MS) {
      this.forceReconnect()
      return
    }
    this.reconnectNow()
  }

  /** 强断重连：不管 readyState 报什么，直接换一条（半死连接的 readyState 依旧是 OPEN） */
  forceReconnect() {
    const old = this.ws
    this.ws = null
    this.connected.value = false
    this.ackSupported = false
    this.stopPing()
    this.settleAll(false)
    if (old) {
      old.onclose = null
      old.onmessage = null
      try {
        old.close()
      } catch {
        /* 已断 */
      }
    }
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
