<script setup lang="ts">
// 座舱页：终端 + 单行 prompt + 触屏键条 + 会话动词。pty 活在服务端，本页只是"接上驾驶杆"。
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, NTag, useDialog, useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { EXIT_REASON_TEXT, STATUS_TEXT, chatCapable, trafficColor } from '../utils/format'
import TerminalPane from '../components/TerminalPane.vue'
import PromptBar from '../components/PromptBar.vue'
import MobileKeyBar from '../components/MobileKeyBar.vue'
import ViewModeSwitch from '../components/ViewModeSwitch.vue'
import { useRenameDialog } from '../composables/useRenameDialog'
import type { SessionViewMode } from '../stores/ui'

const route = useRoute()
const router = useRouter()
const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()
const dialog = useDialog()
const { openRename } = useRenameDialog()

const sessionId = computed(() => String(route.params.id))
const session = computed(() => store.byId(sessionId.value))
const isLive = computed(() => !!session.value && ['running', 'spawning', 'stopping'].includes(session.value.status))
const paneRef = ref<InstanceType<typeof TerminalPane> | null>(null)
const lightColor = computed(() =>
  session.value
    ? trafficColor(session.value.trafficState, session.value.status)
    : '#555'
)

// 会话被删除（本端或他端）→ 回看板
watch(
  () => store.ready && !session.value,
  (gone) => {
    if (gone) router.replace('/')
  }
)

// 可原生恢复对话的会话：重启默认续上对话
const resumable = computed(() => !!session.value && chatCapable(session.value, store.templates))

// 换 agent 接手候选：全部启用的非 shell 模板（对话写成交接档案，新 agent 读档续干）
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])
const handoffChildren = computed(() =>
  store.templates
    .filter((t) => t.enabled && !SHELLS.has(t.command.split('/').pop() ?? ''))
    .map((t) => ({ label: `用 ${t.name} 接手`, key: `handoff:${t.id}` }))
)

const menuOptions = computed(() => {
  const s = session.value
  if (!s) return []
  const options = []
  options.push({ label: '重命名', key: 'rename' })
  if (isLive.value) {
    options.push({ label: '停止（SIGTERM）', key: 'stop' })
    options.push({ label: '强制终止（SIGKILL）', key: 'kill' })
  } else {
    if (resumable.value) {
      options.push({ label: '重新启动（恢复对话）', key: 'resume' })
    } else {
      options.push({ label: '重新启动', key: 'restart' })
    }
    for (const t of handoffChildren.value) {
      options.push(t)
    }
  }
  // 归档/恢复与删除对所有状态开放（运行中也能归档，与运行中能删除同口径）
  if (s.archived) options.push({ label: '恢复到看板', key: 'unarchive' })
  else options.push({ label: '归档（移出看板，保留记录）', key: 'archive' })
  options.push({ label: '删除会话', key: 'remove' })
  options.push({ label: `终端字号 ${ui.fontSize}px（点击增大）`, key: 'font' })
  options.push({ label: `终端字号 ${ui.fontSize}px（点击缩小）`, key: 'font-dec' })
  options.push({ label: ui.theme === 'dark' ? '切到浅色 ☀️' : '切到深色 🌙', key: 'theme' })
  return options
})

async function run(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// 终端/对话切换：记住偏好，看板点卡片时按偏好进入
function switchMode(mode: SessionViewMode) {
  ui.setSessionView(mode)
  if (mode === 'chat') router.push(`/session/${sessionId.value}/chat`)
}

function onMenu(key: string) {
  const id = sessionId.value
  if (key === 'stop') void run(() => store.stop(id))
  else if (key === 'kill') void run(() => store.kill(id))
  else if (key === 'restart') void run(() => store.restart(id, false))
  else if (key === 'resume') void run(() => store.restart(id, true))
  else if (key === 'rename') openRename(id, session.value?.name ?? '')
  else if (key === 'archive')
    void run(async () => {
      await store.archive(id)
      message.success('已归档，可在「已归档」中查看')
    })
  else if (key === 'unarchive')
    void run(async () => {
      await store.unarchive(id)
      message.success('已恢复到看板')
    })
  else if (key === 'font') ui.setFontSize(ui.fontSize >= 18 ? 11 : ui.fontSize + 1)
  else if (key === 'font-dec') ui.setFontSize(ui.fontSize <= 11 ? 18 : ui.fontSize - 1)
  else if (key === 'theme') ui.toggleTheme()
  else if (key === 'remove') {
    dialog.warning({
      title: '删除会话',
      content: `删除「${session.value?.name}」？${isLive.value ? '会话运行中，将先终止进程。' : ''}`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: () =>
        run(async () => {
          await store.remove(id)
          router.replace('/')
        }),
    })
  } else if (key.startsWith('handoff:')) {
    void run(async () => {
      const next = await store.handoff(id, key.slice(8))
      message.success('已交接给新会话')
      router.replace(`/session/${next.id}`)
    })
  }
}
</script>

<template>
  <div class="session-view">
    <div class="session-head">
      <n-button v-if="!ui.isDesktop" quaternary size="small" class="back-btn" @click="router.push('/')">←</n-button>
      <span class="dot" :style="{ background: lightColor, boxShadow: `0 0 0 3px ${lightColor}22` }" />
      <span class="session-name">{{ session?.name ?? '…' }}</span>
      <n-tag v-if="session" size="small" :bordered="false" class="status-tag">
        {{ STATUS_TEXT[session.status] }}
      </n-tag>
      <span class="spacer" />
      <ViewModeSwitch v-if="session && chatCapable(session, store.templates)" mode="terminal" @switch="switchMode" />
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button quaternary size="small">操作 ▾</n-button>
      </n-dropdown>
    </div>

    <div class="terminal-zone">
      <TerminalPane v-if="session" :key="sessionId" ref="paneRef" :session-id="sessionId" />
      <Transition name="fade">
        <div v-if="session && !isLive" class="exited-banner">
        <span>
          {{ session.exitReason ? EXIT_REASON_TEXT[session.exitReason] : '已退出'
          }}{{ session.exitCode !== null ? `（code ${session.exitCode}）` : '' }} —— 画面为最后快照
        </span>
        </div>
      </Transition>
    </div>

    <MobileKeyBar v-if="ui.isTouch && isLive" :session-id="sessionId" />
    <PromptBar :session-id="sessionId" :disabled="!isLive" />
  </div>
</template>

<style scoped>
.session-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.session-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* PWA 全面屏：顶条自己扛 iPhone 状态栏（App 顶栏在座舱页是隐藏的） */
  padding: calc(6px + env(safe-area-inset-top, 0px)) 10px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bar);
}
.back-btn {
  font-size: 16px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.session-name {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.status-tag {
  background: var(--chip-bg);
  font-size: 11px;
  flex: 0 0 auto;
}
.spacer {
  flex: 1;
}
.terminal-zone {
  position: relative;
  flex: 1;
  min-height: 0;
}
.exited-banner {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--banner-border);
  background: var(--banner-bg);
  color: var(--banner-text);
  font-size: 13px;
  backdrop-filter: blur(4px);
}
</style>
