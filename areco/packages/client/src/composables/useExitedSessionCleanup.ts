import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'

/** 桌面侧栏与手机看板共用的一键清理执行和反馈。 */
export function useExitedSessionCleanup() {
  const store = useSessionsStore()
  const route = useRoute()
  const router = useRouter()
  const message = useMessage()
  const cleaning = ref(false)
  const cleanupSupported = computed(() => store.cleanupExitedSupported)
  const cleanableCount = computed(() => store.cleanableExitedSessions.length)

  async function cleanupExited() {
    const count = cleanableCount.value
    if (!cleanupSupported.value || !count || cleaning.value) return

    cleaning.value = true
    try {
      const { removed } = await store.cleanupExited()
      const activeId = typeof route.params.id === 'string' ? route.params.id : null
      if (activeId && removed.includes(activeId)) await router.replace('/')
      if (removed.length) message.success(`已清理 ${removed.length} 个退出会话`)
      else message.info('会话状态已变化，没有符合条件的会话')
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      cleaning.value = false
    }
  }

  return { cleanupSupported, cleanableCount, cleaning, cleanupExited }
}
