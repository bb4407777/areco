<script setup lang="ts">
// 看板：会话卡片网格 + 新建会话 + 已归档折叠区 + 空状态引导
// 桌面端在 SessionLayout 侧边栏已显示会话列表，本页仅在内容区显示欢迎/空状态
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NEmpty, useDialog, useMessage } from 'naive-ui'
import type { SessionSummary } from '../../../shared/protocol'
import { useSessionsStore } from '../stores/sessions'
import { useRoomsStore } from '../stores/rooms'
import { useUiStore } from '../stores/ui'
import { sessionEntryPath } from '../utils/format'
import { groupSessionsByRoom } from '../utils/sessionGroups'
import SessionCard from '../components/SessionCard.vue'
import SpawnDialog from '../components/SpawnDialog.vue'
import { useRenameDialog } from '../composables/useRenameDialog'

const store = useSessionsStore()
const roomsStore = useRoomsStore()
const ui = useUiStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const { openRename } = useRenameDialog()

const showSpawn = ref(false)
const showArchived = ref(false)
const now = ref(Date.now())
let ticker: number | null = null

// 手机看板会话分项目（与桌面侧栏共用 utils/sessionGroups 规则）；
// rooms 未加载时静默拉一次（旧服务端 404 也无碍，分组退化为全零散）
const grouping = computed(() => groupSessionsByRoom(roomsStore.rooms, store.boardSessions))
/** 展开的项目分组 id 集（默认全部收起，与已归档同交互，2026-07-22 维护者定） */
const expandedGroups = ref<Set<string>>(new Set())

function toggleGroup(id: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedGroups.value = next
}

// 新建会话落点按设置页「新建会话默认显示模式」偏好（无落盘的 shell 类仍进终端）；
// 直接用 spawn 返回的会话对象——store 靠 ws 推送，此刻 byId 还查不到
function openSpawned(s: SessionSummary) {
  router.push(sessionEntryPath(s.id, store.byId(s.id) ?? s, store.templates, ui.newSessionView))
}

onMounted(() => {
  if (!roomsStore.loaded) roomsStore.refresh().catch(() => {})
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker)
})

// 点卡片按偏好进入
function open(id: string) {
  router.push(sessionEntryPath(id, store.byId(id), store.templates, ui.sessionView))
}

async function run(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function archive(id: string) {
  void run(async () => {
    await store.archive(id)
    message.success('已归档，可在「已归档」中查看')
  })
}

function unarchive(id: string) {
  void run(async () => {
    await store.unarchive(id)
    message.success('已恢复到看板')
  })
}

function confirmRemove(id: string, name: string) {
  const s = store.byId(id)
  const running = !!s && ['running', 'spawning', 'stopping'].includes(s.status)
  dialog.warning({
    title: '删除会话',
    content: `删除「${name}」？卡片与终端快照将永久清除（agent 对话日志不受影响，仍可在「历史」页查看）。${running ? '会话运行中，将先终止进程。' : ''}只想移出看板可改用「归档」。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => run(() => store.remove(id)),
  })
}

function handoff(id: string, templateId: string) {
  void run(async () => {
    const session = await store.handoff(id, templateId)
    message.success('已交接给新会话')
    router.push(`/session/${session.id}`)
  })
}
</script>

<template>
  <!-- 桌面端：侧边栏已有会话列表，内容区显示欢迎/空状态 -->
  <div v-if="ui.isDesktop" class="desktop-welcome">
    <n-empty v-if="!store.sessions.length" description="还没有会话">
      <template #extra>
        <n-button type="primary" size="small" @click="showSpawn = true">新建会话</n-button>
      </template>
    </n-empty>
    <div v-else class="select-hint">← 从左侧选择一个会话</div>
  </div>

  <!-- 手机端：完整看板 -->
  <div v-else class="dashboard">
    <div class="toolbar">
      <h2 class="page-title">会话</h2>
      <n-button type="primary" size="small" @click="showSpawn = true">＋ 新建会话</n-button>
    </div>

    <n-empty v-if="store.ready && !store.sessions.length" description="还没有会话" class="empty">
      <template #extra>
        <n-button type="primary" @click="showSpawn = true">启动第一个 agent</n-button>
      </template>
    </n-empty>

    <template v-else>
      <!-- 零散会话（未归入任何项目分组） -->
      <TransitionGroup v-if="grouping.loose.length" tag="div" name="cards" class="grid">
        <SessionCard
          v-for="session in grouping.loose"
          :key="session.id"
          :session="session"
          :now="now"
          @open="open(session.id)"
          @stop="run(() => store.stop(session.id))"
          @kill="run(() => store.kill(session.id))"
          @restart="(resume) => run(() => store.restart(session.id, resume))"
          @rename="openRename(session.id, session.name)"
          @pin="(pinned) => run(() => store.pin(session.id, pinned))"
          @archive="archive(session.id)"
          @remove="confirmRemove(session.id, session.name)"
          @handoff="(templateId) => handoff(session.id, templateId)"
        />
      </TransitionGroup>

      <!-- 项目分组：各项目的会话收在自己分类下（规则与桌面侧栏一致；默认收起，点开才看） -->
      <section v-for="g in grouping.groups" :key="g.id" class="group-section">
        <button type="button" class="group-toggle" :aria-expanded="expandedGroups.has(g.id)" @click="toggleGroup(g.id)">
          <span class="archived-caret">{{ expandedGroups.has(g.id) ? '▾' : '▸' }}</span>
          <span>{{ g.name }}（{{ g.sessions.length }}）</span>
        </button>
        <TransitionGroup v-if="expandedGroups.has(g.id)" tag="div" name="cards" class="grid">
          <SessionCard
            v-for="session in g.sessions"
            :key="session.id"
            :session="session"
            :now="now"
            @open="open(session.id)"
            @stop="run(() => store.stop(session.id))"
            @kill="run(() => store.kill(session.id))"
            @restart="(resume) => run(() => store.restart(session.id, resume))"
            @rename="openRename(session.id, session.name)"
            @pin="(pinned) => run(() => store.pin(session.id, pinned))"
            @archive="archive(session.id)"
            @remove="confirmRemove(session.id, session.name)"
            @handoff="(templateId) => handoff(session.id, templateId)"
          />
        </TransitionGroup>
      </section>

      <div v-if="!store.boardSessions.length && store.ready && !store.archivedSessions.length" class="board-cleared">看板已清空</div>

      <section v-if="store.archivedSessions.length" class="archived-section">
        <button
          type="button"
          class="archived-toggle"
          :aria-expanded="showArchived"
          @click="showArchived = !showArchived"
        >
          <span class="archived-caret">{{ showArchived ? '▾' : '▸' }}</span>
          <span>已归档（{{ store.archivedSessions.length }}）</span>
        </button>
        <TransitionGroup v-if="showArchived" tag="div" name="cards" class="grid archived-grid">
          <SessionCard
            v-for="session in store.archivedSessions"
            :key="session.id"
            :session="session"
            :now="now"
            @open="open(session.id)"
            @restart="(resume) => run(() => store.restart(session.id, resume))"
            @rename="openRename(session.id, session.name)"
            @pin="(pinned) => run(() => store.pin(session.id, pinned))"
            @unarchive="unarchive(session.id)"
            @remove="confirmRemove(session.id, session.name)"
            @handoff="(templateId) => handoff(session.id, templateId)"
          />
        </TransitionGroup>
      </section>
    </template>

    <SpawnDialog v-model:show="showSpawn" @spawned="openSpawned" />
  </div>
</template>

<style scoped>
.desktop-welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.select-hint {
  font-size: 14px;
  color: var(--faint);
}
.dashboard {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 16px calc(20px + env(safe-area-inset-bottom, 0px));
  max-width: 1080px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.page-title {
  margin: 0;
  font-size: 17px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 12px;
}
.cards-move {
  transition: transform 220ms var(--ease-in-out);
}
.cards-enter-active {
  transition:
    opacity 200ms var(--ease-out),
    transform 200ms var(--ease-out);
}
.cards-enter-from {
  opacity: 0;
  transform: scale(0.97);
}
.empty {
  margin-top: 15vh;
}
.board-cleared {
  padding: 28px 0;
  text-align: center;
  font-size: 13px;
  color: var(--faint);
}
.archived-section {
  margin-top: 18px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.archived-toggle {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 2px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.archived-caret {
  width: 14px;
  flex: 0 0 auto;
  color: var(--faint);
}
.archived-grid {
  margin-top: 8px;
}
.group-section {
  margin-top: 10px;
}
.group-toggle {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 2px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .cards-move {
    transition: none !important;
  }
}
</style>
