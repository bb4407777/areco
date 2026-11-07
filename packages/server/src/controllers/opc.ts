// OPC 后台页控制器：只读快照 + 单工单日志尾部
import type { Context } from 'koa'
import { snapshot, taskLog } from '../services/opc'

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
}
