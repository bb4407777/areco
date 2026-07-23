<script setup lang="ts">
// Transcript 对话视图（座舱聊天模式）：尾部先载 + 「加载更早」向前翻页（同历史页），
// 增量轮询 2.5s 追新（仅页面可见时），底部 PromptBar 可直接续问。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import type { ScreenTailPayload, TranscriptMessage, TranscriptPage } from '../../../shared/protocol'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore, type SessionViewMode } from '../stores/ui'
import { chatCapable, statusTagText, templateLabel, trafficColor } from '../utils/format'
import ArtifactsBar from '../components/ArtifactsBar.vue'
import ChatMessage from '../components/ChatMessage.vue'
import FilePreview from '../components/FilePreview.vue'
import MobileKeyBar from '../components/MobileKeyBar.vue'
import PromptBar from '../components/PromptBar.vue'
import TypingIndicator from '../components/TypingIndicator.vue'
import ViewModeSwitch from '../components/ViewModeSwitch.vue'
import { useRenameDialog } from '../composables/useRenameDialog'

const POLL_MS = 2500

const route = useRoute()
const router = useRouter()
const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()
const dialog = useDialog()
const { openRename } = useRenameDialog()

const sessionId = computed(() => String(route.params.id))
const session = computed(() => store.byId(sessionId.value))
const artifactAgent = computed(() => session.value ? templateLabel(session.value, store.templates) : '当前 Agent')
const isLive = computed(() => !!session.value && ['running', 'spawning', 'stopping'].includes(session.value.status))

// 「操作 ▾」与终端页同款（去掉仅终端相关的字号项）；座舱页不显示全局顶栏，主题入口也在这里
const resumable = computed(() => !!session.value && chatCapable(session.value, store.templates))

// 换 agent 接手候选：全部启用的非 shell 模板
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

function onMenu(key: string) {
  const id = sessionId.value
  if (key === 'stop') void run(() => store.stop(id))
  else if (key === 'kill') void run(() => store.kill(id))
  else if (key === 'restart') void run(() => store.restart(id, false))
  else if (key === 'resume') void run(() => store.restart(id, true))
  else if (key === 'rename') openRename(id, session.value?.name ?? '')
  else if (key === 'theme') ui.toggleTheme()
  else if (key === 'archive') void run(() => store.archive(id))
  else if (key === 'unarchive') void run(() => store.unarchive(id))
  else if (key === 'remove') {
    dialog.warning({
      title: '删除会话',
      content: `确定删除「${session.value?.name}」？记录将移除，无法恢复。`,
      positiveText: '删除',
      negativeText: '取消',
      // 删除成功后 session 消失，「会话被删除→回看板」watch 自动导航
      onPositiveClick: () => run(() => store.remove(id)),
    })
  } else if (key.startsWith('handoff:')) {
    void run(async () => {
      const next = await store.handoff(id, key.slice(8))
      message.success('已交接给新会话')
      router.replace(`/session/${next.id}`)
    })
  }
}
watch(
  () => store.ready && !session.value,
  (gone) => {
    if (gone) router.replace('/')
  }
)

const messages = ref<TranscriptMessage[]>([])
const previewPath = ref<string | null>(null)
const exists = ref(true)
const loading = ref(true)
const loadingOlder = ref(false)
const hasMore = ref(false)
const scroller = ref<HTMLElement | null>(null)
// 离底超过该阈值显示「回到最新」悬浮按钮（不做贴底自动跟滚，追新一律手动点按钮）
const NEAR_BOTTOM_PX = 160
const showJump = ref(false)
let cursor = 0 // 向前增量续读点（字节）；0 = 尚未拿到尾页（服务端按尾页响应）
let start = 0 // 最早已载页的起始字节，「加载更早」传 before=start
// 向前翻页时 firstIndex 后退，保证已渲染消息的 key 稳定不漂移
const firstIndex = ref(0)
let timer: number | null = null
let pollingGen: number | null = null
let sessionGen = 0 // 递增，用于丢弃过期 async 响应

// 会话切换时（嵌套路由复用组件）重置状态，重新载入
watch(sessionId, (newId, oldId) => {
  if (newId === oldId) return
  sessionGen++
  cursor = 0
  start = 0
  firstIndex.value = 0
  messages.value = []
  exists.value = true
  loading.value = true
  loadingOlder.value = false
  hasMore.value = false
  showJump.value = false
  showScreen.value = false
  screenLines.value = []
  screenError.value = false
  void poll()
})

function scrollToBottom(behavior?: ScrollBehavior) {
  const el = scroller.value
  el?.scrollTo({ top: el.scrollHeight, behavior })
}

// 终端尾屏面板：TUI 的选择框/确认提示只画在终端屏幕上、不进 transcript——
// 就地内嵌尾屏 + 快捷键条，不切页即可看到选项并作答
const showScreen = ref(false)
const screenLines = ref<string[]>([])
const screenError = ref(false)
let screenInFlight = false

async function fetchScreen() {
  if (screenInFlight) return
  const gen = sessionGen
  const id = sessionId.value
  screenInFlight = true
  try {
    const data = await api.get<ScreenTailPayload>(`/api/sessions/${id}/screen`)
    if (gen !== sessionGen) return
    screenLines.value = data.lines
    screenError.value = false
  } catch {
    if (gen !== sessionGen) return
    screenError.value = true
  } finally {
    if (gen === sessionGen) screenInFlight = false
  }
}
watch(showScreen, (open) => {
  if (open) void fetchScreen()
})

// Claude 系 AskUserQuestion 的选项等在终端里，transcript 尾消息可检出 → 面板条亮标提醒
const awaitingChoice = computed(() => {
  return session.value?.trafficState === 'needs-user'
})
// agent 正在干活：对话流尾部挂「正在输入中…」动效（对话模式没有终端滚屏的活感）
const working = computed(() => session.value?.status === 'running' && session.value?.trafficState === 'working')
watch(working, async (w) => {
  // 指示气泡刚出现时若本就贴底，跟滚一下让它入镜；用户在上翻则不打扰。
  // 贴底判定必须现场量（showJump 靠 scroll 事件对账，内容变长不触发事件，可能是旧值）
  if (!w) return
  await nextTick()
  const el = scroller.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) scrollToBottom()
})
const lightColor = computed(() =>
  session.value
    ? trafficColor(session.value.trafficState, session.value.status)
    : '#555'
)

async function poll() {
  const gen = sessionGen
  if (pollingGen === gen || document.visibilityState !== 'visible') return
  const id = sessionId.value
  const requestCursor = cursor
  pollingGen = gen
  try {
    // 入轮前记住是否贴底：整页替换后据此决定要不要跟滚（异步 await 前取，替换未发生时的真实位置）
    const wasAtBottom = (() => {
      const el = scroller.value
      if (!el) return true // 首载 scroller 尚未渲染，视为贴底
      return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    })()
    const isFirstLoad = requestCursor === 0
    const page = await api.get<TranscriptPage>(`/api/sessions/${id}/transcript?cursor=${requestCursor}`)
    if (gen !== sessionGen) return // 会话已切换，丢弃过期响应
    exists.value = page.exists
    // 带 start 的是尾页：首载，或 agent 会话（cursor=消息条数）条数收缩触发 total<cursor 的
    // 重置——两种都要整页替换（reasonix replace 语义；kimi 等追加型的小抖动服务端已容差，
    // 到这里的重置都是真收缩）。但滚动区别对待：
    // 只有首载或用户本就贴底才滚到底，否则条数一波动就把正在上翻的用户拽回底部
    //（2026-07-23 维护者报障"发送后跳回会话开头"）。与增量分支「不自动跟滚」同口径。
    const isTailPage = page.start !== undefined
    cursor = page.cursor
    if (isTailPage) {
      start = page.start ?? 0
      hasMore.value = page.hasMore ?? false
      messages.value = page.messages
      firstIndex.value = 0
      if (page.messages.length) {
        // 必须先撤下加载态：loading=true 时模板渲染的是 spinner，消息未上 DOM，滚底会落空
        loading.value = false
        await nextTick()
        if (isFirstLoad || wasAtBottom) scrollToBottom()
        else onScroll() // 未跟滚：内容替换后对账「回到最新」按钮可见性
      }
    } else if (page.messages.length) {
      // 增量新消息只追加不滚动：贴底自动跟滚已关（会杀 iOS 惯性滚动造成断触），追新点「回到最新」
      messages.value.push(...page.messages)
      // 内容变长不触发 scroll 事件，手动对账一次按钮可见性
      await nextTick()
      onScroll()
    }
    // 面板开着时顺轮询节拍刷新终端尾屏
    if (showScreen.value) void fetchScreen()
  } catch {
    /* 网络抖动下一轮再试 */
  } finally {
    if (gen === sessionGen) {
      loading.value = false
      if (pollingGen === gen) pollingGen = null
    }
  }
}

async function loadOlder() {
  if (loadingOlder.value || !hasMore.value) return
  const gen = sessionGen
  const id = sessionId.value
  const before = start
  loadingOlder.value = true
  try {
    const page = await api.get<TranscriptPage>(`/api/sessions/${id}/transcript?before=${before}`)
    if (gen !== sessionGen) return
    const el = scroller.value
    const prevHeight = el?.scrollHeight ?? 0
    firstIndex.value -= page.messages.length
    messages.value = [...page.messages, ...messages.value]
    hasMore.value = page.hasMore ?? false
    start = page.start ?? 0
    await nextTick()
    // 维持视口停在原内容处
    if (el) el.scrollTop += el.scrollHeight - prevHeight
  } catch {
    /* 下次点再试 */
  } finally {
    if (gen === sessionGen) loadingOlder.value = false
  }
}

// 滚动时同步「回到最新」按钮可见性；程序化 scrollTo 也触发 scroll 事件，状态自然对账
function onScroll() {
  const el = scroller.value
  if (!el) return
  showJump.value = el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM_PX
}

function jumpToLatest() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  scrollToBottom(reduce ? 'auto' : 'smooth')
}

function switchMode(mode: SessionViewMode) {
  ui.setSessionView(mode)
  if (mode === 'terminal') router.push(`/session/${sessionId.value}`)
}

onMounted(() => {
  void poll()
  timer = window.setInterval(() => void poll(), POLL_MS)
})
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})
</script>

<template>
  <div class="transcript-view">
    <div class="head">
      <n-button v-if="!ui.isDesktop" quaternary size="small" @click="router.push('/')">←</n-button>
      <span class="dot" :style="{ background: lightColor, boxShadow: `0 0 0 3px ${lightColor}22` }" />
      <span class="name">{{ session?.name ?? '…' }}</span>
      <n-tag v-if="session" size="small" :bordered="false" class="status-tag">{{ statusTagText(session) }}</n-tag>
      <span class="spacer" />
      <ViewModeSwitch mode="chat" @switch="switchMode" />
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button quaternary size="small">操作 ▾</n-button>
      </n-dropdown>
    </div>

    <div class="stream-wrap">
      <div ref="scroller" class="stream" @scroll.passive="onScroll">
        <n-spin v-if="loading" class="center" />
        <template v-else>
          <!-- .more 固定高度常驻：空态/「加载更早」/「已到最早」三态同尺寸，切换不跳 -->
          <div class="more">
            <template v-if="exists && messages.length">
              <n-button v-if="hasMore" size="tiny" quaternary :loading="loadingOlder" @click="loadOlder">↑ 加载更早</n-button>
              <span v-else class="done">已到最早</span>
            </template>
            <span v-else class="done">没有会话</span>
          </div>
          <ChatMessage
            v-for="(msg, i) in messages"
            :key="firstIndex + i"
            :message="msg"
            :agent-label="artifactAgent"
            @preview="previewPath = $event"
          />
          <div v-if="messages.length" class="stream-tail" />
        </template>
        <TypingIndicator v-if="working && !loading" class="stream-typing" label="正在输入中…" />
      </div>
      <Transition name="jump">
        <button v-if="showJump" type="button" class="jump-latest" @click="jumpToLatest">↓ 回到最新</button>
      </Transition>
    </div>

    <ArtifactsBar
      v-if="exists && !loading"
      :session-id="sessionId"
      :agent-label="artifactAgent"
      @preview="previewPath = $event"
    />

    <div v-if="isLive" class="screen-peek">
      <button class="peek-toggle" type="button" @click="showScreen = !showScreen">
        <span>⌨️ 终端画面</span>
        <span v-if="awaitingChoice" class="peek-badge">有选项待选</span>
        <span class="peek-caret">{{ showScreen ? '▾' : '▸' }}</span>
      </button>
      <template v-if="showScreen">
        <pre class="peek-screen">{{
          screenError ? '（终端画面接口未就绪：服务端重启后生效）' : screenLines.join('\n') || '（暂无画面）'
        }}</pre>
        <MobileKeyBar :session-id="sessionId" />
      </template>
    </div>

    <!-- 死会话也可直接发：服务端自动 resume 拉起、就绪后注入（gateway sendline 自动恢复） -->
    <PromptBar :session-id="sessionId" :placeholder="isLive ? undefined : '会话已退出，发送将自动恢复对话…'" />
    <FilePreview :path="previewPath" @close="previewPath = null" />
  </div>
</template>

<style scoped>
.transcript-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(6px + env(safe-area-inset-top, 0px)) 10px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bar);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.stream-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.stream {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0;
  overscroll-behavior: contain;
}
.jump-latest {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  line-height: 1;
  box-shadow: 0 4px 14px var(--shadow);
  cursor: pointer;
}
.jump-enter-active,
.jump-leave-active {
  transition:
    opacity 0.15s var(--ease-out),
    transform 0.15s var(--ease-out);
}
.jump-enter-from,
.jump-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
.screen-peek {
  border-top: 1px solid var(--border);
  background: var(--bar);
}
.peek-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  touch-action: manipulation;
}
.peek-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 600;
}
.peek-caret {
  margin-left: auto;
}
.peek-screen {
  margin: 0;
  padding: 8px 12px;
  max-height: 220px;
  overflow: auto;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre;
  color: var(--fold-text);
  background: var(--term-bg);
  border-top: 1px solid var(--border);
}
.more {
  display: flex;
  justify-content: center;
  align-items: center;
  box-sizing: border-box;
  height: 32px; /* tiny 按钮 22px + padding 10px：「加载更早」/「已到最早」/空态同高不塌缩 */
  padding: 2px 0 8px;
}
.done {
  font-size: 11px;
  color: var(--faint);
}
.stream-tail {
  height: 8px;
}
.stream-typing {
  margin: 0 12px 8px;
}
.center {
  margin-top: 18vh;
  display: flex;
  justify-content: center;
}
</style>
