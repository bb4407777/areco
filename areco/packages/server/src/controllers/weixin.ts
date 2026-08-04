// Hermes 微信会话只读视图的 HTTP 入口（2026-08-04 作业单 A）。
//
// 与 controllers/api.ts 的 ApiControllers 同构的 { ok, data | error } 响应，但不并入
// ApiControllers 类——本作业单只允许新增只读端点 + 服务文件、不得改动既有控制器行为，
// 故独立成模块，在 routes/api.ts 直接 import 注册（routes 文件仍是「URL → controller 映射，
// 零业务」）。全部只读，不触发任何写库或重启。
import type { Context } from 'koa'
import { listWeixinSessions, readWeixinTranscript } from '../services/weixin-sessions'

function ok(ctx: Context, data: unknown): void {
  ctx.body = { ok: true, data }
}

function fail(ctx: Context, status: number, code: string, message: string): void {
  ctx.status = status
  ctx.body = { ok: false, error: { code, message } }
}

/** GET /api/weixin/sessions?limit=&offset=&q=
 *  只读列出有消息的微信会话（最近在前）。query 参数与 /api/history 同口径。 */
export function weixinList(ctx: Context): void {
  try {
    const limit = Number(ctx.query.limit ?? 30) || 30
    const offset = Number(ctx.query.offset ?? 0) || 0
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : undefined
    ok(ctx, listWeixinSessions({ limit, offset, q }))
  } catch (err) {
    fail(ctx, 500, 'weixin_read_failed', err instanceof Error ? err.message : String(err))
  }
}

/** GET /api/weixin/sessions/:id/transcript?cursor=&before=
 *  只读取单个微信会话正文（消息序号分页）。id 非法或不存在返回 exists:false（同 transcript 端点）。 */
export function weixinTranscript(ctx: Context): void {
  try {
    const id = String(ctx.params.id ?? '')
    const beforeRaw = Number(ctx.query.before)
    const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : undefined
    const cursor = Math.max(0, Number(ctx.query.cursor ?? 0) || 0)
    ok(ctx, readWeixinTranscript(id, { cursor, before }))
  } catch (err) {
    fail(ctx, 500, 'weixin_read_failed', err instanceof Error ? err.message : String(err))
  }
}
