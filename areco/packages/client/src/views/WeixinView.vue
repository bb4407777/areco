<script setup lang="ts">
// 微信会话列表（只读）：读 Hermes state.db 里 source=weixin 的会话。
// 消「微信与 areco 割裂」的看得见那一半——此前微信侧能派活给 areco，
// 反过来在座舱里看不到微信在聊什么、派活的上下文是什么。
// 只读纪律见服务端 services/weixin-sessions.ts：DatabaseSync({readOnly:true}) 驱动层强制。
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSpin, NTag, useMessage } from 'naive-ui'
import { api } from '../api'

interface WeixinSessionRow {
  id: string
  title: string | null
  model: string | null
  startedAt: number | null
  endedAt: number | null
  endReason: string | null
  messageCount: number
  chatType: string | null
}
interface WeixinListPage {
  sessions: WeixinSessionRow[]
  total: number
  hasMore: boolean
}
/** 服务端 transcript 的 part（与 areco 原生 TranscriptMessage.parts 同形） */
interface WxPart {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  isError?: boolean
}
interface WxMsg {
  role: string
  parts?: WxPart[]
}
interface WxTranscriptPage {
  exists: boolean
  messages: WxMsg[]
  cursor: number
  hasMore: boolean
}

const PAGE = 30
const message = useMessage()
const rows = ref<WeixinSessionRow[]>([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(true)
const loadingMore = ref(false)
const q = ref('')
const selected = ref<string | null>(null)

// 对话正文（右栏）
const msgs = ref<WxMsg[]>([])
const msgLoading = ref(false)
const msgHasMore = ref(false)
let cursor = 0

const qTrim = computed(() => q.value.trim())

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts < 1e11 ? ts * 1000 : ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load(reset = true) {
  const offset = reset ? 0 : rows.value.length
  if (reset) loading.value = true
  else loadingMore.value = true
  try {
    const query = qTrim.value ? `&q=${encodeURIComponent(qTrim.value)}` : ''
    const page = await api.get<WeixinListPage>(`/api/weixin/sessions?limit=${PAGE}&offset=${offset}${query}`)
    rows.value = reset ? page.sessions : [...rows.value, ...page.sessions]
    total.value = page.total
    hasMore.value = page.hasMore
  } catch (err) {
    message.error(`加载微信会话失败：${(err as Error).message}`)
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function open(id: string) {
  selected.value = id
  msgs.value = []
  cursor = 0
  msgLoading.value = true
  try {
    const page = await api.get<WxTranscriptPage>(`/api/weixin/sessions/${encodeURIComponent(id)}/transcript?cursor=0`)
    msgs.value = page.messages
    cursor = page.cursor
    msgHasMore.value = page.hasMore
  } catch (err) {
    message.error(`加载对话失败：${(err as Error).message}`)
  } finally {
    msgLoading.value = false
  }
}

async function loadMoreMsgs() {
  if (!selected.value || !msgHasMore.value) return
  msgLoading.value = true
  try {
    const page = await api.get<WxTranscriptPage>(
      `/api/weixin/sessions/${encodeURIComponent(selected.value)}/transcript?cursor=${cursor}`
    )
    msgs.value = [...msgs.value, ...page.messages]
    cursor = page.cursor
    msgHasMore.value = page.hasMore
  } catch (err) {
    message.error(`加载更多失败：${(err as Error).message}`)
  } finally {
    msgLoading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(true), 250)
})

onMounted(() => void load(true))
</script>

<template>
  <div class="wx-wrap">
    <div class="wx-list">
      <div class="wx-head">
        <span class="wx-title">微信会话</span>
        <span class="wx-count">{{ total }} 个</span>
      </div>
      <NInput v-model:value="q" placeholder="搜标题或会话 id" clearable size="small" class="wx-search" />
      <NSpin v-if="loading" class="wx-spin" />
      <NEmpty v-else-if="!rows.length" description="没有微信会话" class="wx-spin" />
      <template v-else>
        <div
          v-for="r in rows"
          :key="r.id"
          class="wx-item"
          :class="{ active: selected === r.id }"
          @click="open(r.id)"
        >
          <div class="wx-item-top">
            <span class="wx-item-title">{{ r.title || '（无题）' }}</span>
            <NTag size="tiny" :bordered="false">{{ r.messageCount }}</NTag>
          </div>
          <div class="wx-item-sub">
            <span>{{ fmtTime(r.startedAt) }}</span>
            <span class="wx-model">{{ r.model || '—' }}</span>
          </div>
        </div>
        <NButton v-if="hasMore" size="small" quaternary :loading="loadingMore" block @click="load(false)">
          加载更多
        </NButton>
      </template>
    </div>

    <div class="wx-detail">
      <NEmpty v-if="!selected" description="选左侧一个会话查看对话" class="wx-spin" />
      <template v-else>
        <NSpin v-if="msgLoading && !msgs.length" class="wx-spin" />
        <div v-else class="wx-msgs">
          <div v-for="(m, i) in msgs" :key="i" class="wx-msg">
            <div class="wx-role">{{ m.role }}</div>
            <div class="wx-parts">
              <div v-for="(p, j) in m.parts || []" :key="j" class="wx-part">
                <template v-if="p.kind === 'text'">
                  <pre class="wx-text">{{ p.text }}</pre>
                </template>
                <template v-else-if="p.kind === 'tool_use'">
                  <div class="wx-tool">🔧 {{ p.name }}</div>
                  <pre class="wx-text dim">{{ p.text }}</pre>
                </template>
                <template v-else>
                  <div class="wx-tool" :class="{ err: p.isError }">
                    {{ p.isError ? '⚠️ 工具报错' : '↩︎ 工具结果' }}
                  </div>
                  <pre class="wx-text dim">{{ p.text }}</pre>
                </template>
              </div>
            </div>
          </div>
          <NButton v-if="msgHasMore" size="small" quaternary :loading="msgLoading" block @click="loadMoreMsgs">
            加载更多消息
          </NButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wx-wrap {
  display: flex;
  height: 100%;
  overflow: hidden;
}
.wx-list {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--ar-border, #2a2a2a);
  overflow-y: auto;
  padding: 8px;
}
.wx-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 4px 4px 8px;
}
.wx-title {
  font-weight: 600;
}
.wx-count {
  font-size: 12px;
  opacity: 0.6;
}
.wx-search {
  margin-bottom: 8px;
}
.wx-spin {
  margin: 32px auto;
  display: block;
}
.wx-item {
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}
.wx-item:hover {
  background: var(--ar-hover, rgba(255, 255, 255, 0.06));
}
.wx-item.active {
  background: var(--ar-active, rgba(255, 255, 255, 0.12));
}
.wx-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.wx-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wx-item-sub {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  opacity: 0.55;
  margin-top: 2px;
}
.wx-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}
.wx-detail {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.wx-msg {
  margin-bottom: 14px;
}
.wx-role {
  font-size: 11px;
  opacity: 0.55;
  margin-bottom: 3px;
}
.wx-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.wx-text.dim {
  opacity: 0.7;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
}
.wx-tool {
  font-size: 12px;
  opacity: 0.75;
  margin: 4px 0 2px;
}
.wx-tool.err {
  color: #e88;
}
.wx-part + .wx-part {
  margin-top: 6px;
}
</style>
