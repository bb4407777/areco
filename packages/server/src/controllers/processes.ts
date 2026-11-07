// 进程页控制器：只读快照 + 只杀孤儿（2026-11-07）
import type { Context } from 'koa'
import { killAllOrphans, killOrphan, snapshot } from '../services/processes'

export class ProcessControllers {
  list = async (ctx: Context) => {
    const data = await snapshot()
    ctx.set('Cache-Control', 'no-store')
    ctx.body = { ok: true, data }
  }

  kill = async (ctx: Context) => {
    const pid = Number((ctx.params as { pid?: string }).pid)
    if (!Number.isInteger(pid)) {
      ctx.status = 400
      ctx.body = { ok: false, error: { code: 'invalid_pid', message: 'pid 不合法' } }
      return
    }
    const r = await killOrphan(pid)
    if (!r.ok) {
      ctx.status = 400
      ctx.body = { ok: false, error: { code: 'kill_refused', message: r.message } }
      return
    }
    ctx.body = { ok: true, data: r }
  }

  killOrphans = async (ctx: Context) => {
    const r = await killAllOrphans()
    ctx.body = { ok: true, data: r }
  }
}
