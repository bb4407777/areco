<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, useDialog, useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'
import { useRoomsStore } from '../stores/rooms'
import { useUiStore } from '../stores/ui'
import { useRenameDialog } from '../composables/useRenameDialog'
import type { SessionSummary } from '../../../shared/protocol'
import { chatCapable, sessionEntryPath, templateColor, templateLabel, trafficColor, STATUS_TEXT } from '../utils/format'
import { groupSessionsByRoom } from '../utils/sessionGroups'

const store = useSessionsStore()
const roomsStore = useRoomsStore()
const ui = useUiStore()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const { openRename } = useRenameDialog()

const emit = defineEmits<{ new: [] }>()

const activeId = computed(() => route.params.id as string | undefined)
const showArchived = ref(false)
/** 展开的项目分组 id 集（默认全部收起，与已归档同交互：点组头才展开，2026-07-22 维护者定） */
const expandedGroups = ref<Set<string>>(new Set())

// 看板侧栏也要项目分组：rooms 由项目页以外入口打开时可能尚未加载，静默拉一次（旧服务端 404 也无碍）
onMounted(() => {
  if (!roomsStore.loaded) roomsStore.refresh().catch(() => {})
})

/**
 * 项目分组（规则集中在 utils/sessionGroups，与手机看板共用）：
 * 组内与零散区都跟随 boardSessions 的「运行优先 + 最后活动倒序」。
 */
const grouping = computed(() => groupSessionsByRoom(roomsStore.rooms, store.boardSessions))
const projectGroups = computed(() => grouping.value.groups)
const looseSessions = computed(() => grouping.value.loose)

function toggleGroup(id: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedGroups.value = next
}

function open(id: string) {
  router.push(sessionEntryPath(id, store.byId(id), store.templates, ui.sessionView))
}

function dotColor(s: SessionSummary): string {
  return trafficColor(s.trafficState, s.status)
}

// 换 agent 接手候选：全部启用的非 shell 模板（与看板卡片/终端页同口径）
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])
const handoffChildren = computed(() =>
  store.templates
    .filter((t) => t.enabled && !SHELLS.has(t.command.split('/').pop() ?? ''))
    .map((t) => ({ label: `用 ${t.name} 接手`, key: `handoff:${t.id}` })),
)

// 侧栏项操作菜单（对齐手机端 SessionCard）：rename/stop/kill/restart/resume/handoff/pin/archive/unarchive/remove
function menuFor(s: SessionSummary) {
  const live = ['running', 'spawning', 'stopping'].includes(s.status)
  const options: { label: string; key: string }[] = [{ label: '重命名', key: 'rename' }]
  if (live) {
    options.push({ label: '停止（SIGTERM）', key: 'stop' })
    options.push({ label: '强制终止（SIGKILL）', key: 'kill' })
  } else {
    options.push(
      chatCapable(s, store.templates)
        ? { label: '重新启动（恢复对话）', key: 'resume' }
        : { label: '重新启动', key: 'restart' },
    )
    for (const t of handoffChildren.value) options.push(t)
  }
  options.push(s.pinned ? { label: '取消总台钉选', key: 'unpin' } : { label: '钉为总台（房间加成员置顶）', key: 'pin' })
  // 归档/恢复对所有状态开放（运行中也能归档，与运行中能删除同口径）
  options.push(
    s.archived
      ? { label: '恢复到看板', key: 'unarchive' }
      : { label: '归档（移出看板，保留记录）', key: 'archive' },
  )
  options.push({ label: '删除会话', key: 'remove' })
  return options
}

async function run(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function confirmRemove(id: string, name: string) {
  dialog.warning({
    title: '删除会话',
    content: `确定删除「${name}」？记录将移除，无法恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => run(() => store.remove(id)),
  })
}

function onMenu(key: string, s: SessionSummary) {
  const id = s.id
  if (key === 'rename') openRename(id, s.name)
  else if (key === 'stop') void run(() => store.stop(id))
  else if (key === 'kill') void run(() => store.kill(id))
  else if (key === 'restart') void run(() => store.restart(id, false))
  else if (key === 'resume') void run(() => store.restart(id, true))
  else if (key === 'archive') void run(() => store.archive(id))
  else if (key === 'pin' || key === 'unpin') void run(() => store.pin(id, key === 'pin'))
  else if (key === 'unarchive') void run(() => store.unarchive(id))
  else if (key === 'remove') confirmRemove(id, s.name)
  else if (key.startsWith('handoff:')) {
    void run(async () => {
      const next = await store.handoff(id, key.slice(8))
      message.success('已交接给新会话')
      router.replace(`/session/${next.id}`)
    })
  }
}
</script>

<template>
  <div class="sidebar-panel">
    <div class="sidebar-head">
      <span class="sidebar-title">会话</span>
      <n-button size="tiny" type="primary" @click="emit('new')">＋ 新建</n-button>
    </div>
    <div class="sidebar-list">
      <!-- 零散会话（未归入任何项目分组） -->
      <div
        v-for="s in looseSessions"
        :key="s.id"
        :class="['sidebar-item', { active: s.id === activeId }]"
        @click="open(s.id)"
      >
        <span class="item-dot" :style="{ background: dotColor(s) }" />
        <div class="item-body">
          <span class="item-name">{{ s.name }}</span>
          <!-- 终端 lastLine 对空闲会话恒为状态栏噪音（context %/bypass permissions），改示 agent/模型 -->
          <span class="item-preview" :style="{ color: templateColor(s, store.templates) }">{{ templateLabel(s, store.templates) }}</span>
        </div>
        <span class="item-status">{{ STATUS_TEXT[s.status] }}</span>
        <n-dropdown trigger="click" :options="menuFor(s)" @select="(k: string) => onMenu(k, s)">
          <n-button size="tiny" quaternary circle class="item-menu" @click.stop>⋯</n-button>
        </n-dropdown>
      </div>

      <!-- 项目分组：各项目的会话收在自己分类下，不与零散会话混排（默认收起，点开才看） -->
      <div v-for="g in projectGroups" :key="g.id" class="group-section">
        <button class="group-toggle" type="button" @click="toggleGroup(g.id)">
          <span class="caret">{{ expandedGroups.has(g.id) ? '▾' : '▸' }}</span>
          {{ g.name }}（{{ g.sessions.length }}）
        </button>
        <template v-if="expandedGroups.has(g.id)">
          <div
            v-for="s in g.sessions"
            :key="s.id"
            :class="['sidebar-item', { active: s.id === activeId }]"
            @click="open(s.id)"
          >
            <span class="item-dot" :style="{ background: dotColor(s) }" />
            <div class="item-body">
              <span class="item-name">{{ s.name }}</span>
              <span class="item-preview" :style="{ color: templateColor(s, store.templates) }">{{ templateLabel(s, store.templates) }}</span>
            </div>
            <span class="item-status">{{ STATUS_TEXT[s.status] }}</span>
            <n-dropdown trigger="click" :options="menuFor(s)" @select="(k: string) => onMenu(k, s)">
              <n-button size="tiny" quaternary circle class="item-menu" @click.stop>⋯</n-button>
            </n-dropdown>
          </div>
        </template>
      </div>

      <div v-if="!store.boardSessions.length && !store.archivedSessions.length" class="empty-msg">还没有会话</div>

      <!-- 已归档折叠区 -->
      <div v-if="store.archivedSessions.length" class="archived-section">
        <button class="archived-toggle" type="button" @click="showArchived = !showArchived">
          <span class="caret">{{ showArchived ? '▾' : '▸' }}</span>
          已归档（{{ store.archivedSessions.length }}）
        </button>
        <template v-if="showArchived">
          <div
            v-for="s in store.archivedSessions"
            :key="s.id"
            :class="['sidebar-item archived-item', { active: s.id === activeId }]"
            @click="open(s.id)"
          >
            <span class="item-dot" :style="{ background: dotColor(s) }" />
            <div class="item-body">
              <span class="item-name">{{ s.name }}</span>
              <span class="item-preview" :style="{ color: templateColor(s, store.templates) }">{{ templateLabel(s, store.templates) }}</span>
            </div>
            <n-dropdown trigger="click" :options="menuFor(s)" @select="(k: string) => onMenu(k, s)">
              <n-button size="tiny" quaternary circle class="item-menu" @click.stop>⋯</n-button>
            </n-dropdown>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.sidebar-title {
  font-weight: 700;
  font-size: 15px;
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.12s;
}
.sidebar-item:hover {
  background: var(--chip-bg);
}
.sidebar-item.active {
  background: var(--chip-bg);
  border-left-color: var(--accent);
}
.sidebar-item.archived-item {
  opacity: 0.7;
}
.item-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
}
.item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-preview {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-status {
  font-size: 11px;
  color: var(--faint);
  flex: 0 0 auto;
}
/* 操作菜单按钮：常驻低调可点（兼顾触屏笔记本无 hover），hover/选中时加深 */
.item-menu {
  flex: 0 0 auto;
  color: var(--faint);
  opacity: 0.5;
  transition: opacity 0.12s;
}
.sidebar-item:hover .item-menu,
.sidebar-item.active .item-menu {
  opacity: 1;
  color: var(--muted);
}
.empty-msg {
  padding: 24px 14px;
  text-align: center;
  font-size: 13px;
  color: var(--faint);
}
.archived-section {
  border-top: 1px solid var(--border);
  margin-top: 4px;
  padding-top: 4px;
}
.group-section {
  border-top: 1px solid var(--border);
  margin-top: 4px;
  padding-top: 4px;
}
.group-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.group-toggle:hover {
  background: var(--chip-bg);
}
.archived-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.archived-toggle:hover {
  background: var(--chip-bg);
}
.caret {
  display: inline-block;
  width: 10px;
  flex: 0 0 auto;
}
</style>
