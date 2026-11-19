<script setup lang="ts">
// bot 卡片：与会话卡片同一套排版（状态点 + 名字 + 状态标签 + ⋯；第二行模板名；底行 cwd + 时间）。
// 手机看板用它，桌面仍用左栏——两处数据同源（composables/useBots），样式同会话（2026-11-18）。
import { computed } from 'vue'
import { NButton, NDropdown, NTag, useMessage } from 'naive-ui'
import { api } from '../api'
import { shortPath } from '../utils/format'
import { botDotColor, botOpcLine, botStatusText, loadBots, type Bot } from '../composables/useBots'

const props = defineProps<{ bot: Bot }>()
const emit = defineEmits<{ open: []; refresh: [] }>()

const message = useMessage()

const dot = computed(() => botDotColor(props.bot))
const status = computed(() => botStatusText(props.bot))
const opcLine = computed(() => botOpcLine(props.bot))
const asleep = computed(() => !props.bot.sessionId)
/** 一行待办摘要：卡片上比模板名有用。抬头已有名字，标题里的「案号 名字：」不再重复 */
const todoLine = computed(() => {
  const names = new Set(
    [props.bot.name, props.bot.name.replace(/^\d{2}[民刑行执非咨代][\u4e00-\u9fa5]{1,2}\d{3,4}\s*/, '')]
      .map((n) => n.trim())
      .filter(Boolean),
  )
  const strip = (title: string) => {
    let s = title.trim().replace(/^\d{2}[民刑行执非咨代][\u4e00-\u9fa5]{1,2}\d{3,4}\s*/, '')
    for (const n of names) s = s.replace(new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`), '')
    return s
  }
  return (props.bot.todos ?? []).map(strip).filter(Boolean).join(' · ')
})

const menuOptions = computed(() => [
  { label: '打开', key: 'open' },
  { label: '睡下（停进程，记录留着）', key: 'sleep' },
  { label: '删除 bot（会话保留）', key: 'remove' },
])

async function onMenu(key: string) {
  if (key === 'open') return emit('open')
  try {
    if (key === 'sleep') {
      await api.post(`/api/bots/${props.bot.id}/sleep`)
      message.success(`「${props.bot.name}」已睡`)
    } else if (key === 'remove') {
      await api.del(`/api/bots/${props.bot.id}`)
      message.success(`已删除 bot「${props.bot.name}」`)
    }
    await loadBots()
    emit('refresh')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="card" :class="{ dead: asleep }" @click="emit('open')">
    <div class="card-head">
      <span class="dot" :style="{ background: dot, boxShadow: `0 0 0 3px ${dot}22` }" />
      <span class="name">{{ bot.pinned ? '⭐ ' : '' }}{{ bot.name }}</span>
      <n-tag size="small" :bordered="false" class="status-tag" :style="{ color: dot }">{{ status }}</n-tag>
      <span class="spacer" />
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button size="tiny" quaternary circle class="menu-btn" @click.stop>⋯</n-button>
      </n-dropdown>
    </div>
    <div v-if="todoLine" class="todo-line">{{ todoLine }}</div>
    <div v-if="opcLine" class="opc">{{ opcLine }}</div>
    <div class="card-foot">
      <span class="cwd">{{ shortPath(bot.cwd) }}</span>
    </div>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 14px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  cursor: pointer;
  transition:
    border-color 0.15s,
    transform 160ms var(--ease-out);
  min-width: 0;
}
.card:hover {
  border-color: var(--border-strong);
}
.card:active {
  transform: scale(0.98);
}
.card.dead {
  opacity: 0.75;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.name {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.status-tag {
  flex: 0 0 auto;
  background: var(--chip-bg);
  font-size: 11px;
}
.spacer {
  flex: 1;
}
.menu-btn {
  color: var(--muted);
}
.opc {
  font-size: 11px;
  color: #b45309;
  letter-spacing: 0.02em;
}

.card-foot {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--faint);
  min-width: 0;
}
.cwd {
  font-family: ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.todo-line {
  margin-top: -4px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
