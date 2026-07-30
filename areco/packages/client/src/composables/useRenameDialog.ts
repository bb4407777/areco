// 重命名会话对话框：三处入口（看板卡片/终端页/对话页）共用。
// 服务端显式命名即转正（autoNamed 清除，之后 sendline/session-namer 不再自动改名）。
import { h, ref } from 'vue'
import { NInput, useDialog, useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'

export function useRenameDialog() {
  const dialog = useDialog()
  const message = useMessage()
  const store = useSessionsStore()

  function openRename(id: string, currentName: string) {
    const name = ref(currentName)
    dialog.create({
      title: '重命名会话',
      positiveText: '保存',
      negativeText: '取消',
      content: () =>
        h(NInput, {
          value: name.value,
          'onUpdate:value': (v: string) => (name.value = v),
          placeholder: '会话名称',
          maxlength: 80, // 与服务端截断上限一致
        }),
      onPositiveClick: async () => {
        const trimmed = name.value.trim()
        if (!trimmed) {
          message.warning('名称不能为空')
          return false // 留在对话框里改
        }
        try {
          await store.rename(id, trimmed)
          // 服务端 emit update → WS sessionUpdate 广播，所有端自动刷新，无需本地改状态
        } catch (err) {
          message.error(err instanceof Error ? err.message : String(err))
          return false
        }
      },
    })
  }

  return { openRename }
}
