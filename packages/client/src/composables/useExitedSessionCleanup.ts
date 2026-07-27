import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'

/** 桌面侧栏与手机看板共用的一键清理确认、执行和反馈。 */
export function useExitedSessionCleanup() {
  const store = useSessionsStore()
  const route = useRoute()
  const router = useRouter()
  const dialog = useDialog()
  const message = useMessage()
  const cleaning = ref(false)
  const cleanupSupported = computed(() => store.cleanupExitedSupported)
  const cleanableCount = computed(() => store.cleanableExitedSessions.length)

  function confirmCleanupExited() {
    const count = cleanableCount.value
    if (!cleanupSupported.value || !count || cleaning.value) return

    dialog.warning({
      title: '一键清理退出会话',
      content: `确定删除 ${count} 个未归档且已退出的会话？卡片与终端快照将永久清除；agent 原生对话日志不受影响，仍可在「历史」页查看。已归档、运行中和出错的会话不会删除。项目成员会同步移出对应项目。`,
      positiveText: `清理 ${count} 个`,
      negativeText: '取消',
      onPositiveClick: async () => {
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
      },
    })
  }

  return { cleanupSupported, cleanableCount, cleaning, confirmCleanupExited }
}
