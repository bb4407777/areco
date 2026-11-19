<script setup lang="ts">
// bot 详情：只有对话层，没有终端模式（2026-11-18 高律师令）。
// 不设「睡着」这个可见状态：有会话就绑会话直接聊，没会话就是一条空对话，发一句就建。
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpin } from 'naive-ui'
import { api } from '../api'
import TranscriptView from './TranscriptView.vue'
import PromptBar from '../components/PromptBar.vue'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { bots, loadBots, type Bot } from '../composables/useBots'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const store = useSessionsStore()
const sessionId = ref('')
const loading = ref(true)
const error = ref('')
/** 首句发出后到会话进程起来之前的空窗，给一行「正在唤醒」，不让人以为没反应 */
const waking = ref(false)

const bot = computed<Bot | undefined>(() => bots.value.find((b) => b.id === String(route.params.id)))
const opcTasks = computed(() => bot.value?.opc?.tasks ?? [])
/** 顶部一条状态：待办 / OPC / 同源 合成一行，点开看明细；明细不塞进对话 */
const open = ref(true)
const todoCount = computed(() => bot.value?.todoCount ?? 0)
const todos = computed(() => bot.value?.todos ?? [])
const opcLive = computed(() => opcTasks.value.filter((t) => t.status === 'running' || t.status === 'ready').length)
const opcWorst = computed(() => {
  const st = opcTasks.value.map((t) => t.status)
  if (st.includes('blocked')) return 'blocked'
  if (st.includes('running')) return 'running'
  if (st.includes('ready')) return 'ready'
  return 'other'
})
/** 状态条上的待办摘要：桌面只并两条在一行，手机全部换行列出 */
const gistTodos = computed(() => (ui.isDesktop ? todos.value.slice(0, 2) : todos.value))
const hasStatus = computed(() => todoCount.value > 0 || opcTasks.value.length > 0 || linkedRefs.value.length > 0)
/** 同源引用的会话：别处起的会话也归到这条 bot 名下借上下文，不计条数 */
const linkedRefs = computed(() => (bot.value?.refs ?? []).filter((r) => !r.primary))
const botName = computed(() => bot.value?.name ?? 'bot')
/** 旧会话历史：只读看，不绑新进程 */
const historyId = computed(() =>
  !sessionId.value ? bot.value?.history?.sessionId || bot.value?.historyFrom || '' : ''
)
const historyTitle = computed(() => bot.value?.history?.name || '')

const STATUS_TEXT: Record<string, string> = { running: '跑', ready: '待', blocked: '卡', other: '停' }

async function sync() {
  loading.value = true
  error.value = ''
  await loadBots()
  sessionId.value = bot.value?.sessionId ?? ''
  loading.value = false
}

// 会话一进名册（WS 推来）就撤掉「正在唤醒」；兜底 15 秒，免得一直挂着
watch(
  () => sessionId.value && Boolean(store.byId(sessionId.value)),
  (has) => {
    if (has) waking.value = false
  }
)

watch(
  () => route.params.id,
  () => {
    sessionId.value = ''
    error.value = ''
    open.value = true
    void sync()
  },
  { immediate: true }
)

/** 还没有会话：这句先送 /bots/:id/message，服务端建好会话再投进终端；之后这页就绑着会话聊 */
async function sendToBot(text: string): Promise<boolean> {
  error.value = ''
  try {
    waking.value = true
    window.setTimeout(() => {
      waking.value = false
    }, 15_000)
    const res = await api.post<{ sessionId: string }>(`/api/bots/${route.params.id}/message`, { text })
    sessionId.value = res.sessionId
    await loadBots()
    return true
  } catch (err) {
    waking.value = false
    error.value = err instanceof Error ? err.message : String(err)
    return false
  }
}
</script>

<template>
  <div class="bot-chat">
    <!-- 一条状态：待办 / OPC / 同源。要的是「有没有事、后台干到哪」，点开才展开明细；
         明细放对话里会变成历史消息越滚越远，也会被当上下文喂给模型 -->
    <div v-if="hasStatus" class="status-bar" :class="{ open }">
      <button class="status-head" type="button" @click="open = !open">
        <span class="chips">
          <span v-if="todoCount" class="chip todo">待办 {{ todoCount }}</span>
          <span v-if="opcTasks.length" class="chip">
            <span class="dot" :class="opcWorst" />OPC {{ opcLive }}/{{ opcTasks.length }}
          </span>
          <span v-if="linkedRefs.length" class="chip">同源 {{ linkedRefs.length }}</span>
        </span>
        <!-- 收起时一行摘要；展开后明细在下面，不再重复 -->
        <span v-if="!open && todos.length" class="gist">
          <span v-for="t in gistTodos" :key="t" class="gist-item">{{ t }}</span>
        </span>
        <span class="caret">{{ open ? '▴' : '▾' }}</span>
      </button>

      <div v-if="open" class="status-body">
        <div v-if="todos.length" class="sec">
          <div class="sec-label">待办 {{ todoCount }}</div>
          <div v-for="t in todos" :key="t" class="row">{{ t }}</div>
        </div>
        <div v-if="opcTasks.length" class="sec">
          <div class="sec-label">
            OPC
            <span v-if="bot?.opc?.doneToday" class="sec-sub">今日完成 {{ bot.opc.doneToday }}</span>
          </div>
          <div v-for="t in opcTasks" :key="t.id" class="row">
            <span class="dot" :class="t.status" />
            <span class="row-status">{{ STATUS_TEXT[t.status] ?? t.status }}</span>
            <span class="row-title">{{ t.title }}</span>
            <span v-if="t.note" class="row-note">{{ t.note }}</span>
          </div>
        </div>
        <div v-if="linkedRefs.length" class="sec">
          <div class="sec-label">同源会话（只借上下文，不计条数）</div>
          <div v-for="r in linkedRefs" :key="r.id" class="row">{{ r.name }}</div>
        </div>
      </div>
    </div>

    <!-- 会话起来了：同一套对话页，只是不给「切终端」入口；终端画面面板照常可看 -->
    <template v-if="sessionId">
      <div v-if="waking" class="wake-line">正在唤醒「{{ botName }}」…</div>
      <TranscriptView :session-id="sessionId" :terminal="false" />
    </template>

    <div v-else-if="loading" class="center"><n-spin size="small" /></div>

    <!-- 还没会话但有旧记录：先看过去的对话（只读），发第一句就从那段对话层接手 -->
    <template v-else-if="historyId">
      <TranscriptView
        :session-id="historyId"
        :source="`/api/bots/${route.params.id}/history`"
        :read-only="true"
        :title="historyTitle"
        :terminal="false"
        :peek="false"
        :composer="false"
      />
      <div class="history-note">以上是旧会话的记录 · 说一句话就从这里接着干</div>
      <PromptBar
        :session-id="`bot:${route.params.id}`"
        :send-text="sendToBot"
        :placeholder="`接着上文对「${botName}」说…`"
      />
    </template>

    <!-- 还没有会话：还是同一页对话，只是上面空着；说一句就起会话，回复仍在这页里出 -->
    <template v-else>
      <div class="stream">
        <div v-if="!ui.isDesktop" class="head">
          <n-button quaternary size="small" @click="router.push('/bots')">←</n-button>
          <span class="dot" />
          <span class="name">{{ botName }}</span>
        </div>
        <div v-if="error" class="err">{{ error }}</div>
        <div v-else class="hint">对「{{ botName }}」说一句就开始，回复都在这页里。</div>
      </div>
      <PromptBar
        :session-id="`bot:${route.params.id}`"
        :send-text="sendToBot"
        :placeholder="`对「${botName}」说点什么…`"
      />
    </template>
  </div>
</template>

<style scoped>
.bot-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.wake-line {
  flex: none;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--fg-2, #888);
  border-bottom: 1px solid var(--border);
}

.hint {
  padding: 28px 18px;
  font-size: 13px;
  color: var(--fg-2, #888);
}

.status-bar {
  flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2, var(--panel));
}

.status-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 5px 14px;
  border: 0;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
}

.chips {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.status-head:hover {
  background: var(--hover, rgba(127, 127, 127, 0.06));
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-variant-numeric: tabular-nums;
}

.chip.todo {
  color: #b45309;
  font-weight: 600;
}

.gist {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--faint);
}

.gist-item {
  white-space: nowrap;
}

.gist-item + .gist-item::before {
  content: ' · ';
}

.caret {
  margin-left: auto;
  flex: none;
  color: var(--faint);
  font-size: 11px;
  line-height: 1;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9ca3af;
  flex: none;
}

.dot.running {
  background: #22c55e;
}
.dot.ready {
  background: #f59e0b;
}
.dot.blocked {
  background: #ef4444;
}

@media (max-width: 640px) {
  /* 手机收起时只留一行数字，摘要不挤在角上 */
  .status-bar:not(.open) .gist {
    display: none;
  }
  .status-head {
    padding: 6px 12px;
  }
  /* 展开：明细整段铺开，不截行、不限高，整页往下滚 */
  .status-body {
    max-height: none;
    overflow: visible;
    padding: 2px 12px 10px;
  }
  .row {
    line-height: 1.6;
  }
}

.status-body {
  max-height: 40vh;
  overflow-y: auto;
  padding: 2px 14px 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.sec {
  padding: 6px 0;
}

.sec + .sec {
  border-top: 1px dashed var(--border);
}

.sec-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--faint);
  margin-bottom: 4px;
}

.sec-sub {
  margin-left: 6px;
  letter-spacing: 0;
}

.row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
  color: var(--fg-2, #888);
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}

.row-status {
  flex: none;
  color: var(--faint);
}

.row-title {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
}

.row-note {
  flex: 1 1 100%;
  min-width: 0;
  color: var(--faint);
  white-space: normal;
}

.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 头与对话页同款，只是灯是灰的 */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(6px + env(safe-area-inset-top, 0px)) 10px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bar);
  flex: none;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: #9ca3af;
}

.name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.status-tag {
  background: var(--chip-bg);
  font-size: 11px;
  color: var(--faint);
  flex: 0 0 auto;
}

.history-note {
  flex: none;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--faint);
  text-align: center;
}

.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 0;
}

.err {
  text-align: center;
  font-size: 12px;
  color: #ef4444;
  padding: 8px 16px;
}
</style>
