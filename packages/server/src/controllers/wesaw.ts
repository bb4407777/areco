// weSaw 会话只读视图的 HTTP 入口：列表（会话名/类型/最近活动）+ 单会话正文。
// 与 controllers/weixin.ts 同构的 { ok, data | error } 响应，纯只读，不触发任何写盘。
import type { Context } from 'koa'
import {
  listWesawSessions,
  readWesawAutowake,
  readWesawTranscript,
  wesawChatKeyOf,
  wesawTalkerOf,
  writeWesawAutowake,
} from '../services/wesaw'
import { sendWesawMessage, wesawChatBusy, wesawChatTurns } from '../services/wesaw-chat'
import { readWesawAvatar } from '../services/wesaw-avatars'

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

/** GET /api/wesaw/avatar/:id — 会话头像（id 同会话 id：talker 的 base64url）；没有头像回 404 让前端用首字 */
export async function wesawAvatar(ctx: Context): Promise<void> {
  const talker = Buffer.from(String(ctx.params.id ?? ''), 'base64url').toString('utf8')
  if (!/^[\w@.-]{3,120}$/.test(talker)) {
    ctx.status = 404
    ctx.body = ''
    return
  }
  try {
    const hit = await readWesawAvatar(talker)
    if (!hit) {
      ctx.status = 404
      ctx.set('Cache-Control', 'public, max-age=3600')
      ctx.body = ''
      return
    }
    const etag = `"${hit.mtimeMs.toString(16)}"`
    ctx.set('Cache-Control', 'public, max-age=604800')
    ctx.set('ETag', etag)
    if (ctx.headers['if-none-match'] === etag) {
      ctx.status = 304
      ctx.body = null
      return
    }
    ctx.type = 'image/jpeg'
    ctx.body = hit.buf
  } catch (err) {
    fail(ctx, 500, 'wesaw_avatar_failed', err instanceof Error ? err.message : String(err))
  }
}

/** POST /api/wesaw/sessions/:id/message { text } — 投给该工作区的 agent，跑完靠轮询正文取 */
export async function wesawSend(ctx: Context): Promise<void> {
  try {
    const talker = wesawTalkerOf(decodeURIComponent(String(ctx.params.id ?? '')))
    if (!talker) {
      fail(ctx, 404, 'wesaw_not_found', '这个会话没有工作区')
      return
    }
    const body = (ctx.request.body ?? {}) as { text?: string }
    const result = await sendWesawMessage(talker, String(body.text ?? ''))
    if (!result.ok) {
      fail(ctx, 400, 'wesaw_send_failed', result.error ?? '发送失败')
      return
    }
    ok(ctx, { turns: wesawChatTurns(talker), busy: true })
  } catch (err) {
    fail(ctx, 500, 'wesaw_send_failed', err instanceof Error ? err.message : String(err))
  }
}

/** GET /api/wesaw/sessions/:id/autowake — 该会话「自动跟进」开关现状（weSaw 6131 为准） */
export async function wesawAutowakeStatus(ctx: Context): Promise<void> {
  try {
    const talker = wesawTalkerOf(decodeURIComponent(String(ctx.params.id ?? '')))
    const chatKey = talker ? wesawChatKeyOf(talker) : null
    if (!chatKey) {
      fail(ctx, 404, 'wesaw_not_found', '这个会话没有工作区')
      return
    }
    ok(ctx, await readWesawAutowake(chatKey))
  } catch (err) {
    fail(ctx, 503, 'wesaw_autowake_unavailable', err instanceof Error ? err.message : String(err))
  }
}

/** POST /api/wesaw/sessions/:id/autowake { enabled } — 切换自动跟进（写回 weSaw） */
export async function wesawAutowakeToggle(ctx: Context): Promise<void> {
  try {
    const talker = wesawTalkerOf(decodeURIComponent(String(ctx.params.id ?? '')))
    const chatKey = talker ? wesawChatKeyOf(talker) : null
    if (!chatKey) {
      fail(ctx, 404, 'wesaw_not_found', '这个会话没有工作区')
      return
    }
    const body = (ctx.request.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      fail(ctx, 400, 'wesaw_autowake_failed', '缺少 enabled（布尔）')
      return
    }
    ok(ctx, await writeWesawAutowake(chatKey, body.enabled))
  } catch (err) {
    fail(ctx, 503, 'wesaw_autowake_unavailable', err instanceof Error ? err.message : String(err))
  }
}
