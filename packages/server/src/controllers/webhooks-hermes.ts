// Hermes outbound webhook 收端（F2·台账#12）。设计依据
// ~/.loop-tasks/father-architect/03-webhook观察面-设计说明.md §2.2–§2.5：
//  - POST /webhooks/hermes 挂在 Host 守卫之后、bodyParser 之前（HMAC 要对 raw body 原始字节
//    重算，bodyParser 会消费流）；HMAC-SHA256 验签即该端点完整鉴权，不吃 cookie/apiKey 守卫。
//  - 签名格式与 Hermes 侧一致：GitHub 风格 `sha256=<hexdigest>`（agent/outbound_webhooks.py:443-447）。
//  - 交付语义对齐（03 §1.6）：无 secret 配置 503 拒裸收；验签失败 401 不落库（4xx Hermes 不重试）；
//    验签通过后处理异常回 200+内部记错——回 5xx 只会触发 Hermes 无意义重试。
//  - 关键事件升格 father 项目房（服务端内部直调 relay.postMessage，走既有 kind 分库/WS/微信可见链），
//    同 event+session 5 分钟窗口内合并，防错误风暴刷房。
import crypto from 'node:crypto'
import type { Context, Next } from 'koa'
import Router from '@koa/router'
import { createLogger } from '../logger'
import { insertEvent, queryEvents } from '../services/hermes-events'

const log = createLogger('hermes-webhook')

export const HERMES_WEBHOOK_PATH = '/webhooks/hermes'
/** father 项目房（rooms.json 实测 2026-08-08）；可被 config.webhooks.observerRoomId 覆盖 */
const DEFAULT_OBSERVER_ROOM_ID = 'ac3cd019'
/** 升格署名：非花名册成员，postMessage 落库照常、按会话名兜底展示（03 §2.4 署名口径） */
const OBSERVER_NAME = 'hermes-observer'
const SIG_HEADER = 'x-hermes-signature-256'
/** subagent_stop 带脱敏 tool_call_history，可到百 KB 级；2MB 上限防滥用（413 = 4xx，Hermes 不重试） */
const MAX_BODY_BYTES = 2 * 1024 * 1024
const ESCALATE_WINDOW_MS = 5 * 60_000

/** GitHub 风格 HMAC-SHA256 验签：对原始字节重算，常量时间比对（同 middleware/auth.ts 口径） */
export function verifyHermesSignature(secret: string, rawBody: Buffer, sigHeader: string | undefined): boolean {
  if (!sigHeader || !sigHeader.startsWith('sha256=')) return false
  const provided = sigHeader.slice('sha256='.length).trim().toLowerCase()
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

interface ObserverRelay {
  postMessage(roomId: string, from: string, body: string): unknown
}

export interface HermesWebhookOptions {
  /** 每请求读取（设置页保存会重载 config 对象字段），返回空/undefined = 未配置 → 503 */
  getSecret: () => string | undefined
  /** 关键事件升格目标 relay；缺省 null = 只落库不升格（单测/降级可用） */
  relay?: ObserverRelay | null
  getObserverRoomId?: () => string | undefined
}

interface HermesPayload {
  hook_event_name?: unknown
  tool_name?: unknown
  session_id?: unknown
  parent_session_id?: unknown
  delivery_id?: unknown
  timestamp?: unknown
  extra?: Record<string, unknown>
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** 关键事件过滤（03 §2.4）：API 层错误 / 子代理异常退出 / 会话失败收尾 → 一行摘要；其余 null */
function escalationSummary(event: string, p: HermesPayload): string | null {
  const extra = p.extra ?? {}
  const sid = str(p.session_id) || str(p.parent_session_id)
  if (event === 'api_request_error') {
    return (
      `⚠️ Hermes api_request_error：model=${str(extra.model) || '?'} status=${str(extra.status_code) || '?'} ` +
      `retryable=${str(extra.retryable) || '?'} reason=${str(extra.reason) || '?'} session=${sid || '?'}`
    )
  }
  if (event === 'subagent_stop') {
    const status = str(extra.child_status)
    if (status && status !== 'success') {
      return `⚠️ Hermes 子代理异常退出：role=${str(extra.child_role) || '?'} status=${status} 父session=${sid || '?'}`
    }
    return null
  }
  if (event === 'on_session_end' && extra.failed === true) {
    return `⚠️ Hermes 会话失败收尾：exit=${str(extra.turn_exit_reason) || '?'} model=${str(extra.model) || '?'} session=${sid || '?'}`
  }
  return null
}

// 频控：同 event|session 5 分钟窗口合并；上限剪枝防 Map 无界增长
const lastEscalatedAt = new Map<string, number>()
function shouldEscalate(event: string, sessionId: string): boolean {
  const now = Date.now()
  if (lastEscalatedAt.size > 500) {
    for (const [k, at] of lastEscalatedAt) if (now - at > ESCALATE_WINDOW_MS) lastEscalatedAt.delete(k)
  }
  const key = `${event}|${sessionId}`
  const prev = lastEscalatedAt.get(key)
  if (prev !== undefined && now - prev < ESCALATE_WINDOW_MS) return false
  lastEscalatedAt.set(key, now)
  return true
}

function maybeEscalate(opts: HermesWebhookOptions, event: string, payload: HermesPayload): void {
  if (!opts.relay) return
  const summary = escalationSummary(event, payload)
  if (!summary) return
  const sessionId = str(payload.session_id) || str(payload.parent_session_id)
  if (!shouldEscalate(event, sessionId)) return
  const roomId = opts.getObserverRoomId?.()?.trim() || DEFAULT_OBSERVER_ROOM_ID
  try {
    opts.relay.postMessage(roomId, OBSERVER_NAME, summary)
  } catch (err) {
    // 房间不存在/已归档等：观察面自身故障不得影响收件主流程（03 §4）
    log.warn(`关键事件升格失败（房 ${roomId}）：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 读原始字节（挂载点在 bodyParser 之前，流未被消费）；超限抛错 → 413 */
function readRawBody(ctx: Context, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    ctx.req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        ctx.req.destroy()
        reject(new Error(`body 超过 ${maxBytes} 字节上限`))
        return
      }
      chunks.push(chunk)
    })
    ctx.req.on('end', () => resolve(Buffer.concat(chunks)))
    ctx.req.on('error', reject)
  })
}

/** 守卫前中间件：只接管 POST /webhooks/hermes，其余请求透传 */
export function createHermesWebhookMiddleware(opts: HermesWebhookOptions) {
  return async (ctx: Context, next: Next) => {
    if (ctx.path !== HERMES_WEBHOOK_PATH) {
      await next()
      return
    }
    if (ctx.method !== 'POST') {
      ctx.status = 405
      ctx.body = { ok: false, error: { code: 'method_not_allowed', message: '仅接受 POST' } }
      return
    }
    const secret = opts.getSecret()?.trim()
    if (!secret) {
      // 拒绝裸收（03 §2.2）：未配置 secret 时端点自闭，路由留存无副作用
      ctx.status = 503
      ctx.body = { ok: false, error: { code: 'webhook_secret_unset', message: '未配置 webhooks.hermesSecret' } }
      return
    }
    let raw: Buffer
    try {
      raw = await readRawBody(ctx, MAX_BODY_BYTES)
    } catch (err) {
      ctx.status = 413
      ctx.body = { ok: false, error: { code: 'payload_too_large', message: err instanceof Error ? err.message : String(err) } }
      return
    }
    if (!verifyHermesSignature(secret, raw, ctx.get(SIG_HEADER))) {
      log.warn(`验签失败（${raw.length} 字节，来自 ${ctx.ip}），不落库`)
      ctx.status = 401
      ctx.body = { ok: false, error: { code: 'invalid_signature', message: 'X-Hermes-Signature-256 验签失败' } }
      return
    }
    // 验签通过后一律 2xx：处理异常回 200+内部记错，避免 Hermes 侧无意义 5xx 重试（03 §1.6）
    try {
      const payload = JSON.parse(raw.toString('utf8')) as HermesPayload
      const deliveryId = str(payload.delivery_id) || ctx.get('x-hermes-delivery')
      const event = str(payload.hook_event_name) || ctx.get('x-hermes-event') || 'unknown'
      if (!deliveryId) {
        ctx.status = 200
        ctx.body = { ok: false, stored: false, error: { code: 'missing_delivery_id', message: '缺 delivery_id' } }
        return
      }
      const stored = insertEvent({
        deliveryId,
        event,
        sessionId: str(payload.session_id) || str(payload.parent_session_id),
        toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
        ts: str(payload.timestamp) || undefined,
        payload: raw.toString('utf8'),
      })
      if (stored) maybeEscalate(opts, event, payload)
      ctx.status = 200
      ctx.body = stored ? { ok: true, stored: true } : { ok: true, stored: false, duplicate: true }
    } catch (err) {
      log.error('事件处理异常（已回 200 防重试）', err)
      ctx.status = 200
      ctx.body = { ok: false, stored: false, error: { code: 'internal', message: '事件处理异常，已记日志' } }
    }
  }
}

/** 只读查询路由（第一期零前端，father 巡检/人工排查用）：挂会话守卫之后，吃 cookie/X-API-Key
 *  既有鉴权（X-API-Key 放行面见 middleware/auth.ts isApiKeyScope）。独立模块自带路由，
 *  同 weixin.ts 独立控制器风格。 */
export function createHermesEventsRouter(): Router {
  const router = new Router({ prefix: '/api/webhooks/hermes' })
  router.get('/events', (ctx: Context) => {
    try {
      const event = typeof ctx.query.event === 'string' && ctx.query.event ? ctx.query.event : undefined
      const since = typeof ctx.query.since === 'string' && ctx.query.since ? ctx.query.since : undefined
      const limit = Number(ctx.query.limit ?? 100) || 100
      ctx.body = { ok: true, data: queryEvents({ event, since, limit }) }
    } catch (err) {
      ctx.status = 500
      ctx.body = {
        ok: false,
        error: { code: 'hermes_events_read_failed', message: err instanceof Error ? err.message : String(err) },
      }
    }
  })
  return router
}
