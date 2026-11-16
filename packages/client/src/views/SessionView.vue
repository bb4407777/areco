<script setup lang="ts">
// 座舱页：终端 + 单行 prompt + 触屏键条 + 会话动词。pty 活在服务端，本页只是"接上驾驶杆"。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, NTag, useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { wsClient } from '../ws'
import { EXIT_REASON_TEXT, chatCapable, statusTagText, trafficColor } from '../utils/format'
import TerminalPane from '../components/TerminalPane.vue'
import PromptBar from '../components/PromptBar.vue'
import MobileKeyBar from '../components/MobileKeyBar.vue'
import ViewModeSwitch from '../components/ViewModeSwitch.vue'
import { useRenameDialog } from '../composables/useRenameDialog'
import { useSpawnWorker, HANDOFF_ROLES } from '../composables/useSpawnWorker'
import type { SessionViewMode } from '../stores/ui'

const route = useRoute()
const router = useRouter()
const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()
const { openRename } = useRenameDialog()
const { isRoleMode, handoffRole } = useSpawnWorker()

const sessionId = computed(() => String(route.params.id))
const session = computed(() => store.byId(sessionId.value))
const isLive = computed(() => !!session.value && ['running', 'spawning', 'stopping'].includes(session.value.status))
const paneRef = ref<InstanceType<typeof TerminalPane> | null>(null)
// 提交状态横幅：字在框里干等的时候，让屏幕上有句话（重试第 N 次／排队／已受理）
const submitBanner = ref<{ state: string; attempts: number } | null>(null)
let bannerTimer: ReturnType<typeof setTimeout> | null = null
let offSubmit: (() => void) | null = null
function clearBannerTimer() {
  if (bannerTimer) {
    clearTimeout(bannerTimer)
    bannerTimer = null
  }
}
function showSubmit(state: string, attempts: number) {
  clearBannerTimer()
  submitBanner.value = { state, attempts }
  // 已受理一闪即走；失败常驻到下一次提交；排队/确认中不自动消失
  if (state === 'ok') bannerTimer = setTimeout(() => (submitBanner.value = null), 1500)
}
const SUBMIT_BANNER_TEXT: Record<string, string> = {
  pending: '已发送，确认中…',
  queued: '已发出，agent 本轮结束后自动提交',
  ok: '已受理',
  failed: '未送达，请再点一次发送',
}
const submitBannerText = computed(() => {
  const b = submitBanner.value
  if (!b) return ''
  const base = SUBMIT_BANNER_TEXT[b.state] ?? ''
  return b.state === 'pending' && b.attempts > 0 ? `未确认，重试第 ${b.attempts} 次…` : base
})
onMounted(() => {
  offSubmit = wsClient.onMessage((msg) => {
    if (msg.type !== 'submit-state' || msg.sessionId !== sessionId.value) return
    showSubmit(msg.state, msg.attempts)
  })
})
onBeforeUnmount(() => {
  clearBannerTimer()
  offSubmit?.()
  offSubmit = null
})
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

// 换 agent 接手候选：角色模式给四档角色（worker/thinker/快速/重活，HANDOFF_ROLES 单源）；
// 模板模式列全部启用的非 shell 模板（与侧栏/看板卡片同口径）
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])
const handoffChildren = computed(() =>
  isRoleMode.value
    ? HANDOFF_ROLES.map((r) => ({ label: r.label, key: `handoff-role:${r.role}` }))
    : store.templates
        .filter((t) => t.enabled && !SHELLS.has(t.command.split('/').pop() ?? ''))
        .map((t) => ({ label: `用 ${t.name} 接手`, key: `handoff:${t.id}` })),
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

// 终端/对话切换：只换本次路由，不写回默认（默认显示模式由设置页统一管，重进按默认，2026-07-24 维护者定）
function switchMode(mode: SessionViewMode) {
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
    void run(async () => {
      await store.remove(id)
      router.replace('/')
    })
  } else if (key.startsWith('handoff-role:')) {
    const hit = HANDOFF_ROLES.find((r) => key === `handoff-role:${r.role}`)
    if (hit) void handoffRole(id, hit.role, hit.label)
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
        {{ statusTagText(session) }}
      </n-tag>
      <span class="spacer" />
      <ViewModeSwitch mode="terminal" @switch="switchMode" />
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

    <!-- 提交状态：字还没进 agent 时这里有一句话，别让人盯着输入框猜 -->
    <div v-if="submitBanner" class="submit-banner" :class="`submit-${submitBanner.state}`">
      {{ submitBannerText }}
    </div>

    <!-- 始终占位：v-if 卸载会改变终端容器高度 → resize → kimi TUI 3J 重绘 → 视口跳转 -->
    <MobileKeyBar :session-id="sessionId" :class="{ 'keybar-off': !(ui.isTouch && isLive) }" />
    <!-- 死会话也可直接发：服务端自动 resume 拉起、就绪后注入（gateway sendline 自动恢复） -->
    <PromptBar :session-id="sessionId" :placeholder="isLive ? undefined : '会话已退出，发送将自动恢复对话…'" />
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
.submit-banner {
  flex: 0 0 auto;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  border-top: 1px solid var(--border);
  background: var(--chip-bg);
  color: var(--muted);
}
.submit-failed {
  background: color-mix(in srgb, var(--danger, #d03050) 14%, transparent);
  color: var(--danger, #d03050);
}
.submit-ok {
  background: color-mix(in srgb, #18a058 16%, transparent);
  color: #18a058;
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
.keybar-off {
  visibility: hidden;
  pointer-events: none;
}
</style>
