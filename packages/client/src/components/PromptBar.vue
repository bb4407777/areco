<script setup lang="ts">
// prompt 输入：自动增高 textarea（文本多了完整换行显示），Enter 发送/Shift+Enter 换行，IME isComposing 防误发，本地历史上翻
// 附件：📎 选文件/整卡拖拽 → 上传落盘 Mac（data/uploads/<日期>/）→ 绝对路径回填输入框，agent 拿路径即可读
// 拖文件夹不上传内容：服务端 Spotlight 按名定位源目录路径回填（见 useFileDrop）
import { ref, watch, nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import { wsClient } from '../ws'
import { useUiStore } from '../stores/ui'
import { useFileDrop } from '../composables/useFileDrop'
import FileDropOverlay from './FileDropOverlay.vue'

const props = defineProps<{ sessionId: string; disabled?: boolean }>()

const ui = useUiStore()
const message = useMessage()
const text = ref(ui.drafts[props.sessionId] ?? '')
const historyIndex = ref(-1)

// 会话切换：存下旧会话草稿，恢复新会话草稿（切视图组件卸载也不丢，草稿在 store 内存里）
watch(() => props.sessionId, (id, prevId) => {
  if (prevId) ui.setDraft(prevId, text.value)
  text.value = ui.drafts[id] ?? ''
  historyIndex.value = -1
})

// 输入变化实时回写草稿：切视图触发组件卸载前草稿已在 store，切回即恢复
watch(text, (v) => ui.setDraft(props.sessionId, v))

function send() {
  if (props.disabled) return
  const value = text.value
  // WS 断开时 send 返回 false：保留输入框内容，触发立即重连，别静默丢字
  if (!wsClient.send({ type: 'sendline', sessionId: props.sessionId, text: value })) {
    message.warning('连接已断开，正在重连——文字已保留，稍后再按发送')
    wsClient.reconnectNow()
    return
  }
  if (value.trim()) ui.rememberPrompt(value)
  text.value = ''
  historyIndex.value = -1
}

const promptInput = ref<HTMLTextAreaElement | null>(null)
const MAX_INPUT_HEIGHT = 200 // textarea 自增到 ~8 行封顶，再高内部滚动，不顶掉整个底栏

// 文本变长时 textarea 自动长高，空内容回到单行；程序性赋值（上传回填/历史/清空）靠 watch 触发
function autoGrow() {
  const el = promptInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
}
watch(text, () => nextTick(autoGrow))

// 文件拖放/选件上传（document 级拖放 + 文件夹递归 + 落盘回填），逻辑在 useFileDrop
const { dragging, uploading, fileInputEl, pickFiles, onInputChange } = useFileDrop({
  text,
  inputEl: promptInput,
  afterFill: autoGrow,
})

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
    return
  }
  if (e.key === 'ArrowUp' && !text.value) {
    const next = Math.min(historyIndex.value + 1, ui.promptHistory.length - 1)
    if (next >= 0 && ui.promptHistory[next] !== undefined) {
      historyIndex.value = next
      text.value = ui.promptHistory[next]!
      e.preventDefault()
    }
    return
  }
  if (e.key === 'ArrowDown' && historyIndex.value >= 0) {
    const next = historyIndex.value - 1
    historyIndex.value = next
    text.value = next >= 0 ? (ui.promptHistory[next] ?? '') : ''
    e.preventDefault()
  }
}
</script>

<template>
  <div class="promptbar">
    <input ref="fileInputEl" type="file" multiple hidden @change="onInputChange" />
    <button
      class="attach-btn"
      type="button"
      :disabled="uploading"
      title="上传文件到 Mac，路径填入输入框"
      @click="pickFiles"
    >
      {{ uploading ? '⏳' : '📎' }}
    </button>
    <textarea
      ref="promptInput"
      v-model="text"
      class="prompt-input"
      rows="1"
      :placeholder="disabled ? '会话未在运行' : ui.isMobile ? '输入内容，回车发送…' : '输入内容，回车发送（Shift+回车换行）…'"
      :disabled="disabled"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      enterkeyhint="send"
      @keydown="onKeydown"
    ></textarea>
    <button class="send-btn" type="button" :disabled="disabled" @click="send">发送</button>
  </div>
  <FileDropOverlay :visible="dragging" />
</template>

<style scoped>
.promptbar {
  display: flex;
  align-items: stretch; /* 📎/发送按钮跟随 textarea 等高，输入框长高时按钮一起长 */
  gap: 8px;
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
  background: var(--bar);
  border-top: 1px solid var(--border);
}
.attach-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--input-bg);
  font-size: 16px;
  cursor: pointer;
}
.attach-btn:disabled {
  opacity: 0.5;
}
.prompt-input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 16px; /* ≥16px 防 iOS 聚焦自动放大 */
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  line-height: 1.4;
  outline: none;
  resize: none; /* 高度由 autoGrow 控制，禁用户手动拖拽 */
  overflow-y: auto;
  max-height: 200px; /* 与 MAX_INPUT_HEIGHT 对齐，超过则内部滚动 */
}
.prompt-input::placeholder {
  font-size: 13px; /* 比 16px 输入字小一档，长提示少占宽 */
  color: var(--faint);
}
@media (max-width: 768px) {
  .prompt-input::placeholder {
    font-size: 12px; /* 手机端再小一档，保提示一行不换行 */
  }
}
.prompt-input:focus {
  border-color: var(--accent);
}
.prompt-input:disabled {
  opacity: 0.5;
}
.send-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border: 0;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 160ms var(--ease-out);
}
.send-btn:active {
  transform: scale(0.97);
}
.send-btn:disabled {
  opacity: 0.4;
}
</style>
