<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal'
import { useUiStore } from '../stores/ui'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sessionId: string }>()

const el = ref<HTMLElement | null>(null)
const ui = useUiStore()
const terminal = useTerminal(props.sessionId)

onMounted(() => {
  if (el.value) terminal.mount(el.value)
})
onBeforeUnmount(() => terminal.unmount())

watch(
  () => ui.fontSize,
  (size) => terminal.setFontSize(size)
)
watch(
  () => ui.theme,
  (theme) => terminal.setColorTheme(theme)
)

defineExpose({
  focus: terminal.focus,
  fitNow: terminal.fitNow,
  attach: terminal.attach,
  scrollToBottom: terminal.scrollToBottom,
})
</script>

<template>
  <div ref="el" class="terminal-pane" />
</template>

<style scoped>
.terminal-pane {
  position: absolute;
  inset: 0;
  padding: 6px 2px 2px 8px;
  background: var(--term-bg);
  overflow: hidden;
  /* 终端内部自己滚动，隔离页面手势 */
  touch-action: none;
  overscroll-behavior: contain;
}
.terminal-pane :deep(.xterm) {
  height: 100%;
}
</style>
