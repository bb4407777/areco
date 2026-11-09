<script setup lang="ts">
// OPC 后台页（2026-11-08 改版）：与「会话」「历史」同构——左侧列表、右侧详情。
// 数据源全在服务端 services/opc.ts（只读 ~/skills/opc 与 ~/.hermes/kanban/logs）；
// 这里只展示与按需拉单张工单的日志尾部，不提供任何写操作。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import ChatMessage from '../components/ChatMessage.vue'
import { api } from '../api'
import { useUiStore } from '../stores/ui'
import type {
  OpcPastSession,
  OpcRun,
  OpcSessionRow,
  OpcSessionSendResult,
  OpcSnapshot,
  OpcTaskLog,
  OpcTaskRow,
  OpcTrackRow,
  TranscriptMessage,
} from '../../../shared/protocol'

const message = useMessage()
const ui = useUiStore()
const router = useRouter()

const snap = ref<OpcSnapshot | null>(null)
const auto = ref(true)
const q = ref('')
const selectedId = ref<string | null>(null)
const log = ref<OpcTaskLog | null>(null)
const logLoading = ref(false)
const logError = ref('')
/** 常驻会话的对话记录（选中常驻会话时加载，展示尾部消息） */
const transcript = ref<TranscriptMessage[] | null>(null)
const transcriptLoading = ref(false)
const transcriptError = ref('')
/** 对话输入（按岗存草稿，切走再回来不丢） */
const draft = ref('')
const drafts: Record<string, string> = {}
const sending = ref(false)
/** 刚发出、还没进会话记录的那一句（界面上先占一行，跑完被真实消息替换）。
 * 按岗存：切到别的岗不会把它带过去（2026-11-08 高律师「这个发送串了」） */
const pendingByDept = ref<Record<string, string>>({})
const pendingText = computed(() => {
  const dept = selectedSession.value?.dept
  return dept ? pendingByDept.value[dept] ?? '' : ''
})
function setPending(dept: string, text: string): void {
  pendingByDept.value = { ...pendingByDept.value, [dept]: text }
}
const chatEl = ref<HTMLElement | null>(null)
/** 对话固定停在最新消息：在底部附近才跟随，手动往上翻就不抢滚动条 */
const stickBottom = ref(true)
let timer: ReturnType<typeof setInterval> | undefined

/** 常驻会话在列表里的选中 id 前缀，与工单 id 分开 */
const SESS_PREFIX = 'sess:'

const STATUS_TEXT: Record<string, string> = {
  ready: '待派',
  claimed: '认领',
  running: '在跑',
  in_progress: '在跑',
  blocked: '阻断',
}

/** 本地日历日（台账 ts 是本地时间 "YYYY-MM-DDTHH:mm:ss"，按前缀取当天） */
function localDay(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const kw = computed(() => q.value.trim().toLowerCase())
function hit(text: string): boolean {
  return !kw.value || text.toLowerCase().includes(kw.value)
}

/** 今日跑单（台账本地日前缀），最新在前 */
const todayRuns = computed<OpcRun[]>(() => {
  const day = localDay()
  return (snap.value?.runs ?? []).filter((r) => r.ts.startsWith(day))
})

/** 在办工单 */
const activeTasks = computed<OpcTaskRow[]>(() =>
  (snap.value?.tasks ?? []).filter((r) => hit(`${r.title}\n${r.assignee}\n${r.id}`))
)

/** 常驻会话岗（服务端按 depts.json 的 standing_session 汇总） */
const sessions = computed<OpcSessionRow[]>(() =>
  (snap.value?.sessions ?? []).filter((s) => hit(`${s.name}\n${s.dept}\n${s.lastRunAt ?? ''}`))
)

const selectedSession = computed<OpcSessionRow | null>(() => {
  const id = selectedId.value
  if (!id?.startsWith(SESS_PREFIX)) return null
  const dept = id.slice(SESS_PREFIX.length)
  return (snap.value?.sessions ?? []).find((s) => s.dept === dept) ?? null
})

/** 工人每轮收到的整段提示词：只留高律师自己那句话，别把模板和召回当消息读 */
const CHAT_MARK = '〔常驻会话对话〕'
const CHAT_MARK_SHORT = '〔OPC 对话〕'
function userTextOf(raw: string): string {
  let s = raw
  const i = s.indexOf(CHAT_MARK)
  const j = s.indexOf(CHAT_MARK_SHORT)
  if (i >= 0) s = s.slice(i + CHAT_MARK.length)
  else if (j >= 0) s = s.slice(j + CHAT_MARK_SHORT.length)
  else {
    const k = s.indexOf('—— 任务正文 ——')
    if (k >= 0) s = s.slice(k + '—— 任务正文 ——'.length)
  }
  for (const cut of ['\n## 自动召回', '\n〔principal_only', '\n〔完工闸', '\n—— 运行时附录',
    '\n—— 原任务正文', '\n—— 本单是常驻会话对话']) {
    const k = s.indexOf(cut)
    if (k >= 0) s = s.slice(0, k)
  }
  s = s.replace(/^高律师在 OPC 页面直接发来的一句话[^\n]*\n*/, '')
  return s.trim()
}

/** 对话记录只留能读的：指令行（剥掉派单模板）与有正文的回复；纯工具/思考轮不占位 */
const transcriptView = computed<TranscriptMessage[]>(() => {
  const out: TranscriptMessage[] = []
  for (const m of transcript.value ?? []) {
    if (m.role === 'user') {
      const text = userTextOf(msgTextOf(m))
      if (!text) continue
      out.push({ ...m, parts: [{ kind: 'text', text }] })
    } else if (m.parts.some((p) => p.kind === 'text' || p.kind === 'notice')) {
      out.push(m)
    }
  }
  return out
})

/** 详情只展示会话尾部，完整对话点进历史页 */
const transcriptTail = computed<TranscriptMessage[]>(() => transcriptView.value.slice(-30))

/** 今日跑单按 taskId 去重（同一单重跑只留最后一次） */
function uniqRuns(rows: OpcRun[]): OpcRun[] {
  const seen = new Set<string>()
  const out: OpcRun[] = []
  for (const r of rows) {
    if (seen.has(r.taskId)) continue
    seen.add(r.taskId)
    out.push(r)
  }
  return out
}

/** 已完成：排除仍在在办列表里的同一单（在跑的会有上次败绩记录） */
const doneRuns = computed<OpcRun[]>(() => {
  const busy = new Set(activeTasks.value.map((t) => t.id))
  return uniqRuns(
    todayRuns.value.filter((r) => r.ok && !busy.has(r.taskId) && hit(`${r.title}\n${r.dept}\n${r.track}\n${r.taskId}`))
  ).slice(0, 80)
})

const failedRuns = computed<OpcRun[]>(() => {
  const busy = new Set(activeTasks.value.map((t) => t.id))
  return uniqRuns(
    todayRuns.value.filter((r) => !r.ok && !busy.has(r.taskId) && hit(`${r.title}\n${r.dept}\n${r.track}\n${r.taskId}`))
  ).slice(0, 40)
})

const activeCount = computed(
  () => (snap.value?.counts.ready ?? 0) + (snap.value?.counts.claimed ?? 0) + (snap.value?.counts.running ?? 0) + (snap.value?.counts.in_progress ?? 0)
)

const updatedAt = computed(() =>
  snap.value ? new Date(snap.value.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
)

/** 选中项：先找在办工单，再找跑单 */
const selectedTask = computed<OpcTaskRow | null>(() => (snap.value?.tasks ?? []).find((t) => t.id === selectedId.value) ?? null)
const selectedRun = computed<OpcRun | null>(() => (snap.value?.runs ?? []).find((r) => r.taskId === selectedId.value) ?? null)
const detailTitle = computed(
  () => selectedSession.value?.name || selectedTask.value?.title || selectedRun.value?.title || selectedId.value || ''
)

function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDay(s: string): string {
  const t = Date.parse(s)
  if (!t) return ''
  const d = new Date(t)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDur(sec: number): string {
  if (!sec) return '—'
  if (sec < 60) return `${sec.toFixed(0)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`
  return `${(sec / 3600).toFixed(1)}h`
}

function trackState(t: OpcTrackRow): string {
  if (t.status === 'closed') {
    const left = Math.max(0, Math.round(t.cooldownUntil - Date.now() / 1000))
    return `未到放行点 ${fmtDur(left)}`
  }
  if (t.status === 'cooldown') {
    const left = Math.max(0, Math.round(t.cooldownUntil - Date.now() / 1000))
    return `冷却 ${fmtDur(left)}`
  }
  if (t.status === 'missing') return '未探测'
  return '正常'
}

async function refresh(): Promise<void> {
  try {
    snap.value = await api.get<OpcSnapshot>('/api/opc')
    if (snap.value.warning) message.warning(snap.value.warning)
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function loadLog(id: string): Promise<void> {
  log.value = null
  logError.value = ''
  logLoading.value = true
  try {
    log.value = await api.get<OpcTaskLog>(`/api/opc/tasks/${id}/log`)
  } catch (e) {
    logError.value = (e as Error).message
  } finally {
    logLoading.value = false
  }
}

/** 会话段（换轨／满轮会换会话）：旧段在前、当前段在后，按时间合并成一条记录 */
interface SegRef {
  id: string
  source: string
  project: string
}

function segmentsOf(s: OpcSessionRow): SegRef[] {
  const segs: SegRef[] = []
  for (const p of s.past ?? []) {
    if (p.sessionId && p.sessionSource && p.sessionProject) {
      segs.push({ id: p.sessionId, source: p.sessionSource, project: p.sessionProject })
    }
  }
  if (s.sessionId && s.sessionSource && s.sessionProject) {
    segs.push({ id: s.sessionId, source: s.sessionSource, project: s.sessionProject })
  }
  return segs
}

async function fetchSegment(seg: SegRef): Promise<TranscriptMessage[]> {
  try {
    const page = await api.get<{ messages: TranscriptMessage[] }>(
      `/api/history/${seg.source}/${seg.project}/${seg.id}/transcript`
    )
    return page.messages ?? []
  } catch {
    return []
  }
}

/** 常驻会话的对话记录：历史各段＋当前段合并（换过轨也不再只剩最后一轮） */
async function loadTranscript(s: OpcSessionRow | null): Promise<void> {
  if (!s) {
    transcript.value = null
    transcriptError.value = ''
    return
  }
  const segs = segmentsOf(s)
  if (!s.sessionId) {
    transcript.value = null
    transcriptError.value = '还没有会话记录（该岗第一次接单时开新会话）'
    return
  }
  if (!segs.length) {
    transcript.value = null
    transcriptError.value = '会话文件未落盘（可能已被清理）'
    return
  }
  // 续轮刷新时保留已载入的消息，避免整块清空后跳一下
  if (!transcript.value) transcriptLoading.value = true
  transcriptError.value = ''
  try {
    const pages = await Promise.all(segs.map(fetchSegment))
    const merged: TranscriptMessage[] = []
    pages.forEach((msgs, si) => msgs.forEach((m, mi) => merged.push(m)))
    const key = (m: TranscriptMessage): number => (m.timestamp ? Date.parse(m.timestamp) : NaN)
    // 有时间戳的按时间排；无时间戳的保持原段序（稳定排序靠下标兜底）
    const idx = new Map(merged.map((m, i) => [m, i] as const))
    transcript.value = merged.slice().sort((a, b) => {
      const ta = key(a)
      const tb = key(b)
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
      return (idx.get(a) ?? 0) - (idx.get(b) ?? 0)
    })
    // 刚发出的那句已经进了会话记录 → 撤掉占位行
    if (pendingByDept.value[s.dept] && transcript.value.some(
      (m) => m.role === 'user' && msgTextOf(m).includes(pendingByDept.value[s.dept]))) {
      setPending(s.dept, '')
    }
    scrollToLatestIfStick()
  } catch (e) {
    transcriptError.value = (e as Error).message
  } finally {
    transcriptLoading.value = false
  }
}

/** 滚到最新一条；等两帧让消息（代码块/表格）排完版再定位，否则停在半截 */
async function scrollToLatest(force = false): Promise<void> {
  if (!force && !stickBottom.value) return
  await nextTick()
  const jump = (): void => {
    const el = chatEl.value
    if (el) el.scrollTop = el.scrollHeight
  }
  jump()
  requestAnimationFrame(() => {
    jump()
    requestAnimationFrame(jump)
  })
}

function scrollToLatestIfStick(): void {
  void scrollToLatest()
}

/** 手动上翻即脱离跟随，回到底部附近再重新跟随 */
function onChatScroll(): void {
  const el = chatEl.value
  if (!el) return
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function msgTextOf(m: TranscriptMessage): string {
  return m.parts.flatMap((p) => (p.kind === 'text' || p.kind === 'notice' ? [p.text] : [])).join('\n')
}

function draftOf(dept: string): string {
  return drafts[dept] ?? ''
}

watch(draft, (v) => {
  const s = selectedSession.value
  if (s) drafts[s.dept] = v
})

function selectSession(dept: string): void {
  const id = `${SESS_PREFIX}${dept}`
  if (selectedId.value !== id) selectedId.value = id
  draft.value = draftOf(dept)
  stickBottom.value = true
  void loadTranscript(selectedSession.value)
}

/** 发一句话：入看板派给该岗，worker 用同一条常驻会话续聊（与 areco 对话栏同一套手感） */
async function sendMessage(): Promise<void> {
  const s = selectedSession.value
  const text = draft.value.trim()
  if (!s || !text || sending.value) return
  sending.value = true
  try {
    const res = await api.post<OpcSessionSendResult>(`/api/opc/sessions/${s.dept}/message`, { text })
    draft.value = ''
    setPending(s.dept, text)
    stickBottom.value = true
    void scrollToLatest(true)
    message.success(res.taskId ? `已派给${s.name}（${res.taskId}），跑完自动刷新` : `已派给${s.name}`)
    await refresh()
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    sending.value = false
  }
}

/** 首行取标题：与 PromptBar 的「Enter 发送、Shift+Enter 换行」一致 */
function onComposerKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendMessage()
  }
}

/** textarea 自增高（同 PromptBar 手感，封顶 160px 后内部滚动） */
const composerEl = ref<HTMLTextAreaElement | null>(null)
function autoGrow(): void {
  const el = composerEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}
watch(draft, () => nextTick(autoGrow))

function openSessionRow(s: OpcSessionRow): void {
  if (!s.sessionId || !s.sessionSource || !s.sessionProject) return
  router.push({
    path: `/history/${s.sessionSource}/${s.sessionProject}/${s.sessionId}`,
    query: { title: s.name || s.dept },
  })
}

/** 上一段会话（换轨／满轮换下来的那段，仍在盘上） */
function openPastSession(p: OpcPastSession): void {
  if (!p.sessionSource || !p.sessionProject) return
  router.push({
    path: `/history/${p.sessionSource}/${p.sessionProject}/${p.sessionId}`,
    query: { title: `${selectedSession.value?.name || ''}（上一段）` },
  })
}

/** 该单的引擎会话在历史页的位置（服务端按 session_id 查落盘文件所得） */
const sessionTarget = computed(() => {
  const r = selectedRun.value
  if (!r?.sessionId || !r.sessionSource || !r.sessionProject) return null
  return r
})

function openSession(): void {
  const r = sessionTarget.value
  if (!r) return
  router.push({
    path: `/history/${r.sessionSource}/${r.sessionProject}/${r.sessionId}`,
    query: { title: r.title || r.taskId },
  })
}

function select(id: string): void {
  if (selectedId.value === id) return
  selectedId.value = id
  transcript.value = null
  transcriptError.value = ''
  void loadLog(id)
}

function back(): void {
  selectedId.value = null
  log.value = null
  logError.value = ''
  transcript.value = null
  transcriptError.value = ''
}

watch(selectedId, (id) => {
  // 自动刷新后选中项消失（单子已完成掉出在办列表）时，留在详情页不弹回
  if (id && !selectedTask.value && !selectedRun.value && snap.value) return
})

// 常驻会话续用了新的一轮（updated 变化）就跟着重载对话尾部；首次点开由 selectSession 自己加载
watch(
  () => selectedSession.value?.updated,
  () => {
    if (selectedSession.value && transcript.value) void loadTranscript(selectedSession.value)
  }
)

// 消息增减（新一轮回复、占位行换成真实消息）都跟到最新一条
watch(
  () => [transcriptTail.value.length, pendingText.value] as const,
  () => scrollToLatestIfStick()
)

function restartTimer(): void {
  if (timer) clearInterval(timer)
  timer = auto.value ? setInterval(() => void refresh(), 10_000) : undefined
}

onMounted(() => {
  void refresh()
  restartTimer()
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="opc" :class="{ mobile: ui.isMobile }">
    <!-- 左栏：工单列表（手机端在未选中时占满，选中后让位给详情） -->
    <aside v-show="!ui.isMobile || !selectedId" class="side">
      <div class="side-head">
        <span class="side-title">OPC 后台</span>
        <span class="counts">
          在办 <b>{{ activeCount }}</b> · 今日 <b>{{ snap?.today?.runs ?? 0 }}</b> 单 · 成
          <b>{{ snap?.today?.ok ?? 0 }}</b>
        </span>
      </div>

      <div class="side-actions">
        <n-input v-model:value="q" size="small" clearable placeholder="搜工单 / 轨 / 岗位" class="search" />
        <n-switch v-model:value="auto" size="small" title="自动刷新" @update:value="restartTimer" />
        <n-button size="small" quaternary @click="refresh">刷新</n-button>
      </div>

      <!-- 手机端：轨道健康放列表顶部，桌面端在右侧空态里 -->
      <div v-if="ui.isMobile" class="side-tracks">
        <span
          v-for="t in snap?.tracks ?? []"
          :key="t.id"
          class="chip"
          :class="t.status"
          :title="`${t.label}\n模型 ${t.model || '账户默认'}\n${trackState(t)}`"
        >
          <span class="chip-name">{{ t.id }}</span>
          <span class="chip-used">{{ t.usedToday }}</span>
        </span>
      </div>

      <div class="side-list">
        <template v-if="snap">
          <div v-if="activeTasks.length" class="group">
            <div class="group-head">在办<span class="group-n">{{ activeTasks.length }}</span></div>
            <button
              v-for="r in activeTasks"
              :key="r.id"
              type="button"
              class="item"
              :class="{ active: selectedId === r.id }"
              @click="select(r.id)"
            >
              <div class="item-top">
                <span class="item-title">{{ r.title || r.id }}</span>
                <span class="item-time">{{ fmtTime(r.createdAt * 1000) }}</span>
              </div>
              <div class="item-meta">
                <span class="tag" :class="r.status">{{ STATUS_TEXT[r.status] ?? r.status }}</span>
                <span class="item-dept">{{ r.assignee }}</span>
                <span v-if="r.failures" class="danger">连败 {{ r.failures }}</span>
                <span v-if="r.hasLog" class="item-act">日志</span>
              </div>
            </button>
          </div>

          <div v-if="sessions.length" class="group">
            <div class="group-head">常驻会话<span class="group-n">{{ sessions.length }}</span></div>
            <button
              v-for="s in sessions"
              :key="s.dept"
              type="button"
              class="item"
              :class="{ active: selectedId === SESS_PREFIX + s.dept }"
              @click="selectSession(s.dept)"
            >
              <div class="item-top">
                <span class="item-title">{{ s.name }}</span>
                <span class="item-time">{{ s.updated ? fmtTime(Date.parse(s.updated)) : '未开始' }}</span>
              </div>
              <div class="item-meta">
                <span class="tag" :class="s.runningTaskId ? 'running' : 'ok'">{{ s.runningTaskId ? '在跑' : '常驻' }}</span>
                <span class="item-dept">{{ s.dept }}</span>
                <span>第 {{ s.rounds }} 轮</span>
                <span v-if="s.lastRunAt" class="item-track">最近 {{ fmtTime(Date.parse(s.lastRunAt)) }}</span>
              </div>
            </button>
          </div>

          <div v-if="doneRuns.length" class="group">
            <div class="group-head">今日完成<span class="group-n">{{ doneRuns.length }}</span></div>
            <button
              v-for="r in doneRuns"
              :key="r.taskId"
              type="button"
              class="item"
              :class="{ active: selectedId === r.taskId }"
              @click="select(r.taskId)"
            >
              <div class="item-top">
                <span class="item-title">{{ r.title || r.taskId }}</span>
                <span class="item-time">{{ fmtTime(Date.parse(r.ts)) }}</span>
              </div>
              <div class="item-meta">
                <span class="tag ok">成</span>
                <span class="item-dept">{{ r.dept }}</span>
                <span class="item-track">{{ r.track }}</span>
                <span>{{ fmtDur(r.durS) }}</span>
              </div>
            </button>
          </div>

          <div v-if="failedRuns.length" class="group">
            <div class="group-head">今日失败<span class="group-n">{{ failedRuns.length }}</span></div>
            <button
              v-for="r in failedRuns"
              :key="r.taskId"
              type="button"
              class="item"
              :class="{ active: selectedId === r.taskId }"
              @click="select(r.taskId)"
            >
              <div class="item-top">
                <span class="item-title">{{ r.title || r.taskId }}</span>
                <span class="item-time">{{ fmtTime(Date.parse(r.ts)) }}</span>
              </div>
              <div class="item-meta">
                <span class="tag bad">{{ r.errKind || '败' }}</span>
                <span class="item-dept">{{ r.dept }}</span>
                <span class="item-track">{{ r.track }}</span>
              </div>
            </button>
          </div>

          <div v-if="!activeTasks.length && !doneRuns.length && !failedRuns.length" class="empty">
            {{ kw ? '没有匹配的工单' : '今天还没有工单' }}
          </div>
        </template>
        <div v-else class="empty">读取中…</div>
      </div>
    </aside>

    <!-- 右栏：详情（未选中显示轨道健康与今日概览） -->
    <main v-show="!ui.isMobile || selectedId" class="main">
      <template v-if="selectedId">
        <div class="detail-head">
          <button v-if="ui.isMobile" type="button" class="back" @click="back">‹ 返回</button>
          <h2 class="detail-title">{{ detailTitle }}</h2>
          <span v-if="selectedTask" class="tag" :class="selectedTask.status">{{ STATUS_TEXT[selectedTask.status] ?? selectedTask.status }}</span>
          <span v-else-if="selectedRun" class="tag" :class="selectedRun.ok ? 'ok' : 'bad'">{{ selectedRun.ok ? '成' : selectedRun.errKind || '败' }}</span>
          <span v-else-if="selectedSession" class="tag" :class="selectedSession.runningTaskId ? 'running' : 'ok'">
            {{ selectedSession.runningTaskId ? '在跑' : '常驻' }}
          </span>
          <span class="detail-id">{{ selectedSession ? selectedSession.dept : selectedId }}</span>
        </div>

        <!-- 常驻会话：岗位台账 + 对话尾部 -->
        <template v-if="selectedSession">
          <div class="kv">
            <div class="kv-row"><span class="k">岗位</span><span class="v">{{ selectedSession.name }} <span class="muted">{{ selectedSession.dept }}</span></span></div>
            <div class="kv-row"><span class="k">会话</span><span class="v mono">{{ selectedSession.sessionId || '—' }}</span></div>
            <div class="kv-row"><span class="k">轮次</span><span class="v">第 {{ selectedSession.rounds }} 轮</span></div>
            <div class="kv-row"><span class="k">最近</span><span class="v">{{ selectedSession.updated ? fmtTime(Date.parse(selectedSession.updated)) : '—' }}</span></div>
            <div class="kv-row"><span class="k">引擎</span><span class="v mono">{{ selectedSession.engine }}{{ selectedSession.model ? ` · ${selectedSession.model}` : '' }}</span></div>
            <div v-if="selectedSession.runningTaskId" class="kv-row">
              <span class="k">在跑</span><span class="v">{{ selectedSession.runningTitle || selectedSession.runningTaskId }}</span>
            </div>
            <div v-if="selectedSession.queuedTaskId" class="kv-row">
              <span class="k">排队</span><span class="v">{{ selectedSession.queuedTitle || selectedSession.queuedTaskId }}</span>
            </div>
            <div v-if="selectedSession.lastRunAt" class="kv-row">
              <span class="k">最近一单</span>
              <span class="v">{{ fmtTime(Date.parse(selectedSession.lastRunAt)) }} · {{ selectedSession.lastRunOk ? '成' : '败' }}</span>
            </div>
            <div class="kv-row">
              <span class="k">完整对话</span>
              <span class="v">
                <button v-if="selectedSession.sessionSource" type="button" class="link" @click="openSessionRow(selectedSession)">打开对话记录 ›</button>
                <span v-else class="muted">会话文件未落盘</span>
              </span>
            </div>
            <div v-if="selectedSession.past?.length" class="kv-row">
              <span class="k">上一段</span>
              <span class="v past-list">
                <button
                  v-for="p in selectedSession.past"
                  :key="p.sessionId"
                  type="button"
                  class="link"
                  @click="openPastSession(p)"
                >{{ p.engine || '会话' }} · {{ p.rounds }} 轮<template v-if="p.updated"> · {{ fmtDay(p.updated) }}</template> ›</button>
              </span>
            </div>
          </div>

          <div class="log-head">
            <span>对话记录</span>
            <span v-if="transcript" class="log-meta">
              显示 {{ transcriptTail.length }} 条 / 共 {{ transcriptView.length }} 条{{ (selectedSession?.past?.length ?? 0) ? `（含 ${selectedSession?.past?.length} 段历史会话）` : '' }}
            </span>
          </div>
          <div ref="chatEl" class="log-wrap chat-wrap" @scroll.passive="onChatScroll">
            <div v-if="transcriptLoading && !transcriptTail.length" class="empty">读取中…</div>
            <div v-else-if="transcriptTail.length || pendingText" class="chat">
              <ChatMessage v-for="(m, i) in transcriptTail" :key="i" :message="m" />
              <div v-if="pendingText" class="pending">
                <span class="pending-tag">已发出</span>
                <span class="pending-text">{{ pendingText }}</span>
              </div>
            </div>
            <div v-else class="empty">{{ transcriptError || '没有对话记录' }}</div>
          </div>

          <div class="composer">
            <textarea
              ref="composerEl"
              v-model="draft"
              class="composer-input"
              rows="1"
              :placeholder="`对${selectedSession.name}说点什么…（Enter 发送，Shift+Enter 换行）`"
              @keydown="onComposerKeydown"
            />
            <button type="button" class="send" :disabled="sending || !draft.trim()" @click="sendMessage">
              {{ sending ? '发送中…' : '发送' }}
            </button>
          </div>
        </template>

        <template v-else>
        <div class="kv">
          <template v-if="selectedTask">
            <div class="kv-row"><span class="k">岗位</span><span class="v">{{ selectedTask.assignee || '—' }}</span></div>
            <div class="kv-row"><span class="k">状态</span><span class="v">{{ STATUS_TEXT[selectedTask.status] ?? selectedTask.status }}</span></div>
            <div class="kv-row"><span class="k">创建</span><span class="v">{{ fmtTime(selectedTask.createdAt * 1000) }}</span></div>
            <div class="kv-row"><span class="k">开始</span><span class="v">{{ selectedTask.startedAt ? fmtTime(selectedTask.startedAt * 1000) : '—' }}</span></div>
            <div class="kv-row"><span class="k">连败</span><span class="v" :class="{ danger: selectedTask.failures > 0 }">{{ selectedTask.failures }}</span></div>
            <div v-if="selectedTask.workerPid" class="kv-row"><span class="k">进程</span><span class="v mono">{{ selectedTask.workerPid }}</span></div>
            <div v-if="selectedTask.lastError" class="kv-row"><span class="k">上次错误</span><span class="v err">{{ selectedTask.lastError }}</span></div>
          </template>
          <template v-else-if="selectedRun">
            <div class="kv-row"><span class="k">岗位</span><span class="v">{{ selectedRun.dept || '—' }}</span></div>
            <div class="kv-row"><span class="k">轨</span><span class="v mono">{{ selectedRun.track }}</span></div>
            <div class="kv-row"><span class="k">模型</span><span class="v mono">{{ selectedRun.model }}</span></div>
            <div class="kv-row"><span class="k">开始</span><span class="v">{{ fmtTime(Date.parse(selectedRun.ts)) }}</span></div>
            <div class="kv-row"><span class="k">耗时</span><span class="v">{{ fmtDur(selectedRun.durS) }}</span></div>
            <div v-if="selectedRun.err" class="kv-row"><span class="k">错误</span><span class="v err">{{ selectedRun.err }}</span></div>
          </template>
          <div v-if="selectedRun?.sessionId" class="kv-row">
            <span class="k">会话</span>
            <span class="v">
              <button v-if="sessionTarget" type="button" class="link" @click="openSession">打开对话记录 ›</button>
              <span v-else class="muted">会话文件未找到（{{ selectedRun?.sessionId.slice(0, 8) }}…）</span>
            </span>
          </div>
        </div>

        <div class="log-head">
          <span>工人日志</span>
          <span v-if="log" class="log-meta">{{ log.truncated ? '仅尾部' : '全部' }} · {{ log.lines.length }} 行 · {{ log.path }}</span>
        </div>
        <div class="log-wrap">
          <div v-if="logLoading" class="empty">读取中…</div>
          <pre v-else-if="log" class="log-body">{{ log.lines.join('\n') }}</pre>
          <div v-else class="empty">{{ logError || '没有日志' }}</div>
        </div>
        </template>
      </template>

      <!-- 空态：轨道健康 + 今日概览 -->
      <div v-else class="overview">
        <div class="ov-head">
          <h2 class="ov-title">轨道健康</h2>
          <span class="hint">读失败不写冷却；额度/限流才冷却，到期自动恢复</span>
        </div>
        <div class="tracks">
          <div
            v-for="t in snap?.tracks ?? []"
            :key="t.id"
            class="track"
            :class="t.status"
            :title="`模型 ${t.model || '账户默认'}\n${t.status === 'closed' ? '放行点' : '冷却至'} ${t.cooldownUntil ? new Date(t.cooldownUntil * 1000).toLocaleString('zh-CN') : '—'}\n最近错误 ${t.lastError || '无'}`"
          >
            <span class="track-name">{{ t.id }}</span>
            <span class="track-model mono">{{ t.model || '账户默认' }}</span>
            <span class="track-state">{{ trackState(t) }}</span>
            <span class="track-used">今日 {{ t.usedToday }} 单</span>
          </div>
          <div v-if="!snap?.tracks.length" class="empty">轨道表读取中…</div>
        </div>
        <p class="select-hint">← 从左侧选择一张工单，查看详情与工人日志</p>
        <p class="foot">只读视图 · 数据来自 ~/skills/opc 台账与看板 · 更新于 {{ updatedAt }}</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.opc {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.side {
  width: 340px;
  flex: 0 0 auto;
  border-right: 1px solid var(--border);
  background: var(--bar);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.side-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 14px 8px;
  flex-wrap: wrap;
}
.side-title {
  font-size: 16px;
  font-weight: 600;
}
.counts {
  color: var(--muted);
  font-size: 11.5px;
}
.counts b {
  color: var(--text);
}
.side-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px 10px;
}
.search {
  flex: 1;
  min-width: 0;
}
.side-tracks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  padding: 0 12px 8px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 10.5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  min-width: 0;
}
.chip.ok {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}
.chip.cooldown {
  border-color: #e8a33d;
}
.chip.closed,
.chip.missing {
  color: var(--faint);
}
.chip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-used {
  flex: 0 0 auto;
  color: var(--faint);
}
.side-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 16px;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 6px 2px;
  font-size: 11px;
  color: var(--faint);
  letter-spacing: 0.02em;
}
.group-n {
  color: var(--muted);
}
.item {
  text-align: left;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  padding: 7px 9px;
  cursor: pointer;
  color: var(--text);
  font: inherit;
}
.item:hover {
  background: var(--hover);
}
.item.active {
  background: var(--panel);
  border-color: var(--border-strong);
}
.item-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
  min-width: 0;
}
.item-dept {
  flex: 0 0 auto;
}
.item-track {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.item-act {
  margin-left: auto;
  color: var(--accent);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.back {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  border-radius: 8px;
  padding: 3px 9px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.detail-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-id {
  font-size: 11.5px;
  color: var(--faint);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
}
.kv-row {
  display: flex;
  gap: 12px;
  font-size: 12.5px;
  padding: 2px 0;
}
.k {
  flex: 0 0 68px;
  color: var(--faint);
}
.v {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.v.err {
  color: var(--danger);
  font-size: 12px;
}
/* 上一段会话（可能多段，竖排） */
.past-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
}
.link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12.5px;
  color: var(--accent);
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}
.muted {
  color: var(--faint);
}
.log-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 18px 6px;
  font-size: 12.5px;
  color: var(--text);
}
.log-meta {
  color: var(--faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-wrap {
  flex: 1;
  min-height: 0;
  margin: 0 18px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--code-bg, #11151c);
  overflow: auto;
}
.log-body {
  margin: 0;
  padding: 10px 12px;
  color: var(--text);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
/* 常驻会话：对话记录（气泡用 ChatMessage，与对话栏同一套版式） */
.chat-wrap {
  margin-bottom: 8px;
}
.chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}
.pending {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--muted);
}
.pending-tag {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--accent);
}
.pending-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 0 18px 14px;
}
.composer-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  padding: 8px 10px;
  outline: none;
}
.composer-input:focus {
  border-color: var(--accent);
}
.send {
  flex: 0 0 auto;
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.send:disabled {
  border-color: var(--border);
  background: transparent;
  color: var(--faint);
  cursor: not-allowed;
}
.overview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ov-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.ov-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.tracks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 760px;
}
.track {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) 96px 76px;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 7px 11px;
  font-size: 11.5px;
  background: var(--panel);
}
.track.ok {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.track.cooldown {
  border-color: #e8a33d;
}
.track.closed,
.track.missing {
  color: var(--faint);
}
.track-name {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.track-state {
  color: var(--muted);
}
.track-used {
  text-align: right;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.select-hint {
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 12.5px;
}
.foot {
  margin: auto 0 0;
  color: var(--faint);
  font-size: 11.5px;
}
.hint {
  color: var(--faint);
  font-size: 11.5px;
}
.empty {
  padding: 22px;
  text-align: center;
  color: var(--faint);
  font-size: 12.5px;
}
.danger {
  color: var(--danger);
}
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.tag {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  border: 1px solid var(--border-strong);
  color: var(--muted);
}
.tag.running,
.tag.in_progress {
  border-color: var(--accent);
  color: var(--accent);
}
.tag.ready {
  border-color: var(--border-strong);
}
.tag.claimed {
  border-color: #8f86c9;
  color: #8f86c9;
}
.tag.blocked,
.tag.bad {
  border-color: var(--danger);
  color: var(--danger);
}
.tag.ok {
  border-color: var(--accent);
  color: var(--accent);
}

/* 手机端：列表独占一屏，选中后详情独占一屏 */
@media (max-width: 768px) {
  .opc {
    flex-direction: column;
  }
  /* 移动端整页一屏：列表/详情各自占满剩余高度，滚动交给 side-list / log-wrap，
     .side 必须 flex:1 否则高度按内容撑开、超出部分被 .opc 的 overflow:hidden 裁掉（滑不动） */
  .opc.mobile .side {
    width: 100%;
    border-right: none;
    flex: 1 1 auto;
    min-height: 0;
  }
  .opc.mobile .main {
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
  }
  .side-head {
    padding: 10px 12px 6px;
  }
  .side-title {
    font-size: 15px;
  }
  .side-list {
    padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  }
  .item {
    padding: 9px 10px;
    border-color: var(--border);
    background: var(--panel);
    margin-bottom: 2px;
  }
  .detail-head {
    padding: 10px 12px 8px;
    gap: 8px;
  }
  .detail-title {
    font-size: 14px;
    flex: 1 1 100%;
    order: 3;
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .kv {
    padding: 10px 12px;
  }
  .k {
    flex-basis: 60px;
  }
  .log-head {
    padding: 8px 12px 4px;
    flex-wrap: wrap;
    gap: 2px 8px;
  }
  .log-meta {
    flex: 1 1 100%;
  }
  .log-wrap {
    margin: 0 12px calc(12px + env(safe-area-inset-bottom, 0px));
  }
  .overview {
    padding: 12px;
  }
  .track {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'name used'
      'model state';
    gap: 2px 8px;
    padding: 6px 9px;
  }
  .track-name {
    grid-area: name;
  }
  .track-used {
    grid-area: used;
    font-size: 10.5px;
  }
  .track-model {
    grid-area: model;
    font-size: 10.5px;
  }
  .track-state {
    grid-area: state;
    font-size: 10.5px;
    text-align: right;
  }
}
</style>
