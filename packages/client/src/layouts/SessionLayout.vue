<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import type { SessionSummary } from '../../../shared/protocol'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { sessionEntryPath } from '../utils/format'
import SessionSidebar from '../components/SessionSidebar.vue'
import SpawnDialog from '../components/SpawnDialog.vue'

const store = useSessionsStore()
const ui = useUiStore()
const router = useRouter()
const showSpawn = ref(false)

// 新建会话落点按设置页「新建会话默认显示模式」偏好（无落盘的 shell 类仍进终端）；
// 直接用 spawn 返回的会话对象——store 靠 ws 推送，此刻 byId 还查不到
function openSpawned(s: SessionSummary) {
  router.push(sessionEntryPath(s.id, store.byId(s.id) ?? s, store.templates, ui.newSessionView))
}
</script>

<template>
  <div v-if="ui.isDesktop" class="split">
    <aside class="sidebar">
      <SessionSidebar @new="showSpawn = true" />
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
  <router-view v-else />

  <SpawnDialog v-model:show="showSpawn" @spawned="openSpawned" />
</template>

<style scoped>
.split {
  flex: 1;
  min-height: 0;
  display: flex;
}
.sidebar {
  width: 300px;
  flex: 0 0 auto;
  border-right: 1px solid var(--border);
  background: var(--bar);
  display: flex;
  flex-direction: column;
}
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
