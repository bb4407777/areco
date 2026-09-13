<script setup lang="ts">
// 微信会话（只读）：读 Hermes state.db 里 source=weixin 的会话。
// 消「微信与 areco 割裂」的看得见那一半——此前微信侧能派活给 areco，
// 反过来在座舱里看不到微信在聊什么、派活的上下文是什么。
// 无侧栏（2026-08-04 高律师定「点微信直接就显示会话」）：微信那些「会话」不是不同的对话——
// 一个微信号 = 一个 profile = 一个 agent，它们只是同一段对话被 session_reset 切开的时间片，
// 列表隐喻本就不对。默认直接展开最近一段，顶部一个可搜索下拉切换旧时间片。
// 气泡直接复用会话对话模式的 ChatMessage.vue（2026-08-04 高律师：微信界面气泡跟对话模式不一致，
// 换成同款）——markdown 渲染、折叠工具块、复制按钮、配色变量全部单源，不再各画一份。
// 只读纪律见服务端 services/weixin-sessions.ts：DatabaseSync({readOnly:true}) 驱动层强制。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSelect, NSpin, useMessage } from 'naive-ui'
import { api } from '../api'
import ChatMessage from '../components/ChatMessage.vue'
import type { TranscriptMessage, TranscriptPart } from '../../../shared/protocol'

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
  /** 本页起始字节（向前翻页用 before=start） */
  start?: number
}
/** 服务端 /api/weixin/search 的命中行 */
interface WxSearchHit {
  sessionId: string
  sessionTitle: string | null
  sessionStartedAt: number | null
  role: string
  timestamp: number | null
  snippet: string
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

/** 服务端 timestamp 可能是秒也可能是毫秒，统一成毫秒 */
function toMs(ts: number): number {
  return ts < 1e11 ? ts * 1000 : ts
}
function fmtTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(toMs(ts))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 微信消息 → ChatMessage 的 TranscriptMessage 同形：
 *  - tool_use 的正文在 weixin 侧叫 text，映射到 input（折叠块里展示）；
 *  - 用户/工具归属由 ChatMessage 自己判（role=user 且带 text 段才算用户泡泡，同原 isSelf 规则） */
function toTranscript(m: WxMsg): TranscriptMessage {
  const parts: TranscriptPart[] = (m.parts || []).map((p) => {
    if (p.kind === 'text') return { kind: 'text', text: p.text ?? '' }
    if (p.kind === 'tool_use') return { kind: 'tool_use', name: p.name ?? '', input: p.text ?? '' }
    return { kind: 'tool_result', text: p.text ?? '', isError: !!p.isError }
  })
  return {
    role: m.role === 'user' ? 'user' : 'assistant',
    parts,
    timestamp: m.timestamp ? new Date(toMs(m.timestamp)).toISOString() : null,
  }
}
const chatMsgs = computed(() => msgs.value.map(toTranscript))

// ---- 跨会话查找 / 查找下一个（2026-08-04 高律师） ----
// 搜全部微信会话（服务端 SQL 按 msg timestamp DESC → 从新到旧），命中自动跳到对应会话。
// 当前会话搜不到 → 自动跳前一个（更旧的）会话。查找下一个也按新→旧顺序跨会话走。
// 输入即搜（防抖 300ms）；回车/↑ = 更早的命中，↓ = 更新的命中（循环）。
const searchQ = ref('')
const hits = ref<WxSearchHit[]>([])
const hitPos = ref(0)
/** 当前命中在 chatMsgs 里的下标，-1 = 无标记 */
const currentHitIdx = ref(-1)
const searching = ref(false)
let lastQ = ''
let searchTimer: number | null = null

watch(searchQ, (v) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  if (!v.trim()) {
    searchTimer = null
    clearSearch()
    return
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void doSearch()
  }, 300)
})

async function doSearch() {
  const q = searchQ.value.trim()
  if (!q) { clearSearch(); return }
  lastQ = q
  searching.value = true
  try {
    const raw = await api.get<WxSearchHit[]>(`/api/weixin/search?q=${encodeURIComponent(q)}&limit=100`)
    // 一条消息命中多个 part（正文 + 工具段）时服务端会返回多行，落到界面上是同一个气泡：
    // 不去重则 ↑/↓ 按一下计数变了、视口纹丝不动，看着又像"没跳过去"（2026-08-05 同批修）
    const seen = new Set<string>()
    hits.value = raw.filter((h) => {
      const k = `${h.sessionId}|${h.role}|${h.timestamp}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  } catch (err) {
    message.error(`搜索失败：${(err as Error).message}`)
    hits.value = []
  } finally {
    searching.value = false
  }
  hitPos.value = 0
  if (hits.value.length) {
    await gotoHit(hits.value[0])
  } else {
    message.info(`没找到「${q}」`)
  }
}

/** 跳到指定命中：切换会话（如有）→ 确保全加载 → 精确定位消息 → 滚动到关键词 */
async function gotoHit(h: WxSearchHit) {
  if (h.sessionId !== selected.value) {
    await openSession(h.sessionId)
  }
  // 全量加载确保目标消息已加载（openSession 已全量加载，这里兜底）
  while (msgHasMore.value) await loadMoreMsgs()

  // 精确定位：timestamp（±1s）+ role + 正文（只看 text part，排除工具段）含关键词
  const targetTs = h.timestamp
  const kw = lastQ.toLowerCase()
  const expectedRole = h.role === 'assistant' ? 'assistant' : 'user'
  let bestIdx = -1
  for (let i = 0; i < chatMsgs.value.length; i++) {
    const m = chatMsgs.value[i]
    if (m.role !== expectedRole) continue
    // 只取 text part（跳过 tool_use/tool_result —— 工具折叠块不算对话正文）
    const textParts = m.parts.filter((p) => p.kind === 'text')
    if (!textParts.length) continue
    if (targetTs && m.timestamp) {
      const diff = Math.abs(new Date(m.timestamp).getTime() - targetTs)
      if (diff > 1000) continue
    }
    if (kw) {
      const text = textParts.map((p) => p.text).join('\n').toLowerCase()
      if (!text.includes(kw)) continue
    }
    bestIdx = i
    break // 第一个匹配就取
  }
  currentHitIdx.value = bestIdx
  await nextTick()
  await scrollToCurrentHit()
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

/**
 * 滚到当前命中的红标（mark.hl-now），滚不到红标才退回气泡。
 *
 * 坑（2026-08-05 高律师报「查找的红色高亮没显示出来」，实测定位）：命中所在会话是刚切过去
 * 全量渲染的，19800 字的 CONTEXT COMPACTION 摘要这类大气泡要好几帧布局才稳。旧写法在
 * nextTick 后就 `scrollIntoView({behavior:'smooth'})`——浏览器**按调用当刻的旧几何**算死目标偏移，
 * 再花 1.4s 平滑动画滚过去：CDP 实测视口 600ms 时已经到位（scrollTop 10949，红标差一点进视口），
 * 随后被动画一路拖回 scrollTop=972 停住，红标远在视口外，看起来就是"高亮压根没出来"。
 * 改法两条：① 瞬时滚（直接写 scrollTop），不给动画被旧几何带偏的机会；
 * ② 逐帧复查重滚，布局还在长就再修一次，直到居中收敛或滚到边界。
 * 另：只动 .msgs 这个容器，不用 scrollIntoView——它会把所有可滚祖先一起滚，页面级版式会被带歪。
 */
async function scrollToCurrentHit() {
  const idx = currentHitIdx.value
  if (idx < 0) return
  let lastHeight = -1
  let settled = 0
  // 只滚一次不够：上万字的 markdown 气泡要几十帧才长完，先滚过去会被后长出来的内容顶下去
  // （实测第一版只纠 8 帧，红标最后还是掉到视口下方 155px）。逐帧纠正，直到
  // 「容器高度不再变 + 这一帧没再动（已居中或已顶到边界）」连续 3 帧成立；60 帧(~1s) 兜底。
  for (let i = 0; i < 60; i++) {
    await nextFrame()
    if (currentHitIdx.value !== idx) return // 期间又跳去别的命中了，让新的那次接管
    const box = scroller.value
    const wrap = box?.querySelector<HTMLElement>(`[data-i="${idx}"]`)
    if (!box || !wrap) return
    // 命中气泡可能上万字，只滚到气泡顶部照样看不见关键词，优先对准红标
    const target = wrap.querySelector<HTMLElement>('mark.hl-now') ?? wrap
    const tr = target.getBoundingClientRect()
    const br = box.getBoundingClientRect()
    const delta = tr.top - br.top - Math.max(0, (box.clientHeight - tr.height) / 2)
    const height = box.scrollHeight
    const before = box.scrollTop
    if (Math.abs(delta) > 2) box.scrollTop = before + delta
    settled = height === lastHeight && box.scrollTop === before ? settled + 1 : 0
    lastHeight = height
    if (settled >= 3) return
  }
}

async function nextMatch() {
  if (!hits.value.length) return
  hitPos.value = (hitPos.value + 1) % hits.value.length
  await gotoHit(hits.value[hitPos.value])
}

async function prevMatch() {
  if (!hits.value.length) return
  hitPos.value = (hitPos.value - 1 + hits.value.length) % hits.value.length
  await gotoHit(hits.value[hitPos.value])
}

function clearSearch() {
  searchQ.value = ''
  lastQ = ''
  hits.value = []
  hitPos.value = 0
  currentHitIdx.value = -1
}

/** 回车：词没变 = 跳更早的命中（同 ↑）；词变了立即查 */
async function onSearchEnter() {
  const q = searchQ.value.trim()
  if (q && q === lastQ && hits.value.length) return nextMatch()
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
  await doSearch()
}

async function load() {
  loading.value = true
  try {
    const page = await api.get<WeixinListPage>(`/api/weixin/sessions?limit=${ALL}&offset=0`)
    rows.value = page.sessions
    total.value = page.total
    // 直接展开最近一段：进页面即有内容，不用先点
    if (!selected.value && rows.value.length) void openSession(rows.value[0].id)
  } catch (err) {
    message.error(`加载微信会话失败：${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function openSession(id: string) {
  selected.value = id
  currentHitIdx.value = -1
  msgs.value = []
  msgLoading.value = true
  try {
    // 首页（取最近 80 条）
    let page = await api.get<WxTranscriptPage>(`/api/weixin/sessions/${encodeURIComponent(id)}/transcript?cursor=0`)
    msgs.value = page.messages
    msgHasMore.value = page.hasMore
    cursor = page.cursor // 模块级 cursor 不随会话切换自动归位，不接上会让 loadMoreMsgs 拿旧游标重复追加
    // 用 before=start 链式向前翻，直到 hasMore=false（服务端 paginate 的正确用法：
    // cursor=N 返回的是 slice(N) 不是更早的消息，只有 before=start 才取得到前段）
    while (msgHasMore.value && typeof page.start === 'number' && page.start > 0) {
      page = await api.get<WxTranscriptPage>(
        `/api/weixin/sessions/${encodeURIComponent(id)}/transcript?before=${page.start}`
      )
      // earlier messages prepend: 服务端按 id ASC 返回，slice(start,end) 里 end 是上一页 start
      msgs.value = [...page.messages, ...msgs.value]
      msgHasMore.value = page.hasMore
    }
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  } catch (err) {
    message.error(`加载对话失败：${(err as Error).message}`)
  } finally {
    msgLoading.value = false
  }
}

/** 消息是否有 text 正文段（纯 tool_use/tool_result 消息不高亮关键词） */
function hasTextPart(m: TranscriptMessage): boolean {
  return m.parts.some((p) => p.kind === 'text')
}

function openFromPicker(id: string) {
  clearSearch()
  void openSession(id)
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
        @update:value="(v: string) => v && openFromPicker(v)"
      />
      <NInput
        v-model:value="searchQ"
        size="small"
        clearable
        placeholder="查找对话内容…"
        class="wx-search"
        :loading="searching"
        @keyup.enter="onSearchEnter"
        @clear="clearSearch"
      >
        <template #prefix>🔍</template>
      </NInput>
      <template v-if="hits.length">
        <span class="match-count">{{ hitPos + 1 }}/{{ hits.length }}</span>
        <NButton size="tiny" quaternary title="更早的命中（回车同）" @click="nextMatch">↑</NButton>
        <NButton size="tiny" quaternary title="更新的命中" @click="prevMatch">↓</NButton>
      </template>
      <span v-if="current" class="main-sub">
        {{ current.model }} · {{ fmtTime(current.startedAt) }} · 共 {{ total }} 段
      </span>
    </div>

    <NSpin v-if="loading && !msgs.length" class="main-empty" />
    <NEmpty v-else-if="!rows.length" description="没有微信会话" class="main-empty" />
    <NSpin v-else-if="msgLoading && !msgs.length" class="main-empty" />
    <div v-else ref="scroller" class="msgs">
      <div
        v-for="(m, i) in chatMsgs"
        :key="i"
        class="msg-wrap"
        :class="{ 'hit-now': i === currentHitIdx }"
        :data-i="i"
      >
        <ChatMessage :message="m" agent-label="Hermes" :highlight="lastQ && hasTextPart(m) ? lastQ : undefined" :highlight-active="i === currentHitIdx" />
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

/* ---- 右主区：气泡流交给 ChatMessage.vue（与会话对话模式同组件），这里只留容器 ---- */
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

/* 与 TranscriptView .stream 同口径：容器不管气泡间距，气泡自带 padding */
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  overscroll-behavior: contain;
}

.more-btn {
  align-self: center;
  margin-bottom: 6px;
}

.wx-picker {
  width: 280px;
  max-width: 55vw;
}

.wx-search {
  width: 220px;
  max-width: 40vw;
  flex: 0 0 auto;
}

.match-count {
  font-size: 11px;
  color: var(--muted);
  flex: 0 0 auto;
}

/* 查找命中：当前命中气泡整段加 accent 左边条 + 浅底；关键词本身的黄/红标由
   ChatMessage 的 highlight prop 注进 markdown（mark.hl / mark.hl-now），两层是配合不是二选一 */
.msg-wrap {
  border-radius: 10px;
}

.msg-wrap.hit-now {
  background: var(--chip-bg);
  box-shadow: inset 3px 0 0 var(--accent);
}
</style>
