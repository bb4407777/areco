<script setup lang="ts">
// weSaw（只读）：照 weSaw 现版界面复制一份——会话列表用它的会话行样式，
// 去掉中间的微信聊天记录与右侧工作区面板，只留「会话列表 ＋ agent 对话」。
// 桌面两栏；手机单栏，点会话进对话、左上角返回列表（2026-11-19 高律师定）。
// 气泡复用 ChatMessage.vue（markdown、折叠工具块、复制、点按播报单源）。
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { NEmpty, NSpin, useMessage } from 'naive-ui'
import { api } from '../api'
import ChatMessage from '../components/ChatMessage.vue'
import { useSpeechStore } from '../stores/speech'
import { useUiStore } from '../stores/ui'
import type { TranscriptMessage } from '../../../shared/protocol'

interface WesawSessionRow {
  id: string
  name: string
  kind: string
  talker: string
  cli: string
  updatedAt: number
  summary: string
  /** 状态灯：busy 红／todo 黄／idle 绿，'' 不亮（与 weSaw 会话行同口径） */
  agent?: '' | 'busy' | 'todo' | 'idle'
}
interface WesawListPage {
  sessions: WesawSessionRow[]
  total: number
  hasMore: boolean
  counts: {
    all: number
    contacts: number
    groups: number
    official: number
    wechat: number
    wecom: number
    normal: number
    folded: number
    subscription: number
    service: number
  }
}
interface WesawTranscriptPage {
  exists: boolean
  messages: TranscriptMessage[]
  cli?: string
}
/** 对话框与正文同源（weSaw 绑定的同一份 CodeBuddy 会话），这里只回 busy */
interface WesawChatPage {
  turns: unknown[]
  busy: boolean
}

const PAGE = 300
/** 侧栏分类，与 weSaw 会话列表一致 */
type Category = '联系人' | '群聊' | '公众号'
type Sub = 'wechat' | 'wecom' | 'normal' | 'folded' | 'subscription' | 'service'
const CATEGORIES: Category[] = ['联系人', '群聊', '公众号']
/** 二级分类：联系人分微信/企业微信，群聊分群聊/折叠，公众号分订阅号/服务号 */
const SUBS: Record<Category, Array<{ key: Sub; label: string }>> = {
  联系人: [
    { key: 'wechat', label: '微信' },
    { key: 'wecom', label: '企业微信' },
  ],
  群聊: [
    { key: 'normal', label: '群聊' },
    { key: 'folded', label: '折叠的群聊' },
  ],
  公众号: [
    { key: 'subscription', label: '订阅号' },
    { key: 'service', label: '服务号' },
  ],
}
const message = useMessage()
/** 状态灯文案，与 weSaw 的 title 一致 */
const AGENT_DOT_TITLE: Record<string, string> = {
  busy: 'Agent 正在工作',
  todo: '有未完成待办',
  idle: 'Agent 已配置，待机中',
}
const speech = useSpeechStore()
const ui = useUiStore()

const rows = ref<WesawSessionRow[]>([])
const total = ref(0)
const counts = ref({
  all: 0,
  contacts: 0,
  groups: 0,
  official: 0,
  wechat: 0,
  wecom: 0,
  normal: 0,
  folded: 0,
  subscription: 0,
  service: 0,
})
const category = ref<Category>('联系人')
const sub = ref<Sub>('wechat')

const subTabs = computed(() => SUBS[category.value])
const loading = ref(true)
const selected = ref<string | null>(null)
const q = ref('')

const msgs = ref<TranscriptMessage[]>([])
/** 正文实际读的那一路引擎（老绑定工作区也可能是 codebuddy） */
const agentCli = ref('')
const msgLoading = ref(false)
const scroller = ref<HTMLElement | null>(null)

// ---- 对话框（照 weSaw 的输入区；消息走正文同一份会话，这里只留本地回显）----
const chatBusy = ref(false)
const pending = ref('')
const draft = ref('')
const sending = ref(false)

// ---- 自动跟进开关（与 weSaw 对话栏同一份状态：服务端转 6131，由 weSaw 写盘）----
const autowakeEnabled = ref(true)
const autowakeLoading = ref(false)
const autowakeError = ref('')

/** 正文（与 weSaw 对话栏同源）＋ 刚发出、还没写进会话文件的那一句 */
const allMsgs = computed<TranscriptMessage[]>(() => {
  const list = [...msgs.value]
  const echo = pending.value.trim()
  if (echo && !msgs.value.some((m) => m.role === 'user' && partText(m).trim() === echo)) {
    list.push({
      role: 'user',
      parts: [{ kind: 'text', text: echo }],
      timestamp: null,
    } as unknown as TranscriptMessage)
  }
  return list
})

const current = computed(() => rows.value.find((r) => r.id === selected.value) ?? null)
const hasMore = computed(() => rows.value.length < total.value)
const countOf = (c: Category) =>
  c === '联系人' ? counts.value.contacts : c === '群聊' ? counts.value.groups : counts.value.official
const countOfSub = (k: Sub) => counts.value[k]

// weSaw 原生会话列表的时间显示：今天时分、昨天、一周内星期、更早日期
function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((today - day) / 86_400_000)
  if (diff <= 0) return `${p(d.getHours())}:${p(d.getMinutes())}`
  if (diff === 1) return '昨天'
  if (diff < 7) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const initial = (name: string) => (name || '?').trim().charAt(0)

/** 头像走服务端按需缓存（weSaw 启动缓存里的 qlogo 直链 → 128px 本地 jpg）；没有就退回首字 */
const avatarUrl = (r: WesawSessionRow) => `/api/wesaw/avatar/${encodeURIComponent(r.id)}`
const noAvatar = reactive(new Set<string>())
function avatarFailed(r: WesawSessionRow): void {
  noAvatar.add(r.talker)
}

async function load() {
  loading.value = true
  try {
    const kw = q.value.trim()
    const page = await api.get<WesawListPage>(
      `/api/wesaw/sessions?limit=${PAGE}&offset=0&kind=${encodeURIComponent(category.value)}&sub=${sub.value}${
        kw ? `&q=${encodeURIComponent(kw)}` : ''
      }`
    )
    rows.value = page.sessions
    total.value = page.total
    counts.value = page.counts
    // 原选中不在本列（换分类/搜索）就换人；手机单栏停在列表，桌面展开第一条
    const keep = selected.value && rows.value.some((r) => r.id === selected.value)
    if (!keep) {
      selected.value = null
      msgs.value = []
      if (rows.value.length && !ui.isMobile) void openSession(rows.value[0].id)
    }
  } catch (err) {
    message.error(`加载 weSaw 会话失败：${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

const msgSig = ref('')

const sigOf = (list: TranscriptMessage[]): string =>
  list.map((m) => `${m.role}:${partText(m)}`).join('\u0001')

const partText = (m: TranscriptMessage): string =>
  (m.parts ?? []).map((p) => ('text' in p ? p.text : '')).join('')

async function openSession(id: string) {
  selected.value = id
  msgs.value = []
  pending.value = ''
  agentCli.value = ''
  msgSig.value = ''
  msgLoading.value = true
  autowakeError.value = ''
  void loadAutowake(id)
  void loadChat()
  try {
    const page = await api.get<WesawTranscriptPage>(`/api/wesaw/sessions/${encodeURIComponent(id)}/transcript`)
    msgs.value = page.exists ? page.messages : []
    msgSig.value = sigOf(msgs.value)
    agentCli.value = page.cli ?? ''
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  } catch (err) {
    message.error(`加载对话失败：${(err as Error).message}`)
  } finally {
    msgLoading.value = false
  }
}

/**
 * 正文跟读：会话文件在 agent 跑动时逐条追加，weSaw 靠 IPC 推送，
 * 这里按周期重读；用户上翻看旧消息时不抢滚动位置。
 */
async function refreshTranscript(): Promise<void> {
  const id = selected.value
  if (!id) return
  try {
    const page = await api.get<WesawTranscriptPage>(`/api/wesaw/sessions/${encodeURIComponent(id)}/transcript`)
    if (selected.value !== id) return
    const next = page.exists ? page.messages : []
    const sig = sigOf(next)
    if (sig === msgSig.value) return
    const el = scroller.value
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
    msgSig.value = sig
    msgs.value = next
    agentCli.value = page.cli ?? ''
    if (atBottom) await scrollToEnd()
  } catch {
    // 轮询失败保持当前显示，不打断阅读
  }
}

async function loadChat(): Promise<void> {
  const id = selected.value
  if (!id) return
  try {
    const page = await api.get<WesawChatPage>(`/api/wesaw/sessions/${encodeURIComponent(id)}/chat`)
    if (selected.value !== id) return
    chatBusy.value = page.busy
    // 本地回显一旦进了正文就撤掉，避免同一句出现两次
    if (pending.value && msgs.value.some((m) => m.role === 'user' && partText(m).trim() === pending.value.trim())) {
      pending.value = ''
    }
  } catch {
    // 对话框读取失败不挡历史显示
  }
}

async function scrollToEnd(): Promise<void> {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

/** 「自动跟进」现状：weSaw 的开关清单是 SoT，照着显示，不在前端另存状态 */
async function loadAutowake(id: string): Promise<void> {
  autowakeLoading.value = true
  try {
    const res = await api.get<{ enabled: boolean }>(
      `/api/wesaw/sessions/${encodeURIComponent(id)}/autowake`
    )
    if (selected.value === id) autowakeEnabled.value = res.enabled
  } catch (err) {
    if (selected.value === id) autowakeError.value = (err as Error).message
  } finally {
    if (selected.value === id) autowakeLoading.value = false
  }
}

async function toggleAutowake(): Promise<void> {
  const id = selected.value
  if (!id || autowakeLoading.value) return
  const next = !autowakeEnabled.value
  autowakeLoading.value = true
  autowakeError.value = ''
  try {
    const res = await api.post<{ enabled: boolean }>(
      `/api/wesaw/sessions/${encodeURIComponent(id)}/autowake`,
      { enabled: next }
    )
    if (selected.value === id) autowakeEnabled.value = res.enabled
  } catch (err) {
    if (selected.value === id) autowakeError.value = `切换失败：${(err as Error).message}`
  } finally {
    if (selected.value === id) autowakeLoading.value = false
  }
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  const id = selected.value
  if (!text || !id || sending.value || chatBusy.value) return
  sending.value = true
  try {
    const page = await api.post<WesawChatPage>(`/api/wesaw/sessions/${encodeURIComponent(id)}/message`, { text })
    draft.value = ''
    pending.value = text
    chatBusy.value = page.busy
    await scrollToEnd()
  } catch (err) {
    message.error(`发送失败：${(err as Error).message}`)
  } finally {
    sending.value = false
  }
}

function onComposerKey(e: KeyboardEvent): void {
  // Enter 发送、Shift+Enter 换行；输入法组词中的 Enter 不发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

/** 手机返回列表；桌面清空选中（回落到空态） */
function back() {
  selected.value = null
  msgs.value = []
  pending.value = ''
  msgSig.value = ''
}

onMounted(() => void load())

// 搜索走后端（会话几千条，只拉当前这屏）
let typing: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (typing) clearTimeout(typing)
  typing = setTimeout(() => void load(), 250)
})

// 换大类时二级分类回到该类的第一项，由 sub 的 watcher 触发一次加载
watch(category, () => {
  sub.value = SUBS[category.value][0].key
})
watch(sub, () => void load())

// 播报只服务当前这一屏：换会话或离开本页即停
watch(selected, () => speech.stop())
onUnmounted(() => speech.stop())

// 驻留时轮询正文与对话框（agent 跑完不回推，按周期刷新追）
let msgTimer: ReturnType<typeof setInterval> | null = null
let chatTimer: ReturnType<typeof setInterval> | null = null
watch(selected, (id) => {
  if (msgTimer) clearInterval(msgTimer)
  if (chatTimer) clearInterval(chatTimer)
  msgTimer = null
  chatTimer = null
  if (!id) return
  msgTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshTranscript()
  }, 2500)
  chatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void loadChat()
  }, 2000)
})

// 切回窗口立刻补拉一次（隐藏期间不轮询）
function onVisible(): void {
  if (document.visibilityState !== 'visible' || !selected.value) return
  void refreshTranscript()
  void loadChat()
}
document.addEventListener('visibilitychange', onVisible)
window.addEventListener('focus', onVisible)

onUnmounted(() => {
  if (msgTimer) clearInterval(msgTimer)
  if (chatTimer) clearInterval(chatTimer)
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onVisible)
})
</script>

<template>
  <div class="wesaw" :class="{ 'has-selection': !!selected }">
    <aside class="sidebar">
      <div class="sb-head">
        <div class="sb-title-row">
          <h2>weSaw</h2>
          <span class="sb-count">{{ total }} 个会话</span>
        </div>
        <div class="sb-search">
          <input v-model="q" type="search" placeholder="搜索会话" spellcheck="false" />
        </div>
      </div>

      <div class="sb-tabs" role="tablist">
        <button
          v-for="c in CATEGORIES"
          :key="c"
          type="button"
          role="tab"
          :aria-selected="category === c"
          :class="{ active: category === c }"
          @click="category = c"
        >
          {{ c }}<span class="sb-tab-count">{{ countOf(c) }}</span>
        </button>
      </div>

      <div class="sb-tabs sub" role="tablist">
        <button
          v-for="t in subTabs"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="sub === t.key"
          :class="{ active: sub === t.key }"
          @click="sub = t.key"
        >
          {{ t.label }}<span class="sb-tab-count">{{ countOfSub(t.key) }}</span>
        </button>
      </div>

      <NSpin v-if="loading" size="small" class="sb-spin" />
      <div v-else class="sb-list">
        <button
          v-for="r in rows"
          :key="r.id"
          type="button"
          class="session-item"
          :class="{ active: r.id === selected }"
          :title="r.talker"
          @click="openSession(r.id)"
        >
          <span class="session-active-mark" aria-hidden />
          <span class="session-avatar">
            {{ initial(r.name) }}
            <img
              v-if="!noAvatar.has(r.talker)"
              :src="avatarUrl(r)"
              alt=""
              loading="lazy"
              decoding="async"
              @error="avatarFailed(r)"
            />
          </span>
          <span class="session-body">
            <span class="session-top">
              <span class="session-name">{{ r.name }}</span>
              <span v-if="r.updatedAt" class="session-time">{{ fmtTime(r.updatedAt) }}</span>
            </span>
            <span v-if="r.summary" class="session-summary">{{ r.summary }}</span>
          </span>
          <span
            v-if="r.agent"
            class="session-agent-dot"
            :class="r.agent"
            :title="AGENT_DOT_TITLE[r.agent]"
            aria-hidden
          />
        </button>
        <div v-if="hasMore" class="sb-more">仅显示最近 {{ rows.length }} / {{ total }}，可搜索</div>
        <NEmpty v-if="!rows.length" size="small" description="没有匹配的会话" class="sb-empty" />
      </div>
    </aside>

    <section class="pane">
      <header class="pane-head">
        <button type="button" class="pane-back" aria-label="返回列表" @click="back">‹</button>
        <div class="pane-titles">
          <span class="pane-name">{{ current?.name || 'weSaw' }}</span>
          <span v-if="current" class="pane-sub">{{ current.kind }}</span>
        </div>
      </header>

      <NSpin v-if="msgLoading && !allMsgs.length" class="pane-empty" />
      <NEmpty
        v-else-if="!allMsgs.length && !chatBusy"
        description="这个会话还没有 agent 记录"
        class="pane-empty"
      />
      <div v-else ref="scroller" class="msgs">
        <div v-for="(m, i) in allMsgs" :key="i" class="msg-wrap">
          <ChatMessage :message="m" :agent-label="agentCli || current?.cli || 'weSaw'" speakable :session-id="`wesaw:${selected}`" />
        </div>
        <div v-if="chatBusy" class="pane-typing">agent 正在处理…</div>
      </div>

      <div v-if="current" class="composer">
        <textarea
          v-model="draft"
          class="composer-input"
          rows="2"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          spellcheck="false"
          @keydown="onComposerKey"
        />
        <div class="composer-actions">
          <button
            type="button"
            class="composer-autowake"
            :class="{ on: autowakeEnabled }"
            :disabled="autowakeLoading"
            :title="
              autowakeError ||
              (autowakeEnabled ? '关闭当前会话的自动跟进分闸' : '开启当前会话的自动跟进分闸')
            "
            @click="void toggleAutowake()"
          >
            {{ autowakeLoading ? '保存中…' : autowakeEnabled ? '✓ 自动跟进' : '✗ 已停止' }}
          </button>
          <button
            type="button"
            class="composer-send"
            :disabled="sending || chatBusy || !draft.trim()"
            @click="void send()"
          >
            {{ chatBusy ? '处理中' : sending ? '发送中…' : '发送' }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wesaw {
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  display: flex;
  overflow: hidden;
  background: var(--bg);
}

/* ---- 左：会话列表（与 weSaw 现版会话行同尺寸同节奏）---- */

.sidebar {
  width: 300px;
  max-width: 100%;
  flex: 0 0 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--panel);
}

.sb-head {
  flex: 0 0 auto;
  min-width: 0;
  padding: 12px 10px 10px;
  border-bottom: 1px solid var(--border);
}

.sb-title-row {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 2px 10px;
}

.sb-title-row h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}

.sb-count {
  font-size: 12px;
  color: var(--faint);
}

.sb-search input {
  box-sizing: border-box;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  color: var(--text);
  font: 14px/20px inherit;
  outline: none;
  -webkit-appearance: none;
}

.sb-search input::placeholder {
  color: var(--faint);
}

.sb-search input:focus {
  border-color: var(--accent);
}

.sb-tabs {
  box-sizing: border-box;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 6px 10px 8px;
  border-bottom: 1px solid var(--border);
}

.sb-tabs button {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  padding: 4px 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font: 600 13px/19px inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.sb-tabs button:hover {
  color: var(--text);
}

.sb-tabs button.active {
  background: var(--chip-bg);
  color: var(--text);
}

.sb-tab-count {
  margin-left: 4px;
  color: var(--faint);
  font-size: 12px;
  font-weight: 500;
}

.sb-tabs.sub {
  /* 与主行同样的上下节奏：两行等高、各自带分隔线、不挤在一起 */
  padding: 6px 10px 8px;
  justify-content: center;
}

.sb-tabs.sub button {
  flex: 0 0 auto;
  padding: 4px 14px;
}

.sb-list {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px 8px 12px;
  overscroll-behavior: contain;
}

.session-item {
  box-sizing: border-box;
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 13px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.session-item:hover {
  background: var(--chip-bg);
}

.session-item.active {
  background: var(--chip-bg);
}

.session-active-mark {
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 3px;
  border-radius: 0 999px 999px 0;
  background: transparent;
}

.session-item.active .session-active-mark {
  background: var(--accent);
}

.session-avatar {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  background: var(--chip-bg);
  color: var(--accent);
  font-size: 15px;
  font-weight: 700;
}

.session-avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: var(--chip-bg);
}

.session-body {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.session-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.session-name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-time {
  flex-shrink: 0;
  color: var(--faint);
  font-size: 12px;
  line-height: 16px;
}

.session-summary {
  overflow: hidden;
  color: var(--muted);
  font-size: 13px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 会话行状态灯（照 weSaw：待机绿 / 工作红 / 有待办黄，8px 带 3px 光晕） */
.session-agent-dot {
  flex: 0 0 auto;
  align-self: center;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.session-agent-dot.idle {
  background: #22c55e;
  box-shadow: 0 0 0 3px #22c55e22;
}

.session-agent-dot.busy {
  background: #ef4444;
  box-shadow: 0 0 0 3px #ef444422;
}

.session-agent-dot.todo {
  background: #eab308;
  box-shadow: 0 0 0 3px #eab30822;
}

.sb-more,
.sb-empty {
  padding: 10px 8px;
  font-size: 12px;
  color: var(--faint);
}

.sb-spin {
  margin: 40px auto;
}

/* ---- 右：agent 对话 ---- */

.pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.pane-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bar);
}

.pane-back {
  display: none;
  border: 0;
  background: none;
  color: var(--text);
  font-size: 24px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}

.pane-titles {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.pane-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pane-sub {
  font-size: 12px;
  color: var(--faint);
}

.pane-empty {
  margin-top: 60px;
}

.msgs {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  overscroll-behavior: contain;
}

.msg-wrap {
  min-width: 0;
  max-width: 100%;
  border-radius: 10px;
}

.pane-typing {
  padding: 6px 16px 12px;
  color: var(--faint);
  font-size: 12px;
}

/* ---- 对话框：照 weSaw 的输入区（圆角输入框 + 右侧发送）---- */

.composer {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.composer-input {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  min-height: 44px;
  max-height: 160px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  font: 14px/20px inherit;
  resize: none;
  outline: none;
  -webkit-appearance: none;
}

.composer-input:focus {
  border-color: var(--accent);
}

.composer-input::placeholder {
  color: var(--faint);
}

/* 发送按钮一列：「自动跟进」在发送正上方，两者同宽 */
.composer-actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.composer-actions .composer-send {
  width: 100%;
}

.composer-autowake {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--chip-bg);
  color: var(--faint);
  font: 600 12px/26px inherit;
  white-space: nowrap;
  cursor: pointer;
}

.composer-autowake.on {
  border-color: #28a745;
  background: #eaf6ec;
  color: #1a7f37;
}

.composer-autowake:disabled {
  cursor: default;
  opacity: 0.6;
}

.composer-send {
  flex: 0 0 auto;
  height: 44px;
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font: 600 14px/44px inherit;
  cursor: pointer;
}

.composer-send:disabled {
  background: var(--chip-bg);
  color: var(--faint);
  cursor: default;
}

/* ---- 手机单栏：列表 / 对话二选一，点进去看 ---- */

@media (max-width: 768px) {
  /* 手机上输入框不到 16px，iOS 聚焦会放大整页且回不去，故固定 16px */
  .sb-search input,
  .composer-input {
    font-size: 16px;
  }

  .sb-tabs button,
  .session-item,
  .pane-back {
    touch-action: manipulation;
  }

  .sidebar {
    width: 100%;
    max-width: 100%;
    flex: 1 1 100%;
    min-width: 0;
    border-right: 0;
  }

  .pane {
    display: none;
  }

  .wesaw.has-selection .sidebar {
    display: none;
  }

  .wesaw.has-selection .pane {
    display: flex;
    flex: 1 1 auto;
  }

  .pane-back {
    display: block;
  }
}
</style>
