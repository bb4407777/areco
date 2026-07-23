<script setup lang="ts">
// 单条 transcript 气泡：markdown 渲染 + 代码高亮，thinking/tool_use/tool_result 折叠块
import { computed, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
// hljs 主题样式在 main.ts 按亮/暗动态注入
import type { TranscriptMessage } from '../../../shared/protocol'
import { copyPlainText } from '../utils/clipboard'
import { extractFileLinks, iconFor, type FileLink } from '../utils/filelinks'
import { fmtFullTime } from '../utils/format'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ message: TranscriptMessage; agentLabel?: string }>()
const emit = defineEmits<{ preview: [path: string] }>()
const ui = useUiStore()

// 复制回复：双通道实现在 utils/clipboard（GroupChatView 项目消息同用）
const copied = ref(false)
let copyTimer: number | null = null

const copyText = computed(() =>
  visibleParts.value
    .filter((p) => p.kind === 'text' || p.kind === 'notice')
    .map((p) => p.text)
    .join('\n\n')
    .trim(),
)

async function copyReply() {
  const text = copyText.value
  if (!text) return
  await copyPlainText(text)
  copied.value = true
  if (copyTimer !== null) clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copied.value = false
    copyTimer = null
  }, 1200)
}

// 设置开关：思考/工具调用/工具结果默认全关，勾选才显示；过滤后无可见段则整条不渲染
const visibleParts = computed(() =>
  props.message.parts.filter((p) => {
    if (p.kind === 'thinking') return ui.showThinking
    if (p.kind === 'tool_use') return ui.showToolUse
    if (p.kind === 'tool_result') return ui.showToolResult
    return true
  }),
)

// 右侧只放真人指令：role=user 且带 text 段才算用户泡泡；tool_result/notice（子 agent 回报、
// cron 触发等合成 user 消息）一律归左侧（2026-07-23 维护者定：只有用户命令消息放用户侧）
const displayRole = computed(() =>
  props.message.role === 'user' && props.message.parts.some((part) => part.kind === 'text')
    ? 'user'
    : 'assistant'
)

// 把整条消息（所有 text 段 + tool_result 段）里的文件路径汇总去重成 chip
const fileLinks = computed<FileLink[]>(() => {
  const seen = new Set<string>()
  const out: FileLink[] = []
  for (const part of visibleParts.value) {
    const text = part.kind === 'text' || part.kind === 'tool_result' ? part.text : ''
    for (const link of extractFileLinks(text)) {
      if (seen.has(link.path)) continue
      seen.add(link.path)
      out.push(link)
    }
  }
  return out
})

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      }
      return hljs.highlightAuto(code).value
    } catch {
      return ''
    }
  },
})

const time = computed(() => (props.message.timestamp ? fmtFullTime(props.message.timestamp) : ''))

function render(text: string): string {
  return md.render(text)
}
</script>

<template>
  <div v-if="visibleParts.length" class="msg" :class="displayRole">
    <div class="msg-col">
      <!-- 统一版式（与项目消息一致）：发送者名在泡泡上方；复制在泡泡下方左侧；完整时间在右下角 -->
      <div v-if="agentLabel && displayRole === 'assistant'" class="msg-meta">
        <span class="from">{{ agentLabel }}</span>
      </div>
      <div class="bubble">
        <template v-for="(part, i) in visibleParts" :key="i">
          <!-- eslint-disable-next-line vue/no-v-html — markdown-it html:false 已转义原始 HTML -->
          <div v-if="part.kind === 'text'" class="md" v-html="render(part.text)" />
          <!-- eslint-disable-next-line vue/no-v-html — markdown-it html:false 已转义原始 HTML -->
          <div v-else-if="part.kind === 'notice'" class="md notice" v-html="render(part.text)" />
          <details v-else-if="part.kind === 'thinking'" class="fold thinking">
            <summary>思考过程</summary>
            <pre>{{ part.text }}</pre>
          </details>
          <details v-else-if="part.kind === 'tool_use'" class="fold tool">
            <summary>🔧 {{ part.name }}</summary>
            <pre>{{ part.input }}</pre>
          </details>
          <details v-else-if="part.kind === 'tool_result'" class="fold" :class="part.isError ? 'err' : 'result'">
            <summary>{{ part.isError ? '⚠️ 工具报错' : '↩︎ 工具结果' }}</summary>
            <pre>{{ part.text }}</pre>
          </details>
        </template>
        <div v-if="fileLinks.length" class="files">
          <button
            v-for="link in fileLinks"
            :key="link.path"
            type="button"
            class="file-chip"
            @click="emit('preview', link.path)"
          >
            <span class="fi">{{ iconFor(link.ext) }}</span>
            <span class="fn">{{ link.name }}</span>
          </button>
        </div>
      </div>
      <div class="msg-foot">
        <button
          v-if="copyText"
          type="button"
          class="copy-btn"
          @click="copyReply"
        >{{ copied ? '✓ 已复制' : '📋 复制' }}</button>
        <div v-if="time" class="time">{{ time }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  padding: 3px 12px;
  /* 长对话滚动优化：屏外气泡跳过排版与绘制（iOS 滑动卡顿主因），估高供滚动条定位 */
  content-visibility: auto;
  contain-intrinsic-size: auto 96px;
}
.msg.user {
  justify-content: flex-end;
}
.msg-col {
  max-width: 92%;
  display: flex;
  flex-direction: column;
}
.msg-meta {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
}
.msg-meta .from {
  font-weight: 600;
}
.bubble {
  border-radius: 12px;
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: break-word;
}
.msg.user .bubble {
  background: var(--bubble-user-bg);
  border: 1px solid var(--bubble-user-border);
}
.msg.assistant .bubble {
  background: var(--bubble-ai-bg);
  border: 1px solid var(--bubble-ai-border);
}
.md :deep(p) {
  margin: 0.35em 0;
}
.md :deep(pre) {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 12px;
}
.md :deep(code) {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.92em;
}
.md :deep(:not(pre) > code) {
  background: var(--chip-bg);
  border-radius: 4px;
  padding: 1px 5px;
}
.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.4em;
  margin: 0.35em 0;
}
.md :deep(a) {
  color: var(--accent);
}
.md :deep(table) {
  /* GitHub 式：表格自带横向滚动，宽表不再凸出气泡（气泡无 overflow 裁剪，表格固有宽度会直接顶穿） */
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 12px;
  margin: 0.4em 0;
}
.md :deep(td),
.md :deep(th) {
  border: 1px solid var(--border-strong);
  padding: 3px 8px;
}
.fold {
  margin: 5px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--fold-bg);
  font-size: 12px;
}
.fold summary {
  cursor: pointer;
  padding: 5px 9px;
  color: var(--muted);
  user-select: none;
}
.fold pre {
  margin: 0;
  padding: 7px 9px;
  border-top: 1px solid var(--fold-border);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow-y: auto;
  font-size: 11.5px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--fold-text);
}
.fold.thinking summary {
  color: var(--thinking);
}
.fold.err {
  border-color: var(--danger);
}
.fold.err summary {
  color: var(--danger);
}
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--chip-bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}
.file-chip:active {
  transform: scale(0.97);
}
.file-chip .fi {
  flex: 0 0 auto;
}
.file-chip .fn {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-foot {
  display: flex;
  align-items: center;
  margin-top: 3px;
}
.copy-btn {
  border: 0;
  background: none;
  color: var(--faint);
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 5px;
  margin-left: -5px;
  border-radius: 5px;
  cursor: pointer;
  touch-action: manipulation;
}
.copy-btn:hover {
  color: var(--text);
  background: var(--chip-bg);
}
.time {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--faint);
  text-align: right;
}
</style>
