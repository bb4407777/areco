<script setup lang="ts">
// 微信会话（只读）：读 Hermes state.db 里 source=weixin 的会话。
// 消「微信与 areco 割裂」的看得见那一半——此前微信侧能派活给 areco，
// 反过来在座舱里看不到微信在聊什么、派活的上下文是什么。
// 无侧栏（2026-08-04 高律师定「点微信直接就显示会话」）：微信那些「会话」不是不同的对话——
// 一个微信号 = 一个 profile = 一个 agent，它们只是同一段对话被 session_reset 切开的时间片，
// 列表隐喻本就不对。默认直接展开最近一段，顶部一个可搜索下拉切换旧时间片。
// 气泡流沿用 GroupChatView（任务/项目）的 .msg/.bubble 同款样式与 CSS 变量。
// 只读纪律见服务端 services/weixin-sessions.ts：DatabaseSync({readOnly:true}) 驱动层强制。
import { computed, nextTick, onMounted, ref } from 'vue'
import { NButton, NEmpty, NSelect, NSpin, useMessage } from 'naive-ui'
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
  timestamp?: number | null
}
interface WxTranscriptPage {
  exists: boolean
  messages: WxMsg[]
  cursor: number
  hasMore: boolean
}

// 会话数不多（实测 24 个），一次载全供下拉选择，省掉分页与侧栏
const ALL = 500
const message = useMessage()

const rows = ref<WeixinSessionRow[]>([])
const total = ref(0)
const loading = ref(true)
const selected = ref<string | null>(null)

const msgs = ref<WxMsg[]>([])
const msgLoading = ref(false)
const msgHasMore = ref(false)
const scroller = ref<HTMLElement | null>(null)
let cursor = 0

const current = computed(() => rows.value.find((r) => r.id === selected.value) ?? null)
/** 下拉选项：标题（无题回落 id 前缀）+ 消息数，label 参与 naive 的 filterable 搜索 */
const options = computed(() =>
  rows.value.map((r) => ({
    label: `${r.title || r.id.slice(0, 15)}　·　${r.messageCount} 条`,
    value: r.id,
  }))
)

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

async function load() {
  loading.value = true
  try {
    const page = await api.get<WeixinListPage>(`/api/weixin/sessions?limit=${ALL}&offset=0`)
    rows.value = page.sessions
    total.value = page.total
    // 直接展开最近一段：进页面即有内容，不用先点
    if (!selected.value && rows.value.length) void open(rows.value[0].id)
  } catch (err) {
    message.error(`加载微信会话失败：${(err as Error).message}`)
  } finally {
    loading.value = false
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

onMounted(() => void load())
</script>

<template>
  <div class="weixin">
    <div class="main-head">
      <NSelect
        v-model:value="selected"
        :options="options"
        :loading="loading"
        filterable
        size="small"
        placeholder="选择会话"
        class="wx-picker"
        @update:value="(v: string) => v && open(v)"
      />
      <span v-if="current" class="main-sub">
        {{ current.model }} · {{ fmtTime(current.startedAt) }} · 共 {{ total }} 段
      </span>
    </div>

    <NSpin v-if="loading && !msgs.length" class="main-empty" />
    <NEmpty v-else-if="!rows.length" description="没有微信会话" class="main-empty" />
    <NSpin v-else-if="msgLoading && !msgs.length" class="main-empty" />
    <div v-else ref="scroller" class="msgs">
      <NButton v-if="msgHasMore" size="tiny" quaternary :loading="msgLoading" class="more-btn" @click="loadMoreMsgs">
        加载更早的消息
      </NButton>
      <div v-for="(m, i) in msgs" :key="i" class="msg" :class="{ self: isSelf(m.role) }">
        <div class="msg-meta"><span>{{ roleLabel(m.role) }}</span></div>
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
  </div>
</template>

<style scoped>
.weixin {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
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

/* ---- 右主区：气泡流，与 GroupChatView .main/.msg/.bubble 同构 ---- */
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

.wx-picker {
  width: 280px;
  max-width: 55vw;
}
</style>
