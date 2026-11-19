<script setup lang="ts">
// Bot 左栏：样式与会话侧栏同一套（圆点 + 名字 + 类型·身份 + 状态 + ⋯），数据来自 /api/bots。
// 点一项进 /bots/:id，唤醒在详情页做——列表本身不碰进程（2026-11-18）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, useMessage } from 'naive-ui'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import BotCreateModal from './BotCreateModal.vue'
import { botDotColor, botStatusText, botSubtitle, bots, loadBots, type Bot } from '../composables/useBots'

const route = useRoute()
const router = useRouter()
const store = useSessionsStore()
const message = useMessage()

const activeId = computed(() => (route.params.id ? String(route.params.id) : ''))
const showForm = ref(false)

function open(bot: Bot) {
  router.push(`/bots/${bot.id}`)
}

function menuFor() {
  return [
    { label: '打开', key: 'open' },
    { label: '睡下（停进程，记录留着）', key: 'sleep' },
    { label: '删除 bot（会话保留）', key: 'remove' },
  ]
}

async function onMenu(key: string, bot: Bot) {
  if (key === 'open') return open(bot)
  try {
    if (key === 'sleep') {
      await api.post(`/api/bots/${bot.id}/sleep`)
      message.success(`「${bot.name}」已睡`)
    } else if (key === 'remove') {
      await api.del(`/api/bots/${bot.id}`)
      if (activeId.value === bot.id) router.push('/bots')
    }
    await loadBots()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
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
  <div class="bot-panel">
    <div class="bot-head">
      <span class="bot-title">Bots</span>
      <n-button size="tiny" type="primary" @click="showForm = true">＋ 新建</n-button>
    </div>
    <div class="bot-list">
      <div
        v-for="bot in bots"
        :key="bot.id"
        :class="['bot-item', { active: bot.id === activeId, asleep: !bot.sessionId }]"
        @click="open(bot)"
      >
        <span class="item-dot" :style="{ background: botDotColor(bot) }" />
        <div class="item-body">
          <span class="item-name">{{ bot.pinned ? '⭐ ' : '' }}{{ bot.name }}</span>
          <span class="item-preview">{{ botSubtitle(bot) }}</span>
        </div>
        <span class="item-status">{{ botStatusText(bot) }}</span>
        <n-dropdown trigger="click" :options="menuFor()" @select="(k: string) => onMenu(k, bot)">
          <n-button size="tiny" quaternary circle class="item-menu" @click.stop>⋯</n-button>
        </n-dropdown>
      </div>
      <div v-if="!bots.length" class="empty-msg">还没有 bot</div>
    </div>

    <BotCreateModal v-model:show="showForm" @created="(b: Bot) => router.push(`/bots/${b.id}`)" />
  </div>
</template>

<style scoped>
.bot-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.bot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.bot-title {
  font-weight: 700;
  font-size: 15px;
}
.bot-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.bot-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.12s;
}
.bot-item:hover {
  background: var(--chip-bg);
}
.bot-item.active {
  background: var(--chip-bg);
  border-left-color: var(--accent, #10a37f);
}
.bot-item.asleep .item-name {
  color: var(--muted);
}
.item-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
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
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-status {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--faint);
}
.item-menu {
  color: var(--muted);
}
.empty-msg {
  padding: 24px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--faint);
}
</style>
