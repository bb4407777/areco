import type { Context } from 'koa'
import type { TtsService } from '../services/tts'

export const MAX_TTS_TEXT_LENGTH = 8000

export class TtsController {
  constructor(private readonly tts: TtsService) {}

  synthesize = async (ctx: Context) => {
    const body = ctx.request.body as { text?: unknown } | undefined
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) {
      ctx.status = 400
      ctx.body = { ok: false, error: { code: 'invalid_text', message: 'text 不能为空' } }
      return
    }
    if (text.length > MAX_TTS_TEXT_LENGTH) {
      ctx.status = 400
      ctx.body = { ok: false, error: { code: 'text_too_long', message: `text 不能超过 ${MAX_TTS_TEXT_LENGTH} 字` } }
      return
    }
    const stream = await this.tts.synthesize(text, ctx.req, ctx.res)
    ctx.status = 200
    ctx.set('Cache-Control', 'no-store')
    ctx.set('X-Audio-Sample-Rate', '24000')
    ctx.set('X-Audio-Channels', '1')
    ctx.set('X-Audio-Format', 'pcm16le')
    ctx.type = 'application/octet-stream'
    ctx.body = stream
  }
}
