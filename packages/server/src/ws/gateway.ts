// WS 网关：noServer WSS + upgrade 双校验；attach 快照（snapshotPending 缓冲防 gap）；
// 绝对 offset ack 流控；30s 心跳；高水位滞留强制 detach。
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMsg, ServerMsg } from '../../../shared/protocol'
import { FLOW_HIGH_WATER, FLOW_LOW_WATER, FLOW_STALL_MS, PROTOCOL_VERSION } from '../../../shared/protocol'
import type { SessionManager } from '../services/session-manager'
import type { Session } from '../services/session'
import type { TemplateStore } from '../services/templates'
import type { Persistence } from '../services/persistence'
import type { AuthService } from '../services/auth'
import type { AppConfig } from '../config'
import { verifyUpgrade } from '../middleware/auth'
import { createLogger } from '../logger'
import { shouldApplyResize } from './resize-policy'

const log = createLogger('gateway')

const HEARTBEAT_MS = 30_000
const STALL_SWEEP_MS = 5_000
// snapshotPending 期间缓冲上限：超过说明客户端异常缓慢，放弃本次 attach
const PENDING_BUFFER_LIMIT = 4 * 1024 * 1024

interface Attachment {
  sentOffset: number
  ackedOffset: number
  highSince: number | null
  snapshotPending: boolean
  pendingChunks: { data: string; offset: number; epoch: number }[]
  pendingSize: number
  /** 该连接最近一次自报的终端尺寸（attach/resize 更新；控制者夺回尺寸时用） */
  cols: number
  rows: number
}

interface Conn {
  ws: WebSocket
  alive: boolean
  attached: Map<string, Attachment>
  remote: string
}

export class Gateway {
  private wss = new WebSocketServer({ noServer: true })
  private conns = new Set<Conn>()
  /** sessionId → 控制者连接（最近一次向该会话发 input/sendline 的；多端 resize 仲裁用） */
  private controllers = new Map<string, Conn>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private stallTimer: NodeJS.Timeout | null = null

  constructor(
    private manager: SessionManager,
    private templates: TemplateStore,
    private persistence: Persistence,
    private auth: AuthService,
    private config: AppConfig,
    private version: string
  ) {
    this.wireManager()
  }

  mount(server: HttpServer) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://placeholder')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      const verdict = verifyUpgrade(req, this.auth, this.config)
      if (!verdict.ok) {
        log.warn(`WS upgrade 拒绝（${verdict.status}）：${verdict.reason}`)
        socket.write(`HTTP/1.1 ${verdict.status} ${verdict.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req))
    })

    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    this.stallTimer = setInterval(() => this.sweepStalled(), STALL_SWEEP_MS)
  }

  shutdown() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.stallTimer) clearInterval(this.stallTimer)
    for (const conn of this.conns) conn.ws.close(1001, 'server shutdown')
  }

  // ---- 连接生命周期 ----

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const conn: Conn = {
      ws,
      alive: true,
      attached: new Map(),
      remote: req.socket.remoteAddress ?? '?',
    }
    this.conns.add(conn)
    log.info(`WS 连接建立（${conn.remote}），当前 ${this.conns.size} 条`)

    this.send(conn, {
      type: 'init',
      protocolVersion: PROTOCOL_VERSION,
      title: this.config.server.title,
      version: this.version,
      sessions: this.manager.list(),
      templates: this.templates.list(),
    })

    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('message', (raw) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(raw)) as ClientMsg
      } catch {
        this.sendError(conn, 'bad_message', '消息不是合法 JSON')
        return
      }
      try {
        this.dispatch(conn, msg)
      } catch (err) {
        this.sendError(conn, 'op_failed', err instanceof Error ? err.message : String(err), (msg as { sessionId?: string }).sessionId)
      }
    })
    ws.on('close', () => {
      for (const sessionId of conn.attached.keys()) this.detach(conn, sessionId)
      // 控制者离线即卸任：其他端重获尺寸话语权（下一个发输入/满尺寸 attach 者接管）
      for (const [sid, c] of this.controllers) if (c === conn) this.controllers.delete(sid)
      this.conns.delete(conn)
      log.info(`WS 连接关闭（${conn.remote}），剩 ${this.conns.size} 条`)
    })
    ws.on('error', (err) => log.warn(`WS 错误（${conn.remote}）`, err))
  }

  private dispatch(conn: Conn, msg: ClientMsg) {
    switch (msg.type) {
      case 'attach':
        // attach 是异步的：manager.get 抛错（如会话已删除）会变成 rejected promise，
        // dispatch 的 try/catch 接不住，必须在这里 .catch 兜底回 error，否则客户端永远等不到 snapshot
        this.attach(conn, msg.sessionId, msg.cols, msg.rows).catch((err) => {
          this.sendError(conn, 'attach_failed', err instanceof Error ? err.message : String(err), msg.sessionId)
        })
        break
      case 'detach':
        this.detach(conn, msg.sessionId)
        break
      case 'input': {
        // 发过输入的连接即该会话的控制者：尺寸仲裁只听它的；并立即把 PTY 拉回它自报的尺寸
        const session = this.manager.get(msg.sessionId)
        this.controllers.set(msg.sessionId, conn)
        const att = conn.attached.get(msg.sessionId)
        if (att && session.isRunning) session.resize(att.cols, att.rows)
        session.write(msg.data)
        break
      }
      case 'sendline': {
        const session = this.manager.get(msg.sessionId)
        if (!session.isRunning) break // 竞态：会话刚退出/停止中，静默丢弃，不报错
        this.controllers.set(msg.sessionId, conn)
        const att = conn.attached.get(msg.sessionId)
        if (att) session.resize(att.cols, att.rows)
        session.sendline(msg.text)
        break
      }
      case 'resize': {
        const session = this.manager.get(msg.sessionId)
        const att = conn.attached.get(msg.sessionId)
        if (att) {
          att.cols = msg.cols
          att.rows = msg.rows
        }
        if (session.isRunning) this.applyResize(conn, session, msg.sessionId, msg.cols, msg.rows)
        break
      }
      case 'ack': {
        const att = conn.attached.get(msg.sessionId)
        if (att) {
          // 钳制在 sentOffset 内：跨 epoch（restart）残留的迟到 ack 带旧大 offset，
          // Math.max 照收会把 ackedOffset 顶到 sentOffset 之上，水位差恒负、流控失效
          att.ackedOffset = Math.min(att.sentOffset, Math.max(att.ackedOffset, msg.offset))
          if (att.sentOffset - att.ackedOffset <= FLOW_HIGH_WATER) att.highSince = null
          this.updateFlow(msg.sessionId)
        }
        break
      }
      default:
        this.sendError(conn, 'bad_message', `未知消息类型: ${(msg as { type?: string }).type}`)
    }
  }

  // ---- attach / detach / 快照 ----

  /**
   * 多端共享 PTY 的尺寸仲裁（规则见 resize-policy.ts）：控制者可任意改，
   * 非控制者只许撑大不许挤小——手机端纯观看不再把桌面端压成窄条。
   */
  private applyResize(conn: Conn, session: Session, sessionId: string, cols: number, rows: number): void {
    const controller = this.controllers.get(sessionId)
    const ok = shouldApplyResize(
      { cols: session.cols, rows: session.rows },
      { cols, rows },
      { isController: controller === conn, hasController: controller !== undefined }
    )
    if (ok) session.resize(cols, rows)
    else log.info(`会话 ${sessionId.slice(0, 8)} 忽略非控制者缩小 resize（${cols}x${rows} ← ${session.cols}x${session.rows}）`)
  }

  private async attach(conn: Conn, sessionId: string, cols: number, rows: number) {
    const session = this.manager.get(sessionId) // 不存在则抛，由调用方 .catch 兜底回 error（见 dispatch）

    // 幂等：重复 attach 重走快照流程
    conn.attached.set(sessionId, {
      sentOffset: 0,
      ackedOffset: 0,
      highSince: null,
      snapshotPending: true,
      pendingChunks: [],
      pendingSize: 0,
      cols,
      rows,
    })

    if (session.isRunning) this.applyResize(conn, session, sessionId, cols, rows)

    let snap: { epoch: number; data: string; offset: number; cols: number; rows: number } | null = null
    let live = session.isRunning
    if (session.hasLiveShadow) {
      try {
        snap = await session.snapshot()
      } catch (err) {
        log.warn(`live 快照失败 ${sessionId.slice(0, 8)}`, err)
      }
    }
    if (!snap) {
      snap = this.persistence.loadSnapshot(sessionId)
      live = false
    }

    const att = conn.attached.get(sessionId)
    if (!att || att.snapshotPending === false) return // 期间被 detach 或重入

    if (!snap) {
      // 无任何快照（历史会话且从未落盘）：发一个空快照占位，客户端展示空屏 + 状态横幅
      snap = { epoch: session.epoch, data: '', offset: 0, cols: session.cols, rows: session.rows }
      live = session.isRunning
    }

    this.send(conn, {
      type: 'snapshot',
      sessionId,
      epoch: snap.epoch,
      data: snap.data,
      offset: snap.offset,
      cols: snap.cols,
      rows: snap.rows,
      live,
    })

    att.sentOffset = snap.offset
    att.ackedOffset = snap.offset
    att.snapshotPending = false
    // flush 快照覆盖点之后到达的 in-flight 块
    for (const chunk of att.pendingChunks) {
      if (chunk.epoch === snap.epoch && chunk.offset > snap.offset) {
        this.send(conn, { type: 'output', sessionId, epoch: chunk.epoch, data: chunk.data, offset: chunk.offset })
        att.sentOffset = chunk.offset
      }
    }
    att.pendingChunks = []
    att.pendingSize = 0
    this.updateFlow(sessionId)
  }

  private detach(conn: Conn, sessionId: string) {
    if (conn.attached.delete(sessionId)) this.updateFlow(sessionId)
  }

  /** restart 后 epoch 变化：对所有已 attach 的连接重走快照流程 */
  private reattachAll(sessionId: string) {
    // 记一笔：epoch 重放会让所有在看端走快照重置，是"画面跳回顶部"的唯一服务端来源，
    // 有此日志即可与前端报障时间点对账（2026-07-22 排障引入）
    log.info(`会话 ${sessionId.slice(0, 8)} epoch 变更，重放快照给在看端`)
    for (const conn of this.conns) {
      const att = conn.attached.get(sessionId)
      if (att) {
        const session = this.manager.get(sessionId)
        this.attach(conn, sessionId, session.cols, session.rows).catch((err) => {
          log.warn(`reattach 失败 ${sessionId.slice(0, 8)}`, err)
        })
      }
    }
  }

  // ---- 输出转发与流控 ----

  private wireManager() {
    this.manager.on('output', (sessionId: string, data: string, offset: number, epoch: number) => {
      for (const conn of this.conns) {
        const att = conn.attached.get(sessionId)
        if (!att) continue
        if (att.snapshotPending) {
          att.pendingChunks.push({ data, offset, epoch })
          att.pendingSize += data.length
          if (att.pendingSize > PENDING_BUFFER_LIMIT) {
            log.warn(`attach 缓冲溢出，放弃（${conn.remote} / ${sessionId.slice(0, 8)}）`)
            conn.attached.delete(sessionId)
            this.sendError(conn, 'attach_overflow', '快照期间输出过大，请重新打开会话', sessionId)
          }
          continue
        }
        this.send(conn, { type: 'output', sessionId, epoch, data, offset })
        att.sentOffset = offset
        if (att.sentOffset - att.ackedOffset > FLOW_HIGH_WATER && att.highSince === null) {
          att.highSince = Date.now()
        }
      }
      this.updateFlow(sessionId)
    })
    this.manager.on('update', (summary) => {
      this.broadcast({ type: 'sessionUpdate', session: summary })
    })
    this.manager.on('removed', (sessionId: string) => {
      for (const conn of this.conns) conn.attached.delete(sessionId)
      this.broadcast({ type: 'sessionRemoved', sessionId })
    })
    this.manager.on('epoch', (sessionId: string) => this.reattachAll(sessionId))
  }

  /** 汇总某会话所有在看连接的水位，决定 pty pause/resume */
  private updateFlow(sessionId: string) {
    let session
    try {
      session = this.manager.get(sessionId)
    } catch {
      return
    }
    let maxUnacked = 0
    for (const conn of this.conns) {
      const att = conn.attached.get(sessionId)
      if (!att || att.snapshotPending) continue
      maxUnacked = Math.max(maxUnacked, att.sentOffset - att.ackedOffset)
    }
    if (maxUnacked > FLOW_HIGH_WATER) session.pause()
    else if (maxUnacked < FLOW_LOW_WATER) session.resume()
  }

  /** 高水位滞留超时（手机锁屏假死）→ 强制 detach 该连接，解救 pty */
  private sweepStalled() {
    const now = Date.now()
    for (const conn of this.conns) {
      for (const [sessionId, att] of conn.attached) {
        if (att.highSince !== null && now - att.highSince > FLOW_STALL_MS) {
          log.warn(`连接 ${conn.remote} 在 ${sessionId.slice(0, 8)} 高水位滞留超时，强制 detach`)
          conn.attached.delete(sessionId)
          this.sendError(conn, 'flow_stalled', '接收过慢已断开画面，请重新打开会话', sessionId)
          this.updateFlow(sessionId)
        }
      }
    }
  }

  private heartbeat() {
    for (const conn of this.conns) {
      if (!conn.alive) {
        log.warn(`心跳无响应，断开 ${conn.remote}`)
        conn.ws.terminate()
        continue
      }
      conn.alive = false
      try {
        conn.ws.ping()
      } catch {
        /* ignore */
      }
    }
  }

  // ---- 发送 ----

  private send(conn: Conn, msg: ServerMsg) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg))
    }
  }

  private sendError(conn: Conn, code: string, message: string, sessionId?: string) {
    this.send(conn, { type: 'error', code, message, sessionId })
  }

  broadcast(msg: ServerMsg) {
    const payload = JSON.stringify(msg)
    for (const conn of this.conns) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload)
    }
  }
}
