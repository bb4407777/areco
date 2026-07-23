<script setup lang="ts">
// 项目协作：项目 = 人 + 多个 agent 成员。@成员/@all 的消息由服务端注入目标终端，
// agent 用仓内 areco-msg.mjs 回执；消息 SoT 在服务端 projects.db，本页经 WS（rooms/roomMessage）实时更新，不轮询。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NModal, NPopconfirm, NPopover, NSelect, NSpin, useMessage } from 'naive-ui'
import type { DeliveryStatus, DispatchMode, RoomMember, SessionSummary } from '../../../shared/protocol'
import type { TrafficState } from '../../../shared/traffic'
import { useRoomsStore } from '../stores/rooms'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { copyPlainText } from '../utils/clipboard'
import { fmtFullTime, templateColor, trafficColor } from '../utils/format'
import { api } from '../api'
import { useFileDrop } from '../composables/useFileDrop'
import FileDropOverlay from '../components/FileDropOverlay.vue'
import FilePreview from '../components/FilePreview.vue'
import ProjectArtifactsBar from '../components/ProjectArtifactsBar.vue'
import ProjectFilesPanel from '../components/ProjectFilesPanel.vue'
import TypingIndicator from '../components/TypingIndicator.vue'

const HUMAN_FALLBACK = 'Owner'
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])

const rooms = useRoomsStore()
const sessionsStore = useSessionsStore()
const ui = useUiStore()
const message = useMessage()

const loading = ref(false)
const activeId = ref('')
const limit = ref(100)
const showCreate = ref(false)
const newRoomName = ref('')
const mobileRoomsOpen = ref(false)
const showArchived = ref(false)
const previewPath = ref<string | null>(null)
const activePane = ref<'chat' | 'files'>('chat')
const fileLocate = ref<{ path: string; nonce: number } | null>(null)

const room = computed(() => rooms.byId(activeId.value))
// 兼容前端已更新、8790 尚未重启的窗口：旧服务端缺 archivedAt，仍按当前项目显示。
const viewingArchived = computed(() => typeof room.value?.archivedAt === 'number')
const human = computed(() => rooms.humanName || HUMAN_FALLBACK)
const msgs = computed(() => (activeId.value ? (rooms.messages[activeId.value] ?? []) : []))
const hasMore = computed(() => msgs.value.length >= limit.value)

// ---- 成员 ----

function memberSession(m: RoomMember) {
  return m.sessionId ? sessionsStore.byId(m.sessionId) : undefined
}
function memberColor(m: RoomMember): string {
  if (m.kind === 'human') return 'var(--accent)'
  const s = memberSession(m)
  return s ? templateColor(s, sessionsStore.templates) : '#6b7280'
}
// 成员列表圆点：agent 用会话红绿灯（不按模板分色）；人保持品牌色；无会话灰
function memberDotColor(m: RoomMember): string {
  if (m.kind === 'human') return 'var(--accent)'
  const s = memberSession(m)
  return s ? trafficColor(s.trafficState, s.status) : '#6b7280'
}
// 项目圆点：聚合该项目下 agent 成员会话的红绿灯（取最值得关注的一档）；无在册会话→灰
function roomDotColor(r: { members: RoomMember[] }): string {
  const ss = r.members.map(memberSession).filter((s): s is SessionSummary => !!s)
  if (!ss.length) return trafficColor('exited')
  const rank: Record<TrafficState, number> = { 'needs-user': 0, working: 1, conclusion: 2, exited: 3, idle: 4 }
  const pick = ss.reduce((a, b) => (rank[b.trafficState] < rank[a.trafficState] ? b : a))
  return trafficColor(pick.trafficState, pick.status)
}
// 气泡着色：按消息发送者名找到对应成员，取其模板色作 --sender（CSS 侧兑淡做背景+实色左边框）。
// self（维护者本人）走默认 user 气泡；找不到成员的外部终端名回落灰色。
function senderStyle(m: { from: string }): Record<string, string> | undefined {
  if (m.from === human.value) return undefined
  const mem = room.value?.members.find((mb) => mb.name === m.from)
  return { '--sender': mem ? memberColor(mem) : '#6b7280' }
}
function memberWorking(m: RoomMember): boolean {
  const s = memberSession(m)
  return Boolean(s && s.status === 'running' && s.trafficState === 'working')
}
// 正在干活的 agent 成员：消息流尾部各挂一条「正在输入中…」动效（对话页没有终端滚屏的活感）
const workingMembers = computed(() => (room.value?.members ?? []).filter((m) => m.kind === 'session' && memberWorking(m)))

const SHELL_FREE = (cmd: string) => !SHELLS.has(cmd.split('/').pop() ?? '')
// 加成员只有一组：新建 agent 进项目（按模板现场拉起，roomId 强归属、专职专用）。
// 2026-07-22 收窄（维护者）：不再支持拉总台/运行中的会话进项目——上下文不统一，统一开新会话
const spawnableTemplates = computed(() => {
  // 房内已有该 agent 的模板不再出现在"新建"组（成员名 = 添加时模板名，重名带 ·2 后缀）
  const inRoomNames = new Set(
    (room.value?.members ?? [])
      .filter((m) => m.kind === 'session')
      .map((m) => m.name.replace(/·\d+$/, ''))
  )
  return sessionsStore.enabledTemplates
    .filter((t) => SHELL_FREE(t.command) && !inRoomNames.has(t.name))
    .map((t) => ({ label: `＋ ${t.name}（新会话）`, value: t.id }))
})
const addOptions = computed(() => {
  const groups: { type: string; label: string; key: string; children: { label: string; value: string }[] }[] = []
  if (spawnableTemplates.value.length)
    groups.push({ type: 'group', label: '新建 agent 进项目', key: 'g-spawn', children: spawnableTemplates.value })
  return groups
})

async function onAddMember(value: string | null) {
  if (!value || !room.value) return
  try {
    await rooms.addMember(room.value.id, value)
    message.success('已拉起新 agent 并加入项目')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ---- 项目 CRUD ----

async function createRoom() {
  const name = newRoomName.value.trim()
  if (!name) return
  try {
    const r = await rooms.create(name)
    showCreate.value = false
    newRoomName.value = ''
    activeId.value = r.id
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function archiveRoom() {
  if (!room.value) return
  const archivedId = room.value.id
  try {
    await rooms.archive(archivedId)
    activeId.value = rooms.rooms.find((r) => r.archivedAt === null && r.id !== archivedId)?.id ?? ''
    message.success('项目已归档，消息和成员快照均已保留')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeRoom() {
  if (!room.value) return
  const removedId = room.value.id
  const removedName = room.value.name
  try {
    await rooms.remove(removedId)
    const next = rooms.rooms.find((r) => r.id !== removedId && r.archivedAt === null)
      ?? rooms.rooms.find((r) => r.id !== removedId)
    activeId.value = next?.id ?? ''
    if (next && typeof next.archivedAt === 'number') showArchived.value = true
    message.success(`项目「${removedName}」已删除`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function unarchiveRoom() {
  if (!room.value) return
  try {
    await rooms.unarchive(room.value.id)
    message.success('项目已恢复')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openRoom(id: string) {
  if (typeof rooms.byId(id)?.archivedAt === 'number') showArchived.value = true
  activeId.value = id
  mobileRoomsOpen.value = false
}

function locateProjectFile(path: string) {
  fileLocate.value = { path, nonce: (fileLocate.value?.nonce ?? 0) + 1 }
  activePane.value = 'files'
}

// ---- 房间调度（并行=全员即注；串行=一次放行一位；认领制=先报认领、原子批准唯一 Implementer）----

const showDispatch = ref(false)
const dispatchList = computed(() => (activeId.value ? (rooms.dispatches[activeId.value] ?? []) : []))
const activeSerial = computed(() => dispatchList.value.find((d) => d.mode === 'serial' && d.state === 'active'))
const activeClaim = computed(() => dispatchList.value.find((d) => d.mode === 'claim' && d.state === 'active'))

const MODE_LABEL: Record<DispatchMode, string> = { parallel: '并行讨论', serial: '串行轮转', claim: '认领制' }
const MODE_TOAST: Record<DispatchMode, string> = {
  parallel: '已切到并行讨论：全体同时收到',
  serial: '已切到串行轮转：一次只放行一位 agent',
  claim: '已切到认领制：先报认领，先到先得唯一 Implementer',
}

async function setDispatchMode(mode: DispatchMode) {
  if (!room.value || room.value.dispatchMode === mode) return
  try {
    await rooms.setMode(room.value.id, mode)
    message.success(MODE_TOAST[mode])
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ---- repo 绑定（认领制赢家自动开工作区用）----

const repoDraft = ref('')
watch(
  () => room.value?.repoPath,
  (v) => {
    repoDraft.value = v ?? ''
  },
  { immediate: true }
)

async function saveRepo() {
  if (!room.value) return
  try {
    await rooms.setRepo(room.value.id, repoDraft.value.trim() || null)
    message.success(repoDraft.value.trim() ? '已绑定仓库，认领赢家将自动开工作区' : '已解绑仓库')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ---- 合并预检 / 派 agent 解冲突（认领制阶段四）----

/** dispatchId → 最近一次预检结果（不缓存进 store，面板级瞬态即可） */
const mergeResults = ref<Record<number, { clean: boolean; conflicts: string[]; message: string }>>({})
const mergeChecking = ref(0) // 正在预检的 dispatchId（0=无）

async function runMergeCheck(dispatchId: number) {
  if (!room.value) return
  mergeChecking.value = dispatchId
  try {
    mergeResults.value[dispatchId] = await rooms.mergeCheck(room.value.id, dispatchId)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    mergeChecking.value = 0
  }
}

async function resolveConflict(dispatchId: number) {
  if (!room.value) return
  // 解冲突 agent 用哪个模板：取第一个启用的非 shell 模板（与「加成员」同一批候选）
  const template = sessionsStore.enabledTemplates.find((t) => !SHELLS.has(t.command.split('/').pop() ?? t.command))
  if (!template) {
    message.error('没有可用的 agent 模板')
    return
  }
  try {
    const res = await rooms.resolveConflict(room.value.id, dispatchId, template.id)
    if (res.clean) message.success(res.message)
    else message.success(`${res.message}（${template.name}）`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function cancelDispatch(dispatchId: number) {
  if (!room.value) return
  try {
    await rooms.cancelDispatch(room.value.id, dispatchId, '页面手动取消')
    message.success('已取消，排队中的成员不再放行')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const DISPATCH_STATE_LABEL: Record<string, string> = { active: '进行中', done: '已完成', cancelled: '已取消' }
const DISPATCH_PHASE_LABEL: Record<string, string> = { claiming: '报认领中', implementing: '实施中', done: '已收单' }
const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  queued: '排队',
  injected: '已注入',
  working: '工作中',
  replied: '已回复',
  done: '完成',
  timeout: '超时',
  cancelled: '已取消',
  failed: '失败',
}
/** 根消息摘要：在已加载消息里按 id 找，找不到（超出窗口）只显示编号 */
function rootSummary(rootMessageId: number): string {
  const m = msgs.value.find((x) => x.id === rootMessageId)
  if (!m) return `#${rootMessageId}`
  const t = m.body.replace(/\s+/g, ' ').trim()
  return `#${m.id} ${t.length > 24 ? `${t.slice(0, 24)}…` : t}`
}

// ---- 消息流 ----

const scroller = ref<HTMLElement | null>(null)

function nearBottom(): boolean {
  const el = scroller.value
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
}
function scrollBottom() {
  nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight }))
}

watch(activeId, async (id) => {
  limit.value = 100
  if (!id) return
  if (!rooms.messages[id]) {
    try {
      await rooms.loadMessages(id, limit.value)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }
  rooms.loadDispatches(id).catch(() => {}) // 旧服务端无此接口时静默，面板显示空
  rooms.markRead(id)
  scrollBottom()
})

// 新消息到达：当前房已读 + 贴底则跟滚；其他房靠侧栏角标
watch(
  () => msgs.value.length,
  () => {
    if (!activeId.value) return
    const stick = nearBottom()
    rooms.markRead(activeId.value)
    if (stick) scrollBottom()
  }
)

async function loadMore() {
  if (!activeId.value) return
  limit.value *= 2
  await rooms.loadMessages(activeId.value, limit.value)
}

// 消息复制（与对话气泡同套 utils/clipboard 双通道）；✓ 反馈按消息 id 记，列表滚动不串
const copiedMsgId = ref<number | null>(null)
let copyMsgTimer: number | null = null
function copyMsg(m: { id: number; body: string }) {
  if (!m.body) return
  void copyPlainText(m.body)
  copiedMsgId.value = m.id
  if (copyMsgTimer !== null) clearTimeout(copyMsgTimer)
  copyMsgTimer = window.setTimeout(() => {
    copiedMsgId.value = null
    copyMsgTimer = null
  }, 1200)
}

function fmtTs(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---- 输入框 + @mention 自动补全（纯文本，成员名可含空格：前缀匹配而非切词）----

const draft = ref('')
const sending = ref(false)
const ta = ref<HTMLTextAreaElement | null>(null)
// 文件拖放/选件上传（document 级拖放 + 落盘回填到 draft），逻辑在 useFileDrop
const { dragging, uploading, fileInputEl, pickFiles, onInputChange } = useFileDrop({ text: draft, inputEl: ta })
// 输入多了 textarea 自动长高，与座舱页输入框同款
const MAX_DRAFT_HEIGHT = 200
function autoGrow() {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, MAX_DRAFT_HEIGHT)}px`
}
watch(draft, () => nextTick(autoGrow))
const mentionAt = ref<number | null>(null) // 光标前最近一个合法 @ 的位置
const mentionQuery = ref('')
const mentionIndex = ref(0)

const mentionOptions = computed(() => {
  if (mentionAt.value === null || !room.value) return []
  const q = mentionQuery.value.toLowerCase()
  const opts = [{ key: 'all', label: 'all', hint: '全体会话成员' }]
  for (const m of room.value.members) {
    if (m.kind === 'session') opts.push({ key: m.name, label: m.name, hint: memberWorking(m) ? '工作中' : '' })
  }
  return opts.filter((o) => !q || o.label.toLowerCase().startsWith(q))
})
const mentionOpen = computed(() => mentionOptions.value.length > 0)

function updateMention() {
  const el = ta.value
  if (!el) return
  const before = draft.value.slice(0, el.selectionStart)
  const at = before.lastIndexOf('@')
  if (at < 0) {
    mentionAt.value = null
    return
  }
  const query = before.slice(at + 1)
  if (query.includes('@') || query.includes('\n')) {
    mentionAt.value = null
    return
  }
  // 仅当 @ 位置或查询串变化才重置选中项；方向键上下选时 at/query 不变，不重置（修"按↓跳回首项"bug）
  if (mentionAt.value !== at || mentionQuery.value !== query) {
    mentionIndex.value = 0
  }
  mentionAt.value = at
  mentionQuery.value = query
}

function pickMention(opt: { label: string }) {
  const el = ta.value
  if (mentionAt.value === null || !el) return
  const insert = `@${opt.label} `
  const caret = el.selectionStart
  draft.value = draft.value.slice(0, mentionAt.value) + insert + draft.value.slice(caret)
  const pos = mentionAt.value + insert.length
  mentionAt.value = null
  nextTick(() => {
    el.focus()
    el.setSelectionRange(pos, pos)
  })
}

function onKeydown(e: KeyboardEvent) {
  if (mentionOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionIndex.value = (mentionIndex.value + 1) % mentionOptions.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionIndex.value = (mentionIndex.value - 1 + mentionOptions.value.length) % mentionOptions.value.length
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pickMention(mentionOptions.value[mentionIndex.value])
      return
    }
    if (e.key === 'Escape') {
      mentionAt.value = null
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !(e as unknown as { isComposing?: boolean }).isComposing) {
    e.preventDefault()
    void send()
  }
}

async function send() {
  const body = draft.value.trim()
  if (!body || !room.value || sending.value) return
  sending.value = true
  try {
    await rooms.send(room.value.id, body)
    draft.value = ''
    mentionAt.value = null
    scrollBottom()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    sending.value = false
  }
}

// ---- 搜索：左栏项目名过滤 + 主区跨项目消息搜索 ----
const nameFilter = ref('')
const activeRooms = computed(() => rooms.sortedRooms.filter((r) => typeof r.archivedAt !== 'number'))
const archivedRooms = computed(() => rooms.sortedRooms.filter((r) => typeof r.archivedAt === 'number'))
const filteredRooms = computed(() => {
  const q = nameFilter.value.trim().toLowerCase()
  return q ? activeRooms.value.filter((r) => r.name.toLowerCase().includes(q)) : activeRooms.value
})
const filteredArchivedRooms = computed(() => {
  const q = nameFilter.value.trim().toLowerCase()
  return q ? archivedRooms.value.filter((r) => r.name.toLowerCase().includes(q)) : archivedRooms.value
})

type MsgHit = { id: number; roomId: string; roomName: string; archived: boolean; from: string; to: string; body: string; createdAt: string }
const msgQuery = ref('')
const searchResults = ref<MsgHit[]>([])
const searching = ref(false)
let searchDebounce: number | null = null

watch(msgQuery, () => {
  if (searchDebounce !== null) clearTimeout(searchDebounce)
  const q = msgQuery.value.trim()
  if (!q) {
    searchResults.value = []
    searching.value = false
    return
  }
  searching.value = true
  searchDebounce = window.setTimeout(async () => {
    try {
      searchResults.value = await api.get<MsgHit[]>(
        `/api/rooms/messages/search?q=${encodeURIComponent(q)}&limit=50`
      )
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      searching.value = false
    }
  }, 300)
})

function openFromSearch(roomId: string) {
  msgQuery.value = ''
  openRoom(roomId)
}

onMounted(async () => {
  loading.value = true
  try {
    await rooms.refresh()
    if (!activeId.value && activeRooms.value.length) activeId.value = activeRooms.value[0].id
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="groupchat">
    <!-- 项目栏：桌面常驻侧栏，手机为浮层 -->
    <aside class="rooms" :class="{ overlay: ui.isMobile, open: !ui.isMobile || mobileRoomsOpen }">
      <div class="rooms-head">
        <span class="rooms-title">当前项目</span>
        <button class="icon-btn" title="新建项目" @click="showCreate = true">＋</button>
      </div>
      <NInput v-model:value="nameFilter" placeholder="搜项目名" size="tiny" clearable class="rooms-search" />
      <div class="rooms-list">
        <button
          v-for="r in filteredRooms"
          :key="r.id"
          class="room-item"
          :class="{ active: r.id === activeId }"
          @click="openRoom(r.id)"
        >
          <span class="room-dot" :style="{ background: roomDotColor(r) }" />
          <span class="room-name">{{ r.name }}</span>
          <span class="room-count">{{ r.members.filter((m) => m.kind === 'session').length }} agent</span>
          <span v-if="rooms.unread(r.id)" class="badge">{{ rooms.unread(r.id) }}</span>
        </button>
        <NEmpty v-if="!activeRooms.length && rooms.loaded" description="当前没有项目，点右上角 ＋ 建一个" class="rooms-empty" />
        <button v-if="archivedRooms.length" class="archive-toggle" @click="showArchived = !showArchived">
          <span>已归档</span>
          <span>{{ archivedRooms.length }} {{ showArchived ? '▾' : '▸' }}</span>
        </button>
        <template v-if="showArchived">
          <button
            v-for="r in filteredArchivedRooms"
            :key="r.id"
            class="room-item archived"
            :class="{ active: r.id === activeId }"
            @click="openRoom(r.id)"
          >
            <span class="archive-icon">▣</span>
            <span class="room-name">{{ r.name }}</span>
            <span class="room-count">只读</span>
          </button>
        </template>
      </div>
    </aside>
    <div v-if="ui.isMobile && mobileRoomsOpen" class="rooms-mask" @click="mobileRoomsOpen = false" />

    <main class="main">
      <NSpin v-if="loading" class="center" />
      <NEmpty
        v-else-if="rooms.stale"
        description="项目协作需要新版服务端：8790 重启后可用（前端已就绪）"
        class="center"
      />
      <NEmpty v-else-if="!room" description="建一个项目，把 agent 拉进来协作" class="center" />

      <template v-else>
        <header class="head">
          <button v-if="ui.isMobile" class="icon-btn" title="项目列表" @click="mobileRoomsOpen = true">☰</button>
          <h2 class="title">{{ room.name }}</h2>
          <span v-if="viewingArchived" class="archived-label">已归档 · 只读</span>
          <div class="members">
            <span
              v-for="m in room.members"
              :key="m.name"
              class="chip"
              :class="{ offline: m.kind === 'session' && !memberSession(m) }"
            >
              <span class="dot" :style="{ background: memberDotColor(m) }" />
              <span class="mname" :style="{ color: memberColor(m) }">{{ m.name }}</span>
              <em v-if="memberWorking(m)" class="working">工作中</em>
              <NPopconfirm v-if="m.kind === 'session' && !viewingArchived" @positive-click="rooms.removeMember(room.id, m.name)">
                <template #trigger><button class="chip-x" title="移出项目">×</button></template>
                把 {{ m.name }} 移出项目？
              </NPopconfirm>
            </span>
            <NSelect
              v-if="!viewingArchived"
              class="add-member"
              size="tiny"
              :value="null"
              :options="addOptions"
              placeholder="＋ agent"
              :disabled="!addOptions.length"
              :consistent-menu-width="false"
              @update:value="onAddMember"
            />
          </div>
          <NPopover v-if="!viewingArchived" trigger="click" placement="bottom-end" style="max-width: 420px">
            <template #trigger><button class="icon-btn" title="邀请外部终端的 agent">⇗</button></template>
            <div class="invite">
              <p>本机任何终端都可向本项目发消息（team：<code>{{ room.team }}</code>）：</p>
              <code class="invite-cmd">node {{ rooms.msgCli || 'scripts/areco-msg.mjs' }} {{ room.team }} '&lt;名字&gt;' '&lt;收件人或 all&gt;' '&lt;消息&gt;'</code>
              <p>消息会实时出现在这里；房里 @成员 的消息会投递到对应会话终端（外部终端的名字仅作显示，收不到投递）。</p>
            </div>
          </NPopover>
          <NButton v-if="viewingArchived" size="tiny" secondary @click="unarchiveRoom">恢复项目</NButton>
          <NButton
            v-else
            size="tiny"
            secondary
            :disabled="!rooms.archiveSupported"
            :title="rooms.archiveSupported ? '归档项目' : '重启 8790 后可归档'"
            @click="archiveRoom"
          >归档项目</NButton>
          <NPopconfirm v-if="viewingArchived" @positive-click="removeRoom">
            <template #trigger>
              <NButton size="tiny" secondary type="error">删除项目</NButton>
            </template>
            确定删除项目「{{ room.name }}」？项目及其项目内会话将一并删除（多项目共享的会话保留），此操作不可恢复。
          </NPopconfirm>
        </header>

        <nav class="project-tabs" aria-label="项目视图">
          <button :class="{ active: activePane === 'chat' }" @click="activePane = 'chat'">💬 协作</button>
          <button :class="{ active: activePane === 'files' }" @click="activePane = 'files'">📁 文件</button>
        </nav>

        <ProjectFilesPanel
          v-if="activePane === 'files'"
          :room-id="room.id"
          :root-path="room.rootPath"
          :archived="viewingArchived"
          :locate-path="fileLocate?.path"
          :locate-nonce="fileLocate?.nonce"
          @preview="previewPath = $event"
        />

        <template v-else>

        <div v-if="!viewingArchived" class="dispatch">
          <div class="dispatch-bar">
            <button class="dispatch-toggle" @click="showDispatch = !showDispatch">
              调度 · {{ MODE_LABEL[room.dispatchMode] }} {{ showDispatch ? '▾' : '▸' }}
            </button>
            <span v-if="activeSerial?.currentTarget" class="dispatch-cur">轮到 {{ activeSerial.currentTarget }}</span>
            <span v-else-if="activeClaim" class="dispatch-cur">
              {{ activeClaim.implementer ? `${activeClaim.implementer} 实施中` : '等待认领' }}
            </span>
            <template v-if="showDispatch">
              <button
                class="mode-btn"
                :class="{ on: room.dispatchMode === 'parallel' }"
                title="全体同时收到并实施（现状行为）"
                @click="setDispatchMode('parallel')"
              >并行讨论</button>
              <button
                class="mode-btn"
                :class="{ on: room.dispatchMode === 'serial' }"
                title="一次只放行一位 agent，回复/超时自动轮到下一位"
                @click="setDispatchMode('serial')"
              >串行轮转</button>
              <button
                class="mode-btn"
                :class="{ on: room.dispatchMode === 'claim' }"
                title="全员先报认领，原子批准唯一 Implementer，其余转 reviewer"
                @click="setDispatchMode('claim')"
              >认领制</button>
            </template>
          </div>
          <div v-if="showDispatch" class="dispatch-list">
            <div class="repo-bind">
              <NInput
                v-model:value="repoDraft"
                placeholder="绑定 git 仓库绝对路径（认领赢家自动开工作区），留空解绑"
                size="tiny"
                class="repo-input"
                @keyup.enter="saveRepo"
              />
              <button class="mode-btn" @click="saveRepo">保存</button>
            </div>
            <NEmpty v-if="!dispatchList.length" description="还没有调度记录，发一条消息试试" size="small" class="dispatch-empty" />
            <div v-for="d in dispatchList" :key="d.id" class="dispatch-item">
              <div class="dispatch-meta">
                <span class="d-state" :data-s="d.state">{{ DISPATCH_STATE_LABEL[d.state] ?? d.state }}</span>
                <span class="d-mode">{{ MODE_LABEL[d.mode] }}</span>
                <span class="d-root" :title="`根消息 #${d.rootMessageId}`">{{ rootSummary(d.rootMessageId) }}</span>
                <span v-if="d.currentTarget" class="d-cur">→ {{ d.currentTarget }}</span>
                <span v-if="d.phase" class="d-cur">{{ DISPATCH_PHASE_LABEL[d.phase] ?? d.phase }}</span>
                <span v-if="d.implementer" class="d-cur">Implementer：{{ d.implementer }}</span>
                <span v-if="d.state === 'active' && d.deadline" class="d-deadline">{{ fmtTs(d.deadline) }} 超时</span>
                <span v-if="d.state === 'active' && d.claimDeadline && !d.implementer" class="d-deadline">{{ fmtTs(d.claimDeadline) }} 认领截止</span>
                <span v-if="d.cancelReason" class="d-reason">取消：{{ d.cancelReason }}</span>
                <button v-if="d.state === 'active' && d.mode === 'serial'" class="d-cancel" @click="cancelDispatch(d.id)">取消</button>
                <button
                  v-if="d.branch"
                  class="d-cancel"
                  :disabled="mergeChecking === d.id"
                  @click="runMergeCheck(d.id)"
                >{{ mergeChecking === d.id ? '预检中…' : '合并预检' }}</button>
              </div>
              <div v-if="d.worktreePath" class="d-worktree" :title="d.worktreePath">
                工作区 {{ d.worktreePath }} · 分支 {{ d.branch }}
              </div>
              <div v-if="mergeResults[d.id]" class="d-merge" :data-clean="mergeResults[d.id].clean">
                <span>{{ mergeResults[d.id].message }}</span>
                <template v-if="!mergeResults[d.id].clean && mergeResults[d.id].conflicts.length">
                  <span v-for="f in mergeResults[d.id].conflicts" :key="f" class="d-conflict">{{ f }}</span>
                  <button class="d-cancel" @click="resolveConflict(d.id)">派 agent 解冲突</button>
                </template>
              </div>
              <div class="d-deliveries">
                <span v-for="del in d.deliveries" :key="del.id" class="d-del" :data-s="del.status">
                  {{ del.memberName }} · {{ DELIVERY_STATUS_LABEL[del.status] }}<template v-if="del.attempt > 1">（第 {{ del.attempt }} 次）</template>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 消息搜索固定钉在消息流顶部（不随滚动走），结果仍在流内展示 -->
        <NInput v-model:value="msgQuery" placeholder="搜消息内容（跨所有项目）" size="small" clearable class="msg-search" />
        <div ref="scroller" class="stream">
          <template v-if="msgQuery.trim()">
            <div v-if="searching" class="search-hint">搜索中…</div>
            <NEmpty v-else-if="!searchResults.length" description="没找到匹配的消息" class="center" />
            <template v-else>
              <button
                v-for="m in searchResults"
                :key="`${m.roomId}-${m.id}`"
                class="msg search-hit"
                @click="openFromSearch(m.roomId)"
              >
                <div class="msg-meta">
                  <span class="from">{{ m.from }}</span>
                  <span class="room-tag">{{ m.roomName }}{{ m.archived ? ' · 已归档' : '' }}</span>
                  <span class="time">{{ fmtTs(m.createdAt) }}</span>
                </div>
                <div class="bubble">{{ m.body }}</div>
              </button>
            </template>
          </template>
          <template v-else>
            <button v-if="hasMore" class="load-more" @click="loadMore">加载更早的消息</button>
            <NEmpty v-if="!msgs.length" description="还没有消息。@agent 的名字就会投递到它的终端" class="center" />
            <div v-for="m in msgs" :key="m.id" class="msg" :class="{ self: m.from === human }" :style="senderStyle(m)">
              <!-- 统一版式（与对话模式一致）：发送者名在泡泡上方；复制在泡泡下方左侧；完整时间在右下角 -->
              <div class="msg-meta">
                <span class="from">{{ m.from === human ? `${m.from}（我）` : m.from }}</span>
                <span v-if="m.humanRelay" class="relay-tag" title="白名单 agent 转述人类成员原话，按人类语义投递">转述</span>
              </div>
              <div class="bubble">{{ m.body }}</div>
              <div class="msg-foot">
                <button type="button" class="copy-btn" :title="copiedMsgId === m.id ? '已复制' : '复制正文'" @click="copyMsg(m)">
                  {{ copiedMsgId === m.id ? '✓ 已复制' : '📋 复制' }}
                </button>
                <span class="time">{{ fmtFullTime(m.createdAt) }}</span>
              </div>
            </div>
            <TypingIndicator
              v-for="m in workingMembers"
              :key="`typing-${m.name}`"
              :style="{ '--sender': memberColor(m) }"
              :label="`${m.name} 正在输入中…`"
            />
          </template>
        </div>

        <ProjectArtifactsBar
          :room-id="room.id"
          :messages="msgs"
          :human-name="human"
          @preview="previewPath = $event"
          @locate="locateProjectFile"
        />

        <div v-if="viewingArchived" class="archived-notice">该项目已归档：消息和成员快照仅供查看，恢复后才能继续协作。</div>
        <div v-else class="composer">
          <div v-if="mentionOpen" class="mention-pop">
            <button
              v-for="(o, i) in mentionOptions"
              :key="o.key"
              class="mention-item"
              :class="{ sel: i === mentionIndex }"
              @mousedown.prevent="pickMention(o)"
            >
              <span class="mention-label">@{{ o.label }}</span>
              <span v-if="o.hint" class="mention-hint">{{ o.hint }}</span>
            </button>
          </div>
          <input ref="fileInputEl" type="file" multiple hidden @change="onInputChange" />
          <button class="attach-btn" type="button" :disabled="uploading" title="上传文件，路径填入输入框" @click="pickFiles">{{ uploading ? '⏳' : '📎' }}</button>
          <textarea
            ref="ta"
            v-model="draft"
            class="input"
            rows="2"
            :placeholder="ui.isMobile ? '发消息… @成员/@all' : '发消息…… @成员名 或 @all 会投递到对应终端'"
            @input="updateMention"
            @keyup="updateMention"
            @click="updateMention"
            @keydown="onKeydown"
          />
          <NButton type="primary" :loading="sending" :disabled="!draft.trim()" @click="send">发送</NButton>
        </div>
        </template>
      </template>
    </main>

    <FileDropOverlay :visible="dragging" />
    <FilePreview :path="previewPath" @close="previewPath = null" />
    <NModal v-model:show="showCreate" preset="card" title="新建项目" style="max-width: 360px">
      <NInput v-model:value="newRoomName" placeholder="项目名（如：官网改版攻坚组）" @keyup.enter="createRoom" />
      <template #footer>
        <NButton type="primary" :disabled="!newRoomName.trim()" @click="createRoom">创建</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.groupchat {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ---- 项目栏 ---- */
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
.rooms-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.room-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.room-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.room-item:hover {
  background: var(--hover);
}
.room-item.active {
  background: var(--chip-bg);
}
.room-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.room-count {
  font-size: 11px;
  color: var(--muted);
  flex: 0 0 auto;
}
.badge {
  flex: 0 0 auto;
  min-width: 17px;
  height: 17px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
.rooms-empty {
  margin-top: 40px;
}
.archive-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 8px 10px;
  border: none;
  border-top: 1px solid var(--border);
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.room-item.archived {
  color: var(--muted);
}
.archive-icon {
  flex: 0 0 auto;
  font-size: 12px;
}
.rooms-search {
  /* naive NInput 根节点自带 width:100%，叠加左右 8px margin 会溢出 230px 侧栏 16px（凸出）。
     scoped 属性选择器优先级高于 .n-input，width:auto + flex 列 stretch 自动收成栏宽减边距 */
  margin: 6px 8px 0;
  width: auto;
  align-self: stretch;
}
.msg-search {
  /* 钉在主区顶部（dispatch 面板与消息流之间），不随消息滚动；
     同 rooms-search：NInput 默认 width:100% 叠加水平 margin 会溢出，改 auto + stretch */
  margin: 8px 12px 4px;
  width: auto;
  align-self: stretch;
}
.search-hint {
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  padding: 16px 0;
}
.search-hit {
  max-width: 100%;
  text-align: left;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 8px;
}
.search-hit:hover {
  background: var(--hover);
}
.room-tag {
  font-size: 11px;
  color: var(--accent);
  background: var(--chip-bg);
  padding: 1px 6px;
  border-radius: 6px;
}

/* ---- 主区 ---- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.project-tabs { display: flex; gap: 4px; padding: 5px 12px; border-bottom: 1px solid var(--border); background: var(--bar); }
.project-tabs button { border: 0; border-radius: 7px; padding: 4px 11px; background: none; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.project-tabs button.active { background: var(--chip-bg); color: var(--accent); font-weight: 600; }
.title {
  margin: 0;
  font-size: 16px;
}
.archived-label {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 7px;
  background: var(--chip-bg);
  color: var(--muted);
  font-size: 11px;
}
.members {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--chip-bg);
  font-size: 12px;
  flex: 0 0 auto; /* chip 不被压缩，保自然宽度 */
}
/* 成员名永不从中折断（手机端 gpt-5.6-sol 断成三行的病根） */
.mname {
  white-space: nowrap;
}
.chip.offline {
  opacity: 0.55;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.working {
  font-style: normal;
  font-size: 11px;
  color: var(--accent);
}
.chip-x {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  padding: 0 0 0 2px;
}
.add-member {
  width: 150px;
}
/* 下拉面板随内容加宽（consistent-menu-width=false），模板全名不再被裁 */
.invite {
  font-size: 12px;
  line-height: 1.6;
}
.invite p {
  margin: 4px 0;
}
.invite-cmd {
  display: block;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--chip-bg);
  word-break: break-all;
  user-select: all;
}
.icon-btn {
  border: none;
  background: none;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
.icon-btn:hover {
  background: var(--hover);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.icon-btn.danger {
  font-size: 14px;
}

/* ---- 调度面板 ---- */
.dispatch {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
  background: var(--bar);
  font-size: 12px;
}
.dispatch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
}
.dispatch-toggle {
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
  padding: 2px 0;
}
.dispatch-toggle:hover {
  color: var(--text);
}
.dispatch-cur {
  color: var(--accent);
}
.mode-btn {
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.mode-btn.on {
  background: var(--chip-bg);
  color: var(--accent);
  border-color: var(--accent);
}
.dispatch-list {
  max-height: 180px;
  overflow-y: auto;
  padding: 2px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dispatch-empty {
  padding: 8px 0;
}
.dispatch-item {
  background: var(--chip-bg);
  border-radius: 8px;
  padding: 6px 8px;
}
.dispatch-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--muted);
}
.d-state[data-s='active'] {
  color: var(--accent);
}
.d-state[data-s='cancelled'] {
  color: #d03050;
}
.d-root {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.d-cur {
  color: var(--accent);
}
.d-reason {
  color: #d03050;
}
.d-cancel {
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  padding: 1px 7px;
  cursor: pointer;
}
.d-cancel:hover {
  color: #d03050;
  border-color: #d03050;
}
.d-cancel:disabled {
  opacity: 0.5;
  cursor: default;
}
.repo-bind {
  display: flex;
  align-items: center;
  gap: 6px;
}
.repo-input {
  flex: 1;
}
.d-worktree {
  margin-top: 4px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.d-merge {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.d-merge[data-clean='true'] {
  color: #18a058;
}
.d-merge[data-clean='false'] {
  color: #d03050;
}
.d-conflict {
  padding: 0 6px;
  border-radius: 6px;
  background: var(--bar);
  font-family: monospace;
}
.d-deliveries {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.d-del {
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--bar);
  color: var(--muted);
}
.d-del[data-s='injected'],
.d-del[data-s='working'] {
  color: var(--accent);
}
.d-del[data-s='done'],
.d-del[data-s='replied'] {
  color: #18a058;
}
.d-del[data-s='timeout'],
.d-del[data-s='failed'],
.d-del[data-s='cancelled'] {
  color: #d03050;
}

/* ---- 消息流 ---- */
.stream {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.load-more {
  align-self: center;
  border: none;
  background: var(--chip-bg);
  color: var(--muted);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
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
.msg-meta .relay-tag {
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--chip-bg);
  color: var(--muted);
}
.msg-foot {
  display: flex;
  align-items: center;
  margin-top: 3px;
}
.msg.self .msg-foot {
  /* 自己消息泡泡靠右：复制与时间一并收到右下（复制在时间左侧） */
  justify-content: flex-end;
}
.msg.self .msg-foot .time {
  margin-left: 0;
}
.msg-foot .time {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
}
.msg-foot .copy-btn {
  border: 0;
  background: none;
  color: var(--faint);
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 5px;
  margin-left: -5px;
  border-radius: 5px;
  cursor: pointer;
  touch-action: manipulation;
}
.msg-foot .copy-btn:hover {
  color: var(--text);
  background: var(--chip-bg);
}
.msg.self .msg-foot .copy-btn {
  margin-left: 0;
  margin-right: -5px;
}
.msg.self .msg-meta {
  justify-content: flex-end;
}
.from {
  color: var(--sender, var(--muted));
  font-weight: 600;
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
/* 非 self 的 agent 消息：发送者模板色兑淡做背景（16%）+ 同色实色左边框，一眼区分谁发的 */
.msg:not(.self) .bubble {
  background: color-mix(in srgb, var(--sender, var(--chip-bg)) 16%, var(--chip-bg));
  border-left-color: var(--sender, transparent);
}
.msg.self .bubble {
  background: var(--bubble-user-bg);
  border: 1px solid var(--bubble-user-border);
  border-left: 1px solid var(--bubble-user-border);
}

/* ---- 输入区 ---- */
.composer {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: stretch; /* 📎/发送按钮跟随 textarea 等高，输入框长高时按钮一起长 */
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
  background: var(--bar);
}
.archived-notice {
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
  background: var(--bar);
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.input {
  flex: 1;
  min-width: 0;
  resize: none;
  padding: 9px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 16px; /* ≥16px 防 iOS 聚焦自动放大 */
  font-family: inherit;
  line-height: 1.4;
  outline: none;
  overflow-y: auto;
  max-height: 200px; /* autoGrow 长高封顶，超过内部滚动 */
}
.input::placeholder {
  font-size: 13px; /* 比 16px 输入字小一档 */
  color: var(--faint);
}
@media (max-width: 768px) {
  .input::placeholder {
    font-size: 12px; /* 手机端再小一档，保提示一行 */
  }
  /* 手机端头部整治（2026-07-22 截图实锤：members 被挤成右上竖排、名字从中折断、头部占半屏）：
     标题独占第一行并省略号收口；members 移到最后、独占一行横向滑动，不再换行堆高 */
  .head {
    flex-wrap: wrap;
  }
  .head .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head .members {
    order: 10;
    flex-basis: 100%;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none; /* 滑动条不抢视觉（Firefox） */
  }
  .head .members::-webkit-scrollbar {
    display: none;
  }
}
.input:focus {
  border-color: var(--accent);
}
.attach-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--input-bg);
  font-size: 16px;
  cursor: pointer;
}
.attach-btn:disabled {
  opacity: 0.5;
}
.mention-pop {
  position: absolute;
  left: 10px;
  bottom: calc(100% + 4px);
  min-width: 220px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  padding: 4px;
  z-index: 30;
}
.mention-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.mention-item.sel {
  background: var(--chip-bg);
}
.mention-label {
  font-weight: 600;
}
.mention-hint {
  font-size: 11px;
  color: var(--muted);
}
</style>
