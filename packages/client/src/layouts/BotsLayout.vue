<script setup lang="ts">
// Bots 布局：桌面左栏 bot 列表 + 右栏对话，和会话页同一套骨架（2026-11-18）。
import { useUiStore } from '../stores/ui'
import BotSidebar from '../components/BotSidebar.vue'

const ui = useUiStore()
</script>

<template>
  <div v-if="ui.isDesktop" class="split">
    <aside class="sidebar">
      <BotSidebar />
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
  <router-view v-else />
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
