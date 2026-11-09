<script setup lang="ts">
// Transcript 对话视图（座舱聊天模式）：尾部先载 + 「加载更早」向前翻页（同历史页），
// 增量轮询 2.5s 追新（仅页面可见时），底部 PromptBar 可直接续问。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDropdown, NSpin, NTag, useMessage } from 'naive-ui'
import type { ScreenTailPayload, TranscriptMessage, TranscriptPage } from '../../../shared/protocol'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore, type SessionViewMode } from '../stores/ui'
import { chatCapable, statusTagText, templateLabel, trafficColor } from '../utils/format'
import { isTaskNotification } from '../utils/notify'
import { messageCoverage, prependKeepingAnchor } from '../utils/prepend-anchor'
import ArtifactsBar from '../components/ArtifactsBar.vue'
import ChatMessage from '../components/ChatMessage.vue'
import FilePreview from '../components/FilePreview.vue'
import MobileKeyBar from '../components/MobileKeyBar.vue'
import PromptBar from '../components/PromptBar.vue'
import ThinkingStream from '../components/ThinkingStream.vue'
import TypingIndicator from '../components/TypingIndicator.vue'
import ViewModeSwitch from '../components/ViewModeSwitch.vue'
import { useRenameDialog } from '../composables/useRenameDialog'
import { useSpawnWorker, HANDOFF_ROLES } from '../composables/useSpawnWorker'
import { wsClient } from '../ws'
import { TranscriptSpeechTracker } from '../utils/speechText'
import { useSpeechStore } from '../stores/speech'

const POLL_MS = 2500

const route = useRoute()
const router = useRouter()
const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()
const speech = useSpeechStore()
const speechTracker = new TranscriptSpeechTracker()
let speechCompletionPending = false
const { openRename } = useRenameDialog()
const { isRoleMode, handoffRole } = useSpawnWorker()

const sessionId = computed(() => String(route.params.id))
const session = computed(() => store.byId(sessionId.value))
const artifactAgent = computed(() => session.value ? templateLabel(session.value, store.templates) : '当前 Agent')
const isLive = computed(() => !!session.value && ['running', 'spawning', 'stopping'].includes(session.value.status))

// 「操作 ▾」与终端页同款（去掉仅终端相关的字号项）；座舱页不显示全局顶栏，主题入口也在这里
const resumable = computed(() => !!session.value && chatCapable(session.value, store.templates))

// 换 agent 接手候选：角色模式给四档角色（worker/thinker/快速/重活，HANDOFF_ROLES 单源）；
// 模板模式列全部启用的非 shell 模板（与侧栏/看板卡片同口径）
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])
const handoffChildren = computed(() =>
  isRoleMode.value
    ? HANDOFF_ROLES.map((r) => ({ label: r.label, key: `handoff-role:${r.role}` }))
    : store.templates
        .filter((t) => t.enabled && !SHELLS.has(t.command.split('/').pop() ?? ''))
        .map((t) => ({ label: `用 ${t.name} 接手`, key: `handoff:${t.id}` })),
)

const menuOptions = computed(() => {
  const s = session.value
  if (!s) return []
  const options = []
  options.push({ label: '重命名', key: 'rename' })
  if (isLive.value) {
    options.push({ label: '停止（SIGTERM）', key: 'stop' })
    options.push({ label: '强制终止（SIGKILL）', key: 'kill' })
  } else {
    if (resumable.value) {
      options.push({ label: '重新启动（恢复对话）', key: 'resume' })
    } else {
      options.push({ label: '重新启动', key: 'restart' })
    }
    for (const t of handoffChildren.value) {
      options.push(t)
    }
  }
  // 归档/恢复与删除对所有状态开放（运行中也能归档，与运行中能删除同口径）
  if (s.archived) options.push({ label: '恢复到看板', key: 'unarchive' })
  else options.push({ label: '归档（移出看板，保留记录）', key: 'archive' })
  options.push({ label: '删除会话', key: 'remove' })
  options.push({ label: ui.theme === 'dark' ? '切到浅色 ☀️' : '切到深色 🌙', key: 'theme' })
  return options
})

async function run(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function onMenu(key: string) {
  const id = sessionId.value
  if (key === 'stop') void run(() => store.stop(id))
  else if (key === 'kill') void run(() => store.kill(id))
  else if (key === 'restart') void run(() => store.restart(id, false))
  else if (key === 'resume') void run(() => store.restart(id, true))
  else if (key === 'rename') openRename(id, session.value?.name ?? '')
  else if (key === 'theme') ui.toggleTheme()
  else if (key === 'archive') void run(() => store.archive(id))
  else if (key === 'unarchive') void run(() => store.unarchive(id))
  // 删除成功后 session 消失，「会话被删除→回看板」watch 自动导航
  else if (key === 'remove') void run(() => store.remove(id))
  else if (key.startsWith('handoff-role:')) {
    const hit = HANDOFF_ROLES.find((r) => key === `handoff-role:${r.role}`)
    if (hit) void handoffRole(id, hit.role, hit.label)
  } else if (key.startsWith('handoff:')) {
    void run(async () => {
      const next = await store.handoff(id, key.slice(8))
      message.success('已交接给新会话')
      router.replace(`/session/${next.id}`)
    })
  }
}
watch(
  () => store.ready && !session.value,
  (gone) => {
    if (gone) router.replace('/')
  }
)

const messages = ref<TranscriptMessage[]>([])
const previewPath = ref<string | null>(null)
const exists = ref(true)
const loading = ref(true)
const loadingOlder = ref(false)
const hasMore = ref(false)
const scroller = ref<HTMLElement | null>(null)
// 离底超过该阈值显示「回到最新」悬浮按钮（不做贴底自动跟滚，追新一律手动点按钮）
const NEAR_BOTTOM_PX = 160
const showJump = ref(false)
// 是否贴底：iOS 壳弹键盘时 WebView 变矮（容器 resize），scrollTop 不变 → 末条被输入栏切掉。
// 记住用户是否贴底，高度变化时贴底的跟回底部，上翻中的不打扰（与「不自动跟滚」同口径）
let stickBottom = true
let streamObserver: ResizeObserver | null = null
let cursor = 0 // 向前增量续读点（字节）；0 = 尚未拿到尾页（服务端按尾页响应）
let start = 0 // 最早已载页的起始字节，「加载更早」传 before=start
// 向前翻页时 firstIndex 后退，保证已渲染消息的 key 稳定不漂移
const firstIndex = ref(0)
let timer: number | null = null
let pollingGen: number | null = null
let sessionGen = 0 // 递增，用于丢弃过期 async 响应

// 会话切换时（嵌套路由复用组件）重置状态，重新载入
watch(sessionId, (newId, oldId) => {
  if (newId === oldId) return
  sessionGen++
  cursor = 0
  start = 0
  firstIndex.value = 0
  messages.value = []
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
  speechTracker.invalidate()
  speechCompletionPending = false
  exists.value = true
  loading.value = true
  loadingOlder.value = false
  hasMore.value = false
  showJump.value = false
  showScreen.value = false
  screenLines.value = []
  screenError.value = false
  void poll()
})

function scrollToBottom(behavior?: ScrollBehavior) {
  const el = scroller.value
  if (!el) return
  stickBottom = true
  el.scrollTo({ top: el.scrollHeight, behavior })
}

// 首屏/整页替换后内容还会继续长高（图片、字体、代码块、iOS 视口回弹），一次性滚底常常
// 停在半截：上面某条被切掉、下面还有没入镜。短时内多次对账，直到真的贴底或用户手动上翻。
let settleTimer: number | null = null
function settleToBottom() {
  const startedTs = Date.now()
  if (settleTimer !== null) clearTimeout(settleTimer)
  const tick = () => {
    settleTimer = null
    if (!stickBottom) return // 用户已手动上翻，不打扰
    const el = scroller.value
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) scrollToBottom()
    if (Date.now() - startedTs < 1500) settleTimer = window.setTimeout(tick, 120)
  }
  tick()
}

// 流高度变化（键盘弹收、附件条展开、窗口缩放）：贴底的跟到底，否则只对账「回到最新」按钮
function onStreamResize() {
  if (stickBottom) scrollToBottom()
  else onScroll()
}

// 键盘弹出前（focus 先于 WebView 变矮）先把输入框拉进视野：一屏内视为在看最新，直接贴底；
// 之后容器被键盘压矮由 onStreamResize 继续跟，避免只跟半截、末条被输入栏切掉
function onFocusIn(e: FocusEvent) {
  const target = e.target as HTMLElement | null
  if (!target?.classList?.contains('prompt-input')) return
  const el = scroller.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) scrollToBottom()
}

// 终端尾屏面板：TUI 的选择框/确认提示只画在终端屏幕上、不进 transcript——
// 就地内嵌尾屏 + 快捷键条，不切页即可看到选项并作答
const showScreen = ref(false)
const screenLines = ref<string[]>([])
const screenError = ref(false)
const screenEl = ref<HTMLPreElement | null>(null)
// 紧凑 16 行是原设计：只为看清 TUI 的选项框/确认提示，不挤占对话区；想看完整画面再手动展开
const screenExpanded = ref(false)
let screenInFlight = false

async function fetchScreen() {
  if (screenInFlight) return
  const gen = sessionGen
  const id = sessionId.value
  // 刷新前先看有没有人翻到上面读旧内容：贴着底才跟着往下走，上翻读的时候不抢滚动位置
  const el = screenEl.value
  const stickBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48
  screenInFlight = true
  try {
    const lines = screenExpanded.value ? 400 : 16
    const data = await api.get<ScreenTailPayload>(`/api/sessions/${id}/screen?lines=${lines}`)
    if (gen !== sessionGen) return
    screenLines.value = data.lines
    screenError.value = false
    if (stickBottom) {
      await nextTick()
      const box = screenEl.value
      if (box) box.scrollTop = box.scrollHeight
    }
  } catch {
    if (gen !== sessionGen) return
    screenError.value = true
  } finally {
    if (gen === sessionGen) screenInFlight = false
  }
}
watch(showScreen, (open) => {
  if (open) void fetchScreen()
})

watch(screenExpanded, () => void fetchScreen())

// 键盘接管尾屏：点画面即聚焦隐藏输入框，按键按终端序列原样投给 pty（方向键/回车/^C 都能用），
// 打完顺手重拉一次尾屏——TUI 的选项框只画在屏幕上，不进 transcript，得靠这一小块看回显
const screenInput = ref<HTMLTextAreaElement | null>(null)
const screenFocused = ref(false)
let screenTimer: number | null = null
let screenPoll: number | null = null

function scheduleScreenRefresh(delay = 350) {
  if (screenTimer !== null) clearTimeout(screenTimer)
  screenTimer = window.setTimeout(() => {
    screenTimer = null
    void fetchScreen()
  }, delay)
}

function sendRaw(data: string) {
  if (!data) return
  if (!wsClient.send({ type: 'input', sessionId: sessionId.value, data })) {
    message.warning('终端输入没送出去——连接已重置，再点一次画面')
    wsClient.reconnectNow()
    return
  }
  scheduleScreenRefresh()
}

const KEY_SEQ: Record<string, string> = {
  Enter: '\r',
  Backspace: '\u007f',
  Tab: '\t',
  Escape: '\u001b',
  ArrowUp: '\u001b[A',
  ArrowDown: '\u001b[B',
  ArrowRight: '\u001b[C',
  ArrowLeft: '\u001b[D',
  Home: '\u001b[H',
  End: '\u001b[F',
  PageUp: '\u001b[5~',
  PageDown: '\u001b[6~',
  Delete: '\u001b[3~',
}

function focusScreen() {
  screenInput.value?.focus()
}

function stopScreenInput() {
  screenInput.value?.blur()
}

// 面板收起就别继续接管键盘
watch(showScreen, (open) => {
  if (!open) stopScreenInput()
})

function onScreenKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.metaKey) return // 输入法在组字、⌘ 组合交给浏览器
  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0)
    if (code >= 64 && code <= 95) {
      e.preventDefault()
      sendRaw(String.fromCharCode(code - 64)) // ^C=0x03、^D=0x04…按终端惯例送控制符
      return
    }
  }
  const seq = KEY_SEQ[e.key]
  if (seq) {
    e.preventDefault()
    sendRaw(seq)
    return
  }
  // 其余可打印字符/粘贴/输入法结果走 input 事件，避免与 keydown 重复发送
}

function onScreenInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  const value = el.value
  el.value = ''
  if (value) sendRaw(value)
}

function onScreenFocus() {
  screenFocused.value = true
  if (screenPoll === null) {
    screenPoll = window.setInterval(() => {
      if (!screenInFlight) void fetchScreen()
    }, 1500)
  }
}

function onScreenBlur() {
  screenFocused.value = false
  if (screenPoll !== null) {
    clearInterval(screenPoll)
    screenPoll = null
  }
}

onBeforeUnmount(() => {
  if (screenTimer !== null) clearTimeout(screenTimer)
  if (screenPoll !== null) clearInterval(screenPoll)
})


// Claude 系 AskUserQuestion 的选项等在终端里，transcript 尾消息可检出 → 面板条亮标提醒
const awaitingChoice = computed(() => {
  return session.value?.trafficState === 'needs-user'
})
// 仅最新一条 AskUserQuestion 的选项可点击（避免误点历史已答问题）；workbuddy 桥接会话不标 needs-user，
// 故用「会话在运行 + 是最后一条询问」判定（ChatMessage 内渲染可点选项卡片）
const lastAskMessageIndex = computed(() => {
  const list = messages.value
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].parts.some((p) => p.kind === 'tool_use' && String(p.name).toLowerCase().includes('askuserquestion'))) {
      return i
    }
  }
  return -1
})
// agent 正在干活：对话流尾部挂「正在输入中…」动效（对话模式没有终端滚屏的活感）
const working = computed(() => session.value?.status === 'running' && session.value?.trafficState === 'working')
function flushSpeechCompletion() {
  if (!speechCompletionPending) return
  speechCompletionPending = false
  for (const item of speechTracker.complete(sessionId.value, messages.value)) speech.enqueueAuto(item)
}
watch(working, async (w, wasWorking) => {
  if (w && !wasWorking) speechTracker.begin(sessionId.value, messages.value)
  if (!w && wasWorking) {
    // 等下一轮 transcript 拉取后再收口，避免 traffic 已结束但最终正文尚未到前端。
    speechCompletionPending = true
  }
  // 指示气泡刚出现时若本就贴底，跟滚一下让它入镜；用户在上翻则不打扰。
  // 贴底判定必须现场量（showJump 靠 scroll 事件对账，内容变长不触发事件，可能是旧值）
  if (!w) return
  await nextTick()
  const el = scroller.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) scrollToBottom()
})
const lightColor = computed(() =>
  session.value
    ? trafficColor(session.value.trafficState, session.value.status)
    : '#555'
)

// 本轮思考串联：最后一条真人指令之后的所有 thinking 段。任务通知等合成 user 行不算指令边界
//（服务端解析已归 notice；服务端重启生效前仍是 text 段，按内容再排除一次）。开了「显示思考过程」
// 且 agent 干活时喂给尾部打字机气泡——数据按步落盘，打字机匀速吐字补出连续体感（2026-07-26 维护者定）
const liveThinking = computed(() => {
  if (!working.value || !ui.showThinking) return ''
  const list = messages.value
  let from = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === 'user' && m.parts.some((p) => p.kind === 'text' && !isTaskNotification(p.text))) {
      from = i + 1
      break
    }
  }
  const chunks: string[] = []
  for (let i = from; i < list.length; i++) {
    for (const p of list[i].parts) if (p.kind === 'thinking') chunks.push(p.text)
  }
  return chunks.join('\n\n')
})
// 思考气泡定高，「出现」是它唯一一次高度跳变：贴底则入镜，否则对账「回到最新」按钮
watch(() => !!liveThinking.value, async (has) => {
  if (!has) return
  const el = scroller.value
  const wasNear = !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  await nextTick()
  if (wasNear) scrollToBottom()
  else onScroll()
})

async function poll() {
  const gen = sessionGen
  if (pollingGen === gen || document.visibilityState !== 'visible') return
  const id = sessionId.value
  const requestCursor = cursor
  pollingGen = gen
  try {
    // 入轮前记住是否贴底：整页替换后据此决定要不要跟滚（异步 await 前取，替换未发生时的真实位置）
    const wasAtBottom = (() => {
      const el = scroller.value
      if (!el) return true // 首载 scroller 尚未渲染，视为贴底
      return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    })()
    const isFirstLoad = requestCursor === 0
    const page = await api.get<TranscriptPage>(`/api/sessions/${id}/transcript?cursor=${requestCursor}`)
    if (gen !== sessionGen) return // 会话已切换，丢弃过期响应
    exists.value = page.exists
    // 带 start 的是尾页：首载，或 agent 会话（cursor=消息条数）条数收缩触发 total<cursor 的
    // 重置——两种都要整页替换（reasonix replace 语义；kimi 等追加型的小抖动服务端已容差，
    // 到这里的重置都是真收缩）。但滚动区别对待：
    // 只有首载或用户本就贴底才滚到底，否则条数一波动就把正在上翻的用户拽回底部
    //（2026-07-23 维护者报障"发送后跳回会话开头"）。与增量分支「不自动跟滚」同口径。
    const isTailPage = page.start !== undefined
    if (isFirstLoad) speechTracker.reset(id, page.messages)
    cursor = page.cursor
    if (isTailPage) {
      start = page.start ?? 0
      hasMore.value = page.hasMore ?? false
      messages.value = page.messages
      firstIndex.value = 0
      if (page.messages.length) {
        // 必须先撤下加载态：loading=true 时模板渲染的是 spinner，消息未上 DOM，滚底会落空
        loading.value = false
        await nextTick()
        if (isFirstLoad || wasAtBottom) settleToBottom()
        else onScroll() // 未跟滚：内容替换后对账「回到最新」按钮可见性
        // 尾页短到不能滚动时，滚动事件永远不会来；补一次，免得停在半屏且上不去
        if (isFirstLoad) {
          window.setTimeout(() => {
            const s = scroller.value
            if (s && hasMore.value && s.scrollHeight - s.clientHeight < 40) void loadOlder()
          }, 400)
        }
      }
    } else if (page.messages.length) {
      // 增量新消息只追加不滚动：贴底自动跟滚已关（会杀 iOS 惯性滚动造成断触），追新点「回到最新」
      messages.value.push(...page.messages)
      // 内容变长不触发 scroll 事件，手动对账一次按钮可见性
      await nextTick()
      onScroll()
    }
    // working 已结束时等本轮 transcript 增量落齐，再只播新增正式文本。
    flushSpeechCompletion()
    // 面板开着时顺轮询节拍刷新终端尾屏
    if (showScreen.value) void fetchScreen()
  } catch {
    /* 网络抖动下一轮再试 */
  } finally {
    if (gen === sessionGen) {
      loading.value = false
      if (pollingGen === gen) pollingGen = null
    }
  }
}

// 「加载更早」：照 weSaw 的做法——滚动离顶 48px 内自动补页，带锁防连环
const NEAR_TOP_PX = 48
let olderLock = false
let olderUnlock: number | null = null

async function loadOlder() {
  if (olderLock || loadingOlder.value || !hasMore.value) return
  olderLock = true
  loadingOlder.value = true
  const gen = sessionGen
  const id = sessionId.value
  try {
    // 一页按字节切，碰上超长工具结果可能只出两三条；先攒够一屏再一次性并入，
    // 逐页插入会让整列重排多轮，滑起来一顿一顿
    let batch: TranscriptMessage[] = []
    let next = start
    let more: boolean = hasMore.value
    for (let round = 0; round < 8 && more && batch.length < 20; round++) {
      const page = await api.get<TranscriptPage>(`/api/sessions/${id}/transcript?before=${next}`)
      if (gen !== sessionGen) return
      more = page.hasMore ?? false
      next = page.start ?? 0
      if (!page.messages.length) break
      batch = [...page.messages, ...batch]
    }
    hasMore.value = more
    start = next
    if (!batch.length) return
    speechTracker.addBaseline(id, batch)
    firstIndex.value -= batch.length
    const el = scroller.value
    if (!el) {
      messages.value = [...batch, ...messages.value]
      return
    }
    await prependKeepingAnchor(el, async () => {
      messages.value = [...batch, ...messages.value]
      await nextTick()
    })
    // 仍不够一屏（整页都是折叠内容）就接着补，别停在空屏等下一次滚动
    if (hasMore.value && (el.scrollTop < NEAR_TOP_PX || messageCoverage(el) < 0.5)) {
      window.setTimeout(() => void loadOlder(), 300)
    }
  } catch {
    /* 下次滑到顶再试 */
  } finally {
    if (gen === sessionGen) loadingOlder.value = false
    if (olderUnlock !== null) clearTimeout(olderUnlock)
    olderUnlock = window.setTimeout(() => {
      olderLock = false
    }, 250)
  }
}

// 滚动事件每帧只处理一次，避免每个 scroll 都同步量 scrollHeight（长会话里这是主要卡顿源）
let scrollFrame = 0
function onScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    const el = scroller.value
    if (!el) return
    showJump.value = el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM_PX
    stickBottom = !showJump.value
    if (el.scrollTop < NEAR_TOP_PX && !loading.value && hasMore.value) void loadOlder()
  })
}

function jumpToLatest() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  scrollToBottom(reduce ? 'auto' : 'smooth')
}

function onAutoSpeechChange(event: Event) {
  speech.setAutoEnabled((event.target as HTMLInputElement).checked)
}

function switchMode(mode: SessionViewMode) {
  // 只换本次路由，不写回默认（默认显示模式由设置页统一管，重进按默认，2026-07-24 维护者定）
  if (mode === 'terminal') router.push(`/session/${sessionId.value}`)
}

onMounted(() => {
  void poll()
  timer = window.setInterval(() => void poll(), POLL_MS)
  if (scroller.value) {
    streamObserver = new ResizeObserver(() => onStreamResize())
    streamObserver.observe(scroller.value)
  }
  document.addEventListener('focusin', onFocusIn)
})
// 换会话即停播：播报是「这一屏」的事，人走了不该还在耳边念上一屏（2026-11-08 高律师报障）
watch(sessionId, () => speech.stop())
onBeforeUnmount(() => {
  speech.stop()
  if (timer !== null) clearInterval(timer)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  if (settleTimer !== null) clearTimeout(settleTimer)
  if (olderUnlock !== null) clearTimeout(olderUnlock)
  streamObserver?.disconnect()
  streamObserver = null
  document.removeEventListener('focusin', onFocusIn)
})
</script>

<template>
  <div class="transcript-view">
    <div class="head">
      <n-button v-if="!ui.isDesktop" quaternary size="small" @click="router.push('/')">←</n-button>
      <span class="dot" :style="{ background: lightColor, boxShadow: `0 0 0 3px ${lightColor}22` }" />
      <span class="name">{{ session?.name ?? '…' }}</span>
      <n-tag v-if="session" size="small" :bordered="false" class="status-tag">{{ statusTagText(session) }}</n-tag>
      <span class="spacer" />
      <label class="auto-speech" title="只播新完成的正式文本；刷新后仍关闭">
        <input type="checkbox" :checked="speech.autoEnabled" @change="onAutoSpeechChange" />自动
      </label>
      <ViewModeSwitch mode="chat" @switch="switchMode" />
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button quaternary size="small">操作 ▾</n-button>
      </n-dropdown>
    </div>

    <div class="stream-wrap">
      <div ref="scroller" class="stream" @scroll.passive="onScroll">
        <n-spin v-if="loading" class="center" />
        <template v-else>
          <div v-if="!exists" class="hist-end">没有会话</div>
          <div v-else-if="!hasMore && messages.length" class="hist-end">已到最早</div>
          <ChatMessage
            v-for="(msg, i) in messages"
            :key="firstIndex + i"
            :message="msg"
            speakable
            :agent-label="artifactAgent"
            :session-id="sessionId"
            :interactive="isLive && i === lastAskMessageIndex"
            @preview="previewPath = $event"
          />
          <div v-if="messages.length" class="stream-tail" />
        </template>
        <ThinkingStream v-if="working && !loading && liveThinking" class="stream-typing" :text="liveThinking" />
        <TypingIndicator v-else-if="working && !loading" class="stream-typing" label="正在输入中…" />
      </div>
      <Transition name="jump">
        <div v-if="loadingOlder && !loading" class="older-pill">正在加载更早…</div>
      </Transition>
      <Transition name="jump">
        <button v-if="showJump" type="button" class="jump-latest" @click="jumpToLatest">↓ 回到最新</button>
      </Transition>
    </div>

    <ArtifactsBar
      v-if="exists && !loading"
      :session-id="sessionId"
      :agent-label="artifactAgent"
      @preview="previewPath = $event"
    />

    <div v-if="isLive" class="screen-peek">
      <button class="peek-toggle" type="button" @click="showScreen = !showScreen">
        <span>⌨️ 终端画面</span>
        <span v-if="awaitingChoice" class="peek-badge">有选项待选</span>
        <span class="peek-caret">{{ showScreen ? '▾' : '▸' }}</span>
      </button>
      <template v-if="showScreen">
        <div class="peek-wrap">
          <pre
            ref="screenEl"
            class="peek-screen"
            :class="{ focused: screenFocused }"
            tabindex="0"
            role="textbox"
            aria-label="终端画面，点击后键盘直接输入"
            @click="focusScreen"
            @keydown="onScreenKeydown"
          >{{
            screenError ? '（终端画面接口未就绪：服务端重启后生效）' : screenLines.join('\n') || '（暂无画面）'
          }}</pre>
          <textarea
            ref="screenInput"
            class="peek-input"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @input="onScreenInput"
            @keydown="onScreenKeydown"
            @focus="onScreenFocus"
            @blur="onScreenBlur"
          ></textarea>
        </div>
        <div class="peek-hint">
          <span class="peek-hint-text">{{
            screenFocused ? '⌨️ 键盘已接管这个终端画面 · 点别处退出' : '点画面即可用键盘操作（方向键／回车／^C 都直送终端）'
          }}</span>
          <button class="peek-exit" type="button" @click="screenExpanded = !screenExpanded">
            {{ screenExpanded ? '只看选项框' : '展开全部' }}
          </button>
          <button v-if="screenFocused" class="peek-exit" type="button" @click="stopScreenInput">退出键盘</button>
        </div>
        <MobileKeyBar :session-id="sessionId" />
      </template>
    </div>

    <!-- 死会话也可直接发：服务端自动 resume 拉起、就绪后注入（gateway sendline 自动恢复） -->
    <PromptBar :session-id="sessionId" :placeholder="isLive ? undefined : '会话已退出，发送将自动恢复对话…'" />
    <FilePreview :path="previewPath" @close="previewPath = null" />
  </div>
</template>

<style scoped>
.transcript-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(6px + env(safe-area-inset-top, 0px)) 10px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bar);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
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
  flex: 0 0 auto;
}
.spacer {
  flex: 1;
}
.auto-speech {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.auto-speech input {
  margin: 0;
}
.stream-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.stream {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0;
  overscroll-behavior: contain;
}
.older-pill {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
  pointer-events: none;
  box-shadow: 0 2px 10px var(--shadow);
}
.hist-end {
  text-align: center;
  font-size: 11px;
  color: var(--faint);
  padding: 6px 0 2px;
}
.jump-latest {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  line-height: 1;
  box-shadow: 0 4px 14px var(--shadow);
  cursor: pointer;
}
.jump-enter-active,
.jump-leave-active {
  transition:
    opacity 0.15s var(--ease-out),
    transform 0.15s var(--ease-out);
}
.jump-enter-from,
.jump-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
.screen-peek {
  border-top: 1px solid var(--border);
  background: var(--bar);
}
.peek-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  touch-action: manipulation;
}
.peek-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 600;
}
.peek-caret {
  margin-left: auto;
}
.peek-screen {
  margin: 0;
  padding: 8px 12px;
  max-height: min(45vh, 420px);
  overflow: auto;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre;
  color: var(--fold-text);
  background: var(--term-bg);
  border-top: 1px solid var(--border);
  cursor: text;
  outline: none;
  /* 尾屏只有十几行，滚动条占宽又碍眼：照旧能滚，只是不画条 */
  scrollbar-width: none;
}
.peek-screen::-webkit-scrollbar {
  display: none;
}
/* 键盘接管时给一圈色边，让人知道键进终端了 */
.peek-screen.focused {
  border-top-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.peek-wrap {
  position: relative;
}
/* 隐藏输入框：只为唤出键盘/接输入法，屏幕上看不见；放画面右下角避免 iOS 缩放 */
.peek-input {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  resize: none;
  overflow: hidden;
}
.peek-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-top: 1px solid var(--border);
  color: var(--faint);
  font-size: 11px;
}
.peek-hint-text {
  flex: 1;
  min-width: 0;
}
.peek-exit {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: none;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}
.stream-tail {
  height: 8px;
}
.stream-typing {
  margin: 0 12px 8px;
}
.center {
  margin-top: 18vh;
  display: flex;
  justify-content: center;
}
</style>
