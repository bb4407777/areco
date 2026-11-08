// OPC 后台页控制器：快照 + 单工单日志尾部 + 常驻会话对话（派单）
import type { Context } from 'koa'
import { sendSessionMessage, snapshot, taskLog } from '../services/opc'

export class OpcControllers {
  list = async (ctx: Context) => {
    ctx.set('Cache-Control', 'no-store')
    ctx.body = { ok: true, data: snapshot() }
  }

  taskLog = async (ctx: Context) => {
    const id = String((ctx.params as { id?: string }).id ?? '')
    try {
      ctx.set('Cache-Control', 'no-store')
      ctx.body = { ok: true, data: taskLog(id) }
    } catch (err) {
      ctx.status = 404
      ctx.body = { ok: false, error: { code: 'no_task_log', message: (err as Error).message } }
    }
  }

  /** 常驻会话对话：一句话派成工单，worker 用同一条会话续聊 */
  sessionMessage = async (ctx: Context) => {
    const dept = String((ctx.params as { dept?: string }).dept ?? '')
    const text = String((ctx.request.body as { text?: unknown } | undefined)?.text ?? '')
    try {
      ctx.set('Cache-Control', 'no-store')
      ctx.body = { ok: true, data: sendSessionMessage(dept, text) }
    } catch (err) {
      ctx.status = 400
      ctx.body = { ok: false, error: { code: 'session_message_failed', message: (err as Error).message } }
    }
  }
}
