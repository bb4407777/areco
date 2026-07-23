<script setup lang="ts">
// 历史会话正文：尾部先载 + 「加载更早」向前翻页（字节 before 游标，保持滚动位置）。
// 只读视图；claude/kimi/codex/workbuddy 源可一键原生 resume 拉回看板继续（reasonix 拉选择器）。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, NEmpty, NSpin, useMessage } from 'naive-ui'
import type { HistoryTranscriptPage, SessionSummary, TranscriptMessage } from '../../../shared/protocol'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import ChatMessage from '../components/ChatMessage.vue'
import FilePreview from '../components/FilePreview.vue'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const store = useSessionsStore()
const ui = useUiStore()
const previewPath = ref<string | null>(null)

const source = computed(() => String(route.params.source))
const project = computed(() => String(route.params.project))
const id = computed(() => String(route.params.id))
const title = computed(() => (typeof route.query.title === 'string' && route.query.title) || id.value.slice(0, 8))
const liveSessionId = computed(() => (typeof route.query.live === 'string' ? route.query.live : null))
// 列表页按「该源有无对应模板」算出的可恢复标记；直接输 URL 进来时兜底回主 claude 源判断
const resumable = computed(() => route.query.resumable === '1' || source.value === 'claude')

const baseUrl = computed(() => `/api/history/${source.value}/${project.value}/${id.value}`)

const messages = ref<TranscriptMessage[]>([])
const hasMore = ref(false)
const loading = ref(true)
const loadingOlder = ref(false)
const resuming = ref(false)
const scroller = ref<HTMLElement | null>(null)
let start = 0
// 向前翻页时 firstIndex 后退，保证已渲染消息的 key 稳定不漂移
const firstIndex = ref(0)
let routeGen = 0 // 递增，用于丢弃过期 async 响应

// 路由切换（嵌套路由复用组件）重置状态
const routeKey = computed(() => `${source.value}/${project.value}/${id.value}`)
watch(routeKey, (newKey, oldKey) => {
  if (newKey === oldKey) return
  routeGen++
  messages.value = []
  hasMore.value = false
  loading.value = true
  loadingOlder.value = false
  start = 0
  firstIndex.value = 0
  void fetchTranscript()
})

async function fetchTranscript() {
  const gen = routeGen // 捕获当前代数
  const url = `${baseUrl.value}/transcript`
  try {
    const page = await api.get<HistoryTranscriptPage>(url)
    if (gen !== routeGen) return // 路由已切换，丢弃过期响应
    messages.value = page.messages
    hasMore.value = page.hasMore
    start = page.start
    // 必须先撤下加载态：loading=true 时模板渲染的是 spinner，消息未上 DOM，滚底会落空
    loading.value = false
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
  } catch (err) {
    if (gen !== routeGen) return
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    if (gen === routeGen) loading.value = false
  }
}

onMounted(() => void fetchTranscript())

async function loadOlder() {
  if (loadingOlder.value || !hasMore.value) return
  const gen = routeGen
  const url = `${baseUrl.value}/transcript?before=${start}`
  loadingOlder.value = true
  try {
    const page = await api.get<HistoryTranscriptPage>(url)
    if (gen !== routeGen) return
    const el = scroller.value
    const prevHeight = el?.scrollHeight ?? 0
    firstIndex.value -= page.messages.length
    messages.value = [...page.messages, ...messages.value]
    hasMore.value = page.hasMore
    start = page.start
    await nextTick()
    // 维持视口停在原内容处
    if (el) el.scrollTop += el.scrollHeight - prevHeight
  } catch (err) {
    if (gen !== routeGen) return
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    if (gen === routeGen) loadingOlder.value = false
  }
}

// 「继续 ▾」：原生 resume（无损，同 agent）+ 跨 agent 接续（交接档案，任选模板）
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])
// 各源原生恢复的按钮文案（命令形态不同：claude --resume / kimi -S / codex resume / reasonix 选择器）
const RESUME_LABELS: Record<string, string> = {
  reasonix: '⏪ 原生恢复（打开选择器）',
  kimi: '⏪ 原生恢复（kimi -S）',
  codex: '⏪ 原生恢复（codex resume）',
}
const continueOptions = computed(() => {
  const options: { label: string; key: string }[] = []
  if (resumable.value && !liveSessionId.value) {
    options.push({ label: RESUME_LABELS[source.value] ?? '⏪ 原生恢复（--resume）', key: 'native' })
  }
  for (const t of store.templates) {
    if (!t.enabled || SHELLS.has(t.command.split('/').pop() ?? '')) continue
    options.push({ label: `🤝 用 ${t.name} 接续`, key: `tpl:${t.id}` })
  }
  return options
})

async function spawnVia(path: string, body: Record<string, unknown>, okText: string) {
  resuming.value = true
  try {
    const session = await api.post<SessionSummary>(path, body)
    message.success(okText)
    router.replace(`/session/${session.id}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    resuming.value = false
  }
}

function onContinue(key: string) {
  if (key === 'native') void spawnVia(`${baseUrl.value}/resume`, { name: title.value }, '已恢复到看板')
  else if (key.startsWith('tpl:'))
    void spawnVia(`${baseUrl.value}/continue`, { templateId: key.slice(4), name: title.value }, '已交接给新会话')
}
</script>

<template>
  <div class="history-transcript">
    <div class="head">
      <n-button v-if="!ui.isDesktop" quaternary size="small" @click="router.push('/history')">←</n-button>
      <span class="name">{{ title }}</span>
      <span class="spacer" />
      <n-button v-if="liveSessionId" size="small" secondary @click="router.push('/')">打开看板</n-button>
      <n-dropdown v-if="continueOptions.length" trigger="click" :options="continueOptions" @select="onContinue">
        <n-button size="small" secondary :loading="resuming">▶️ 继续 ▾</n-button>
      </n-dropdown>
    </div>

    <div ref="scroller" class="stream">
      <n-spin v-if="loading" class="center" />
      <n-empty v-else-if="!messages.length" description="这份日志里没有可展示的对话" class="center" />
      <template v-else>
        <div class="more">
          <n-button v-if="hasMore" size="tiny" quaternary :loading="loadingOlder" @click="loadOlder">↑ 加载更早</n-button>
          <span v-else class="done">已到最早</span>
        </div>
        <ChatMessage
          v-for="(msg, i) in messages"
          :key="firstIndex + i"
          :message="msg"
          @preview="previewPath = $event"
        />
        <div class="stream-tail" />
      </template>
    </div>
    <FilePreview :path="previewPath" @close="previewPath = null" />
  </div>
</template>

<style scoped>
.history-transcript {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  padding-top: calc(6px + env(safe-area-inset-top, 0px));
  border-bottom: 1px solid var(--border);
  background: var(--bar);
}
.name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.spacer {
  flex: 1;
}
.stream {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0 calc(14px + env(safe-area-inset-bottom, 0px));
  overscroll-behavior: contain;
}
.more {
  display: flex;
  justify-content: center;
  padding: 2px 0 8px;
}
.done {
  font-size: 11px;
  color: var(--faint);
}
.stream-tail {
  height: 8px;
}
.center {
  margin-top: 18vh;
  display: flex;
  justify-content: center;
}
</style>
