<script setup lang="ts">
// 快捷键工具条：给触屏补齐 xterm 难按的键（移植旧版 SEQ 表并扩充 Shift+Tab / 粘贴）
import { useMessage } from 'naive-ui'
import { wsClient } from '../ws'

const props = defineProps<{ sessionId: string }>()

const message = useMessage()

const KEYS: { label: string; seq: string; wide?: boolean }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '⇧Tab', seq: '\x1b[Z' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '⏎', seq: '\r' },
]

function sendSeq(seq: string) {
  if (!wsClient.send({ type: 'input', sessionId: props.sessionId, data: seq })) {
    message.warning('连接已断开，按键未送达，正在重连…')
    wsClient.reconnectNow()
  }
}

async function paste() {
  try {
    const text = await navigator.clipboard.readText()
    if (text && !wsClient.send({ type: 'input', sessionId: props.sessionId, data: text })) {
      message.warning('连接已断开，粘贴未送达，正在重连…')
      wsClient.reconnectNow()
    }
  } catch {
    /* 剪贴板权限被拒 */
  }
}
</script>

<template>
  <div class="keybar">
    <button v-for="k in KEYS" :key="k.label" class="key" type="button" @click="sendSeq(k.seq)">
      {{ k.label }}
    </button>
    <button class="key" type="button" @click="paste">粘贴</button>
  </div>
</template>

<style scoped>
.keybar {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  overflow-x: auto;
  background: var(--bar);
  border-top: 1px solid var(--border);
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.keybar::-webkit-scrollbar {
  display: none;
}
.key {
  flex: 0 0 auto;
  min-width: 42px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--key-bg);
  color: var(--text);
  font-size: 13px;
  font-family: ui-monospace, monospace;
  cursor: pointer;
}
.key:active {
  background: var(--hover);
}
</style>
