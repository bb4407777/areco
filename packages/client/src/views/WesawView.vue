<script setup lang="ts">
// weSaw 会话（只读）：照搬 weSaw 的显示口径——左边会话列表，右边 agent 对话。
// 不显示微信聊天原文，也不显示工作区路径/文件清单（2026-11-19 高律师定）。
// 数据源：服务端扫 ~/Documents/weSaw/document 各工作区，对话 = project.md 工作纪要条目
// ＋引擎会话里尚未入账的助手回复（services/wesaw.ts）。
// 气泡复用 ChatMessage.vue（markdown、折叠工具块、复制、点按播报全部单源）。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NEmpty, NInput, NSpin, useMessage } from 'naive-ui'
import { api } from '../api'
import ChatMessage from '../components/ChatMessage.vue'
import { useSpeechStore } from '../stores/speech'
import type { TranscriptMessage } from '../../../shared/protocol'

interface WesawSessionRow {
  id: string
  name: string
  kind: string
  talker: string
  cli: string
  updatedAt: number
}
interface WesawListPage {
  sessions: WesawSessionRow[]
  total: number
  hasMore: boolean
}
interface WesawTranscriptPage {
  exists: boolean
  messages: TranscriptMessage[]
  cli?: string
}

const PAGE = 300
const message = useMessage()
const speech = useSpeechStore()

const rows = ref<WesawSessionRow[]>([])
const total = ref(0)
const loading = ref(true)
const selected = ref<string | null>(null)
const q = ref('')

const msgs = ref<TranscriptMessage[]>([])
const msgLoading = ref(false)
const scroller = ref<HTMLElement | null>(null)

const current = computed(() => rows.value.find((r) => r.id === selected.value) ?? null)
const shown = computed(() => rows.value)
const hasMore = computed(() => rows.value.length < total.value)

function fmtDay(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function load() {
  loading.value = true
  try {
    const kw = q.value.trim()
    const page = await api.get<WesawListPage>(
      `/api/wesaw/sessions?limit=${PAGE}&offset=0${kw ? `&q=${encodeURIComponent(kw)}` : ''}`
    )
    rows.value = page.sessions
    total.value = page.total
    if (!selected.value && rows.value.length) void openSession(rows.value[0].id)
  } catch (err) {
    message.error(`加载 weSaw 会话失败：${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function openSession(id: string) {
  selected.value = id
  msgs.value = []
  msgLoading.value = true
  try {
    const page = await api.get<WesawTranscriptPage>(`/api/wesaw/sessions/${encodeURIComponent(id)}/transcript`)
    msgs.value = page.exists ? page.messages : []
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  } catch (err) {
    message.error(`加载对话失败：${(err as Error).message}`)
  } finally {
    msgLoading.value = false
  }
}

onMounted(() => void load())

// 搜索走后端（会话清单几千条，只拉当前这屏）
let typing: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (typing) clearTimeout(typing)
  typing = setTimeout(() => void load(), 250)
})

// 播报只服务当前这一屏：换会话或离开本页即停
watch(selected, () => speech.stop())
onUnmounted(() => speech.stop())
</script>

<template>
  <div class="wesaw">
    <aside class="list">
      <div class="list-head">
        <NInput v-model:value="q" size="small" clearable placeholder="搜索会话" />
      </div>
      <NSpin v-if="loading" size="small" class="list-spin" />
      <div v-else class="list-rows">
        <button
          v-for="r in shown"
          :key="r.id"
          class="row"
          :class="{ active: r.id === selected }"
          @click="openSession(r.id)"
        >
          <span class="row-name">{{ r.name }}</span>
          <span class="row-day">{{ fmtDay(r.updatedAt) }}</span>
          <span class="row-kind">{{ r.kind }}</span>
        </button>
        <div v-if="hasMore" class="row-more">仅显示最近 {{ rows.length }} / {{ total }}，可搜索</div>
        <NEmpty v-if="!shown.length" size="small" description="没有匹配的会话" class="list-empty" />
      </div>
    </aside>

    <section class="pane">
      <div v-if="current" class="pane-head">
        <span class="pane-name">{{ current.name }}</span>
        <span class="pane-kind">{{ current.kind }}</span>
      </div>
      <NSpin v-if="msgLoading && !msgs.length" class="pane-empty" />
      <NEmpty v-else-if="!msgs.length" description="这个会话还没有 agent 记录" class="pane-empty" />
      <div v-else ref="scroller" class="msgs">
        <div v-for="(m, i) in msgs" :key="i" class="msg-wrap">
          <ChatMessage :message="m" :agent-label="current?.cli || 'weSaw'" speakable :session-id="`wesaw:${selected}`" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wesaw {
  flex: 1;
  min-height: 0;
  display: flex;
}

.list {
  width: 260px;
  flex: 0 0 260px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-head {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid var(--border);
}

.only-active {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
}

.list-rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--hover);
}

.row.active {
  background: var(--chip-bg);
  border-color: var(--border-strong);
}

.row-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-day {
  font-size: 11px;
  color: var(--faint);
  align-self: center;
}

.row-kind {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--muted);
}

.row-more,
.list-empty {
  padding: 10px 8px;
  font-size: 11px;
  color: var(--faint);
}

.list-spin {
  margin: 30px auto;
}

.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pane-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.pane-name {
  font-size: 13px;
}

.pane-kind {
  font-size: 11px;
  color: var(--faint);
}

.pane-empty {
  margin-top: 60px;
}

.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  overscroll-behavior: contain;
}

.msg-wrap {
  border-radius: 10px;
}
</style>
