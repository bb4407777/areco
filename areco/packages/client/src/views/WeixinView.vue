<script setup lang="ts">
// 微信会话（只读）：读 Hermes state.db 里 source=weixin 的会话。
// 消「微信与 areco 割裂」的看得见那一半——此前微信侧能派活给 areco，
// 反过来在座舱里看不到微信在聊什么、派活的上下文是什么。
// 排版与 GroupChatView（任务/项目）同构：左 230px 侧栏 + 右主区气泡流，复用同一套 CSS 变量。
// 只读纪律见服务端 services/weixin-sessions.ts：DatabaseSync({readOnly:true}) 驱动层强制。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSpin, useMessage } from 'naive-ui'
import { api } from '../api'
import { useUiStore } from '../stores/ui'

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
  timestamp?: number | null
}
interface WxTranscriptPage {
  exists: boolean
  messages: WxMsg[]
  cursor: number
  hasMore: boolean
}

const PAGE = 30
const message = useMessage()
const ui = useUiStore()

const rows = ref<WeixinSessionRow[]>([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(true)
const loadingMore = ref(false)
const q = ref('')
const selected = ref<string | null>(null)
// 移动端：侧栏浮层，选中会话后自动收起（与 GroupChatView 同行为）
const sideOpen = ref(true)

const msgs = ref<WxMsg[]>([])
const msgLoading = ref(false)
const msgHasMore = ref(false)
const scroller = ref<HTMLElement | null>(null)
let cursor = 0

const qTrim = computed(() => q.value.trim())
const current = computed(() => rows.value.find((r) => r.id === selected.value) ?? null)
const sideVisible = computed(() => (ui.isMobile ? sideOpen.value : true))

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts < 1e11 ? ts * 1000 : ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 角色 → 气泡右对齐：user 视作「自己」，与任务/项目里人类发言同侧 */
function isSelf(role: string): boolean {
  return role === 'user'
}
function roleLabel(role: string): string {
  return role === 'user' ? '我' : role === 'assistant' ? 'Hermes' : role
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
    // 默认展开第一个会话（最近的那个）：进页面即有内容，不用先点一下。
    // 只在尚未选中时自动选，搜索/翻页不抢走已选中的会话；
    // auto=true 让移动端保持侧栏展开——自动选中就收起列表会让人不知道自己在哪。
    if (!selected.value && rows.value.length) void open(rows.value[0].id, true)
  } catch (err) {
    message.error(`加载微信会话失败：${(err as Error).message}`)
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function open(id: string, auto = false) {
  selected.value = id
  msgs.value = []
  cursor = 0
  msgLoading.value = true
  if (ui.isMobile && !auto) sideOpen.value = false
  try {
    const page = await api.get<WxTranscriptPage>(`/api/weixin/sessions/${encodeURIComponent(id)}/transcript?cursor=0`)
    msgs.value = page.messages
    cursor = page.cursor
    msgHasMore.value = page.hasMore
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
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
  <div class="weixin">
    <div v-if="ui.isMobile && sideOpen" class="rooms-mask" @click="sideOpen = false" />
    <aside class="rooms" :class="{ open: sideVisible, overlay: ui.isMobile }">
      <div class="rooms-head">
        <span class="rooms-title">微信会话</span>
        <span class="rooms-count">{{ total }}</span>
      </div>
      <NInput v-model:value="q" placeholder="搜标题 / 会话 id" clearable size="small" class="rooms-search" />
      <div class="rooms-list">
        <NSpin v-if="loading" class="rooms-empty" />
        <NEmpty v-else-if="!rows.length" description="没有微信会话" class="rooms-empty" />
        <template v-else>
          <div v-for="r in rows" :key="r.id" class="cat-head" :class="{ active: selected === r.id }">
            <button class="cat-open" :title="r.title || r.id" @click="open(r.id)">
              <span class="room-dot" :style="{ background: r.endReason ? 'var(--faint)' : 'var(--accent)' }" />
              <span class="room-name">{{ r.title || '（无题）' }}</span>
              <span class="badge">{{ r.messageCount }}</span>
            </button>
          </div>
          <NButton v-if="hasMore" size="tiny" quaternary :loading="loadingMore" block @click="load(false)">
            加载更多
          </NButton>
        </template>
      </div>
    </aside>

    <div class="main">
      <div class="main-head">
        <button v-if="ui.isMobile" class="side-toggle" @click="sideOpen = true">☰</button>
        <span class="main-title">{{ current ? current.title || '（无题）' : '微信' }}</span>
        <span v-if="current" class="main-sub">{{ current.model }} · {{ fmtTime(current.startedAt) }}</span>
      </div>

      <NEmpty v-if="!selected" description="选左侧一个会话查看对话" class="main-empty" />
      <template v-else>
        <NSpin v-if="msgLoading && !msgs.length" class="main-empty" />
        <div v-else ref="scroller" class="msgs">
          <NButton v-if="msgHasMore" size="tiny" quaternary :loading="msgLoading" class="more-btn" @click="loadMoreMsgs">
            加载更早的消息
          </NButton>
          <div v-for="(m, i) in msgs" :key="i" class="msg" :class="{ self: isSelf(m.role) }">
            <div class="msg-meta">
              <span>{{ roleLabel(m.role) }}</span>
            </div>
            <div class="bubble">
              <template v-for="(p, j) in m.parts || []" :key="j">
                <span v-if="p.kind === 'text'">{{ p.text }}</span>
                <span v-else-if="p.kind === 'tool_use'" class="tool">🔧 {{ p.name }}<span v-if="p.text" class="tool-body">{{ p.text }}</span></span>
                <span v-else class="tool" :class="{ err: p.isError }">{{ p.isError ? '⚠️ 工具报错' : '↩︎ 工具结果' }}<span v-if="p.text" class="tool-body">{{ p.text }}</span></span>
              </template>
            </div>
            <div class="msg-foot"><span class="time">{{ fmtTime(m.timestamp) }}</span></div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.weixin {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

/* ---- 左侧栏：与 GroupChatView .rooms 同尺寸同变量 ---- */
.rooms {
  width: 230px;
  flex: 0 0 auto;
  border-right: 1px solid var(--border);
  background: var(--bar);
  display: none;
  flex-direction: column;
}
.rooms.open {
  display: flex;
}
.rooms.overlay {
  position: absolute;
  z-index: 20;
  inset: 0 auto 0 0;
  box-shadow: 4px 0 16px rgba(0, 0, 0, 0.4);
}
.rooms-mask {
  position: absolute;
  z-index: 10;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}
.rooms-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.rooms-title {
  font-weight: 600;
}
.rooms-count {
  font-size: 11px;
  color: var(--muted);
}
.rooms-search {
  /* 同 GroupChatView：naive NInput 根节点自带 width:100%，叠加水平 margin 会溢出侧栏；
     改 width:auto + flex 列 stretch，自动收成栏宽减边距 */
  margin: 6px 8px 0;
  width: auto;
  align-self: stretch;
}
.rooms-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rooms-empty {
  margin-top: 40px;
}
.cat-head {
  display: flex;
  align-items: center;
  min-height: 32px;
  border-radius: 7px;
  color: var(--muted);
  padding: 0 6px;
}
.cat-head:hover {
  background: var(--hover);
}
.cat-head.active {
  background: var(--hover);
  color: var(--text);
}
.cat-open {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  text-align: left;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.room-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.room-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  flex: 0 0 auto;
  min-width: 17px;
  height: 17px;
  border-radius: 9px;
  background: var(--chip-bg);
  color: var(--muted);
  font-size: 10.5px;
  line-height: 17px;
  text-align: center;
  padding: 0 5px;
}

/* ---- 右主区：气泡流，与 GroupChatView .main/.msg/.bubble 同构 ---- */
.main {
  flex: 1;
  min-width: 0;
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
.main-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.main-sub {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-toggle {
  border: 0;
  background: none;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px 0 0;
}
.main-empty {
  margin-top: 60px;
}
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.more-btn {
  align-self: center;
}
.msg {
  max-width: 78%;
  align-self: flex-start;
}
.msg.self {
  align-self: flex-end;
  text-align: right;
}
.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
}
.msg.self .msg-meta {
  justify-content: flex-end;
}
.bubble {
  display: inline-block;
  padding: 8px 11px;
  border-radius: 10px;
  background: var(--chip-bg);
  border-left: 3px solid transparent;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.5;
}
.msg.self .bubble {
  background: var(--bubble-user-bg);
  border: 1px solid var(--bubble-user-border);
}
.msg-foot {
  display: flex;
  align-items: center;
  margin-top: 3px;
}
.msg.self .msg-foot {
  justify-content: flex-end;
}
.msg-foot .time {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}
.msg.self .msg-foot .time {
  margin-left: 0;
}
.tool {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
.tool.err {
  color: #e08a8a;
}
.tool-body {
  display: block;
  margin-top: 2px;
  max-height: 200px;
  overflow: auto;
  font-size: 12px;
  color: var(--faint);
  white-space: pre-wrap;
}
</style>
