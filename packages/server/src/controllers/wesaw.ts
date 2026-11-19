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

/**
 * GET /api/wesaw/sessions?limit=&offset=&q=&kind=&sub= — weSaw 最近会话（app 清单），最近活动在前。
 * kind 取 联系人／群聊／公众号；sub 取 wechat/wcom…（二级分类键）；不传＝全部。
 */
export async function wesawList(ctx: Context): Promise<void> {
  try {
    const limit = Number(ctx.query.limit ?? 100) || 100
    const offset = Number(ctx.query.offset ?? 0) || 0
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : undefined
    const kind = typeof ctx.query.kind === 'string' ? ctx.query.kind : undefined
    const sub = typeof ctx.query.sub === 'string' ? ctx.query.sub : undefined
    ok(ctx, await listWesawSessions({ limit, offset, q, kind, sub }))
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
