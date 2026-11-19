<script setup lang="ts">
// /bots 首页：手机端整屏就是 bot 看板（标题栏 + 卡片网格，与会话页手机端同一套）；
// 桌面端左栏已有列表，这里只放提示。
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import BotCard from '../components/BotCard.vue'
import BotCreateModal from '../components/BotCreateModal.vue'
import { bots, loadBots, type Bot } from '../composables/useBots'

const router = useRouter()
const store = useSessionsStore()
const ui = useUiStore()
const showForm = ref(false)

function open(bot: Bot) {
  router.push(`/bots/${bot.id}`)
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  if (!store.templates.length) await store.refreshTemplates()
  await loadBots()
  timer = setInterval(() => void loadBots(), 10000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <!-- 桌面端：左栏已有列表，内容区只放提示（与会话页同一句） -->
  <div v-if="ui.isDesktop" class="select-hint">← 从左侧选择一个 bot</div>

  <!-- 手机端：整屏看板 -->
  <div v-else class="board">
    <div class="toolbar">
      <h2 class="page-title">Bots</h2>
      <n-button type="primary" size="small" @click="showForm = true">＋ 新建 bot</n-button>
    </div>
    <div class="grid">
      <BotCard v-for="bot in bots" :key="bot.id" :bot="bot" @open="open(bot)" />
    </div>
    <div v-if="!bots.length" class="empty-msg">还没有 bot</div>

    <BotCreateModal v-model:show="showForm" @created="(b: Bot) => router.push(`/bots/${b.id}`)" />
  </div>
</template>

<style scoped>
.board {
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
  gap: 4px;
}
.select-hint {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--faint);
}
.empty-msg {
  padding: 28px 0;
  text-align: center;
  font-size: 13px;
  color: var(--faint);
}
@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
