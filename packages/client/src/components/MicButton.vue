<script setup lang="ts">
// 语音输入按钮：放在附件左边；样式与 attach-btn 同一套尺寸。
const props = defineProps<{ listening: boolean; busy?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <button
    class="mic-btn"
    :class="{ live: props.listening }"
    type="button"
    :disabled="props.disabled || props.busy"
    :title="props.listening ? '停止语音输入' : '语音输入（点击开始说话）'"
    :aria-label="props.listening ? '停止语音输入' : '语音输入'"
    @click="emit('toggle')"
  >
    <svg v-if="!props.listening" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
    <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  </button>
</template>

<style scoped>
.mic-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
}
.mic-btn:hover:not(:disabled) {
  border-color: var(--primary, #0ea373);
}
.mic-btn.live {
  color: #fff;
  background: #e5484d;
  border-color: #e5484d;
}
.mic-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
