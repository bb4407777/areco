// weSaw 会话只读视图的 HTTP 入口：列表（会话名/类型/最近活动）+ 单会话正文。
// 与 controllers/weixin.ts 同构的 { ok, data | error } 响应，纯只读，不触发任何写盘。
import type { Context } from 'koa'
import { listWesawSessions, readWesawTranscript, wesawTalkerOf } from '../services/wesaw'
import { sendWesawMessage, wesawChatBusy, wesawChatTurns } from '../services/wesaw-chat'

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

/** GET /api/wesaw/sessions/:id/chat — 本页对话框自己那一路的往返（user/assistant 轮次） */
export function wesawChat(ctx: Context): void {
  try {
    const talker = wesawTalkerOf(decodeURIComponent(String(ctx.params.id ?? '')))
    if (!talker) {
      fail(ctx, 404, 'wesaw_not_found', '这个会话没有工作区')
      return
    }
    ok(ctx, { turns: wesawChatTurns(talker), busy: wesawChatBusy(talker) })
  } catch (err) {
    fail(ctx, 500, 'wesaw_chat_failed', err instanceof Error ? err.message : String(err))
  }
}

/** POST /api/wesaw/sessions/:id/message { text } — 投给该工作区的 agent，跑完靠轮询 chat 取 */
export function wesawSend(ctx: Context): void {
  try {
    const talker = wesawTalkerOf(decodeURIComponent(String(ctx.params.id ?? '')))
    if (!talker) {
      fail(ctx, 404, 'wesaw_not_found', '这个会话没有工作区')
      return
    }
    const body = (ctx.request.body ?? {}) as { text?: string }
    const result = sendWesawMessage(talker, String(body.text ?? ''))
    if (!result.ok) {
      fail(ctx, 400, 'wesaw_send_failed', result.error ?? '发送失败')
      return
    }
    ok(ctx, { turns: wesawChatTurns(talker), busy: true })
  } catch (err) {
    fail(ctx, 500, 'wesaw_send_failed', err instanceof Error ? err.message : String(err))
  }
}
