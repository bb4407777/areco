// weSaw 会话只读视图的 HTTP 入口：列表（会话名/类型/最近活动）+ 单会话正文。
// 与 controllers/weixin.ts 同构的 { ok, data | error } 响应，纯只读，不触发任何写盘。
import type { Context } from 'koa'
import { listWesawSessions, readWesawTranscript } from '../services/wesaw'

function ok(ctx: Context, data: unknown): void {
  ctx.body = { ok: true, data }
}

function fail(ctx: Context, status: number, code: string, message: string): void {
  ctx.status = status
  ctx.body = { ok: false, error: { code, message } }
}

/** GET /api/wesaw/sessions?limit=&offset=&q= — 有正文可读的 weSaw 会话，最近活动在前 */
export function wesawList(ctx: Context): void {
  try {
    const limit = Number(ctx.query.limit ?? 100) || 100
    const offset = Number(ctx.query.offset ?? 0) || 0
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : undefined
    ok(ctx, listWesawSessions({ limit, offset, q }))
  } catch (err) {
    fail(ctx, 500, 'wesaw_read_failed', err instanceof Error ? err.message : String(err))
  }
}

/** GET /api/wesaw/sessions/:id/transcript — id 形如 kimi:session_xxx / pi:uuid */
export function wesawTranscript(ctx: Context): void {
  try {
    const id = decodeURIComponent(String(ctx.params.id ?? ''))
    ok(ctx, readWesawTranscript(id))
  } catch (err) {
    fail(ctx, 500, 'wesaw_read_failed', err instanceof Error ? err.message : String(err))
  }
}
