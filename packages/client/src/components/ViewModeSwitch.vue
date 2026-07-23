<script setup lang="ts">
// 座舱显示模式分段切换：终端（pty 画面）/ 对话（transcript 聊天流），两页头部共用
import type { SessionViewMode } from '../stores/ui'

defineProps<{ mode: SessionViewMode }>()
const emit = defineEmits<{ switch: [mode: SessionViewMode] }>()
</script>

<template>
  <div class="mode-switch" role="tablist">
    <button
      role="tab"
      :aria-selected="mode === 'terminal'"
      :class="{ active: mode === 'terminal' }"
      @click="mode !== 'terminal' && emit('switch', 'terminal')"
    >
      ⌨️ 终端
    </button>
    <button
      role="tab"
      :aria-selected="mode === 'chat'"
      :class="{ active: mode === 'chat' }"
      @click="mode !== 'chat' && emit('switch', 'chat')"
    >
      💬 对话
    </button>
  </div>
</template>

<style scoped>
.mode-switch {
  display: flex;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--chip-bg);
}
.mode-switch button {
  border: none;
  background: none;
  padding: 3px 9px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  touch-action: manipulation;
}
.mode-switch button.active {
  background: var(--panel);
  color: var(--text);
  font-weight: 600;
}
</style>
