<script setup lang="ts">
// weSaw 会话（只读）：weSaw 每个联系人/群工作区绑一个 agent 会话，这里直接看会话名 + agent 对话正文。
// 与微信页（cc-connect 存档）并列的另一半：微信页看「聊天通道」，这里看「weSaw 里跟谁、agent 聊了什么」。
// 数据源：服务端扫 ~/Documents/weSaw/document 的 .agent-session.json，正文读 kimi/pi 会话文件（services/wesaw.ts）。
// 气泡复用 ChatMessage.vue（markdown、折叠工具块、复制、播报全部单源）。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NEmpty, NSelect, NSpin, useMessage } from 'naive-ui'
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
  size: number
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

const ALL = 500
const message = useMessage()
const speech = useSpeechStore()

const rows = ref<WesawSessionRow[]>([])
const total = ref(0)
const loading = ref(true)
const selected = ref<string | null>(null)

const msgs = ref<TranscriptMessage[]>([])
const msgLoading = ref(false)
const scroller = ref<HTMLElement | null>(null)

const current = computed(() => rows.value.find((r) => r.id === selected.value) ?? null)
const options = computed(() =>
  rows.value.map((r) => ({
    label: `${r.name}　·　${r.kind}　·　${fmtTime(r.updatedAt)}`,
    value: r.id,
  }))
)

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function load() {
  loading.value = true
  try {
    const page = await api.get<WesawListPage>(`/api/wesaw/sessions?limit=${ALL}&offset=0`)
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

function openFromPicker(id: string) {
  void openSession(id)
}

onMounted(() => void load())

// 播报只服务当前这一屏：换会话或离开本页即停（同会话页/群聊页口径）
watch(selected, () => speech.stop())
onUnmounted(() => speech.stop())
</script>

<template>
  <div class="wesaw">
    <div class="main-head">
      <NSelect
        v-model:value="selected"
        :options="options"
        :loading="loading"
        filterable
        size="small"
        placeholder="选择 weSaw 会话"
        class="ws-picker"
        @update:value="(v: string) => v && openFromPicker(v)"
      />
      <span v-if="current" class="main-sub">
        {{ current.kind }} · {{ current.cli }} · 共 {{ total }} 个会话
      </span>
    </div>

    <NSpin v-if="loading && !msgs.length" class="main-empty" />
    <NEmpty v-else-if="!rows.length" description="没有可读的 weSaw 会话" class="main-empty" />
    <NSpin v-else-if="msgLoading && !msgs.length" class="main-empty" />
    <NEmpty v-else-if="!msgs.length" description="这个会话还没有 agent 记录" class="main-empty" />
    <div v-else ref="scroller" class="msgs">
      <div v-for="(m, i) in msgs" :key="i" class="msg-wrap">
        <ChatMessage :message="m" :agent-label="current?.cli || 'weSaw'" speakable :session-id="`wesaw:${selected}`" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wesaw {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.main-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.main-sub {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-empty {
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

.ws-picker {
  width: 360px;
  max-width: 60vw;
}
</style>
