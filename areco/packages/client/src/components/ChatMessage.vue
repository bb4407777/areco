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
import { isTaskNotification, parseTaskNotification } from '../utils/notify'
import { useUiStore } from '../stores/ui'
import { useMessage } from 'naive-ui'
import { wsClient } from '../ws'

const props = defineProps<{ message: TranscriptMessage; agentLabel?: string; sessionId?: string; interactive?: boolean }>()
const emit = defineEmits<{ preview: [path: string] }>()
const ui = useUiStore()

// 任务通知兜底归类：服务端旧版把 <task-notification> 合成行当 text 段（解析层已改产 notice，
// 待重启生效），前端按内容再归一次——重启前立即生效，重启后此分支自然空转
const parts = computed(() =>
  props.message.parts.map((p) =>
    p.kind === 'text' && isTaskNotification(p.text) ? { kind: 'notice' as const, text: p.text } : p
  )
)

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
  parts.value.filter((p) => {
    if (p.kind === 'thinking') return ui.showThinking
    if (p.kind === 'tool_use') {
      // AskUserQuestion 等多选询问单独渲染为可点击选项卡片，不在工具折叠里重复显示
      if (isAskName(p.name) && !showRawAsk.value) return false
      return ui.showToolUse
    }
    if (p.kind === 'tool_result') return ui.showToolResult
    return true
  }),
)

// AskUserQuestion / request_user_input 等多选询问：解析成可点击选项卡片。
// 修桥接 WorkBuddy 会话在 areco 看不到选项按钮、只能去桌面端点的问题——这里直接渲染并回传答案。
const ASK_NAMES = ['askuserquestion', 'ask_user_question', 'request_user_input', 'requestuserinput']
function isAskName(name: unknown): boolean {
  const n = String(name ?? '').toLowerCase()
  return ASK_NAMES.some((x) => n.includes(x))
}
const askUserBlocks = computed(() => {
  type Opt = { label: string; description?: string }
  const blocks: { question: string; header?: string; multiSelect: boolean; options: Opt[] }[] = []
  for (const p of parts.value) {
    if (p.kind !== 'tool_use' || !isAskName(p.name)) continue
    try {
      const parsed = JSON.parse(p.input) as { questions?: unknown[] }
      const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
      for (const q of questions) {
        const qo = q as { question?: string; header?: string; multiSelect?: boolean; options?: unknown[] }
        if (!qo || !Array.isArray(qo.options)) continue
        blocks.push({
          question: String(qo.question ?? ''),
          header: qo.header ? String(qo.header) : undefined,
          multiSelect: Boolean(qo.multiSelect),
          options: qo.options.map((o) => {
            const oo = o as { label?: string; description?: string }
            return { label: String(oo?.label ?? ''), description: oo?.description ? String(oo.description) : undefined }
          }),
        })
      }
    } catch {
      /* 解析失败：交给 showRawAsk 兜底，仍按原始 tool_use 折叠显示 */
    }
  }
  return blocks
})
// 存在解析失败的 AskUserQuestion 原始块时，不在 visibleParts 排除，避免整块丢失
const showRawAsk = computed(() => {
  const raw = parts.value.filter((p) => p.kind === 'tool_use' && isAskName(p.name)).length
  return raw > askUserBlocks.value.length
})

// 选项点击 → 经 sendline 回传答案给会话（桥接会话即转发到 WorkBuddy）
const toast = useMessage()
const selected = ref<Record<number, string[]>>({})
function toggleOption(blockIdx: number, label: string) {
  const cur = selected.value[blockIdx] ?? []
  const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
  selected.value = { ...selected.value, [blockIdx]: next }
}
function sendAnswer(text: string) {
  if (!props.sessionId || !text.trim()) return
  if (!wsClient.send({ type: 'sendline', sessionId: props.sessionId, text })) {
    toast.warning('连接已断开，正在重连——文字已保留，稍后再试')
    wsClient.reconnectNow()
  }
}
function submitMulti(blockIdx: number) {
  const chosen = selected.value[blockIdx]
  if (!chosen || !chosen.length) return
  sendAnswer(chosen.join('；'))
  selected.value = { ...selected.value, [blockIdx]: [] }
}

// notice 段若是任务通知：折叠块呈现（<summary> 做标题、<result> 做正文），免得整墙 XML 糊在流里
const notifs = computed(() => visibleParts.value.map((p) => (p.kind === 'notice' ? parseTaskNotification(p.text) : null)))

// 右侧只放真人指令：role=user 且带 text 段才算用户泡泡；tool_result/notice（子 agent 回报、
// cron 触发、Claude 任务通知等合成 user 消息）一律归左侧（2026-07-23 维护者定：只有用户命令消息放用户侧）
const displayRole = computed(() =>
  props.message.role === 'user' && parts.value.some((part) => part.kind === 'text')
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
          <details v-else-if="part.kind === 'notice' && notifs[i]" class="fold notify">
            <summary>📨 {{ notifs[i]!.summary }}</summary>
            <!-- eslint-disable-next-line vue/no-v-html — markdown-it html:false 已转义原始 HTML -->
            <div class="md fold-md" v-html="render(notifs[i]!.body)" />
          </details>
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
        <!-- WorkBuddy AskUserQuestion 等多选询问：渲染为可点击选项卡片（桥接会话在 areco 也能直接选） -->
        <div v-for="(block, bi) in askUserBlocks" :key="'ask' + bi" class="ask-block">
          <div v-if="block.header" class="ask-header">{{ block.header }}</div>
          <div class="ask-q">{{ block.question }}</div>
          <div class="ask-opts" :class="{ off: !interactive }">
            <template v-if="block.multiSelect">
              <label v-for="(opt, oi) in block.options" :key="oi" class="ask-opt multi">
                <input
                  type="checkbox"
                  :disabled="!interactive"
                  :checked="(selected[bi] || []).includes(opt.label)"
                  @change="toggleOption(bi, opt.label)"
                />
                <span class="ask-opt-label">{{ opt.label }}</span>
                <span v-if="opt.description" class="ask-opt-desc">{{ opt.description }}</span>
              </label>
              <button
                type="button"
                class="ask-send"
                :disabled="!interactive || !(selected[bi] && selected[bi].length)"
                @click="submitMulti(bi)"
              >确定发送</button>
            </template>
            <button
              v-else
              v-for="(opt, oi) in block.options"
              :key="oi"
              type="button"
              class="ask-opt"
              :disabled="!interactive"
              :title="interactive ? '点击发送该选项' : '会话未运行，选项仅作记录'"
              @click="sendAnswer(opt.label)"
            >
              <span class="ask-opt-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="ask-opt-desc">{{ opt.description }}</span>
            </button>
          </div>
          <div v-if="!interactive" class="ask-hint">（会话未运行，选项仅作记录）</div>
        </div>
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
/* 折叠块里的 markdown 正文（任务通知 <result>）：对齐 fold pre 的内边距与分隔线 */
.fold .fold-md {
  padding: 0 9px 7px;
  border-top: 1px solid var(--fold-border);
  font-size: 12.5px;
  max-height: 320px;
  overflow-y: auto;
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
.ask-block {
  margin: 6px 0;
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 8px 10px;
  background: var(--ask-bg, var(--bubble-ai-bg));
}
.ask-header {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 2px;
}
.ask-q {
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 6px;
  line-height: 1.45;
}
.ask-opts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ask-opts.off {
  opacity: 0.6;
}
.ask-opt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  gap: 1px;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition:
    transform 140ms var(--ease-out),
    border-color 140ms;
  touch-action: manipulation;
}
.ask-opt:hover:not(:disabled) {
  border-color: var(--accent);
}
.ask-opt:active:not(:disabled) {
  transform: scale(0.98);
}
.ask-opt:disabled {
  cursor: default;
}
.ask-opt.multi {
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
}
.ask-opt.multi input {
  margin-top: 2px;
  flex: 0 0 auto;
}
.ask-opt-label {
  font-weight: 600;
}
.ask-opt-desc {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.4;
}
.ask-send {
  align-self: flex-end;
  margin-top: 2px;
  padding: 6px 14px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.ask-send:disabled {
  opacity: 0.4;
}
.ask-hint {
  font-size: 11px;
  color: var(--faint);
  margin-top: 4px;
}
</style>
