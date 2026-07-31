// 角色模式（设置页「新建会话模式 = 角色（Worker/Thinker）」）下：
// 「＋ 新建会话」直接拉起 Worker 会话——不弹 SpawnDialog、不给 Thinker 选项、不二次确认。
// 模板模式（spawnMode='template'）仍走 SpawnDialog，由调用方判断 isRoleMode 决定是否用本方法。
// 服务端 resolveRoleTemplate 会按角色解析出 worker 模板并取其 cwd，故无需额外传 cwd。
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { SessionSummary, StandCodeRole } from '../../../shared/protocol'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { sessionEntryPath } from '../utils/format'

/** 接手角色四档（与服务端 HANDOFF_ROLES 同序）：侧栏/手机端角色模式菜单共用，避免两处漂移。
 *  模块级导出——SessionCard 等不发请求的组件只取常量，不必起整个 composable。 */
export const HANDOFF_ROLES: { role: StandCodeRole; label: string }[] = [
  { role: 'worker', label: '用 worker 接手' },
  { role: 'thinker', label: '用 thinker 接手' },
  { role: 'fastWorker', label: '用快速 worker 接手' },
  { role: 'heavyWorker', label: '用重活 worker 接手' },
]

export function useSpawnWorker() {
  const store = useSessionsStore()
  const ui = useUiStore()
  const router = useRouter()
  const message = useMessage()
  const busy = ref(false)

  /** true = 角色模式（新建会话只选 Worker/Thinker）：按钮走「＋ worker」直接拉起 */
  const isRoleMode = computed(() => ui.spawnMode !== 'template')

  /** 直接 spawn 一个 Worker 会话并跳转到它；失败用 useMessage 提示，不抛断流程 */
  async function spawnWorker() {
    if (busy.value) return
    busy.value = true
    try {
      const session = await api.post<SessionSummary>('/api/sessions', { role: 'worker' })
      ui.rememberCwd(session.cwd)
      router.push(sessionEntryPath(session.id, store.byId(session.id) ?? session, store.templates, ui.sessionView))
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      busy.value = false
    }
  }

  const handoffBusy = ref(false)

  /** 把现有会话交接给指定角色：服务端写交接档案 + 按角色解析模板拉起新会话。
   *  角色模式下侧栏/手机端菜单的「接手」只给四项：worker / thinker / 快速 worker / 重活 worker，
   *  不给模板列表（2026-07-31 定，同日扩到四档）。 */
  async function handoffRole(id: string, role: StandCodeRole, label: string) {
    if (handoffBusy.value) return
    handoffBusy.value = true
    try {
      const session = await store.handoff(id, { role })
      message.success(`已交接给 ${label}`)
      router.push(sessionEntryPath(session.id, store.byId(session.id) ?? session, store.templates, ui.sessionView))
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      handoffBusy.value = false
    }
  }

  return { isRoleMode, spawnWorker, handoffRole, workerBusy: busy, handoffBusy }
}
