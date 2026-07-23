<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '../stores/ui'
import SessionSidebar from '../components/SessionSidebar.vue'
import SpawnDialog from '../components/SpawnDialog.vue'

const ui = useUiStore()
const router = useRouter()
const showSpawn = ref(false)

function openTerminal(id: string) {
  router.push(`/session/${id}`)
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

  <SpawnDialog v-model:show="showSpawn" @spawned="openTerminal" />
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
