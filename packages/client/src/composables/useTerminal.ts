// 终端接线：attach → snapshot(reset+回放) → output（epoch/offset 去重）→ ack（write 完成回调）。
// appliedOffset 在处理消息时同步推进（xterm write 队列保序，守卫只负责丢弃快照已覆盖/陈旧块）；
// ack 绑定渲染完成回调，驱动服务端流控。
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ServerMsg } from '../../../shared/protocol'
import { wsClient } from '../ws'
import { useUiStore } from '../stores/ui'
import { escapeDetail, logInput } from '../utils/inputLog'

const DARK_TERM_THEME = {
  background: '#101014',
  foreground: '#dfe1e6',
  cursor: '#63e2b7',
  cursorAccent: '#101014',
  selectionBackground: '#33415580',
  black: '#1c1c22',
  red: '#e88080',
  green: '#63e2b7',
  yellow: '#f2c97d',
  blue: '#70a5eb',
  magenta: '#c792ea',
  cyan: '#66d9ef',
  white: '#dfe1e6',
  brightBlack: '#5c6370',
  brightRed: '#ff8f8f',
  brightGreen: '#7ff0c8',
  brightYellow: '#ffd88f',
  brightBlue: '#8fbcff',
  brightMagenta: '#d9a7f5',
  brightCyan: '#7fe4f5',
  brightWhite: '#ffffff',
}

// GitHub Light 系配色：白底下 ANSI 各色保持可读对比度
const LIGHT_TERM_THEME = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0ea373',
  cursorAccent: '#ffffff',
  selectionBackground: '#0969da33',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#953800',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
}

export function useTerminal(sessionId: string) {
  const ui = useUiStore()
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let container: HTMLElement | null = null
  let appliedOffset = 0
  let currentEpoch = -1
  let resizeObserver: ResizeObserver | null = null
  let fitTimer: number | null = null
  let lastReported = { cols: 0, rows: 0 }
  let offMsg: (() => void) | null = null
  let offOpen: (() => void) | null = null
  let imeListeners: {
    el: HTMLElement
    onComp: (e: Event) => void
    onKeyCapture: (e: Event) => void
    onBeforeInput: (e: Event) => void
  } | null = null

  // —— 滑动写入暂停（治 iOS 断触）：output 一到就 term.write 会触发 xterm 刷新/同步 scrollTop，
  // 惯性滚动中来一发就被杀断。触摸滑动期间把 output 攒进 pending 不写（ack 顺延=天然背压），
  // 停稳 SCROLL_IDLE_MS 后一次性补写。只认触摸引发的滚动（含松手后惯性尾巴），桌面滚轮不受影响。
  const SCROLL_IDLE_MS = 200
  const MOMENTUM_TAIL_MS = 2500 // touchend 后仍算惯性期的窗口
  const PENDING_CAP_BYTES = 128 * 1024 // 攒超此量强制补写，防长滑+刷屏堆积；须明显低于服务端 FLOW_HIGH_WATER(256KB)，否则补写永远触发不了、15s 滞留必被强制 detach
  let touchActive = false
  let lastTouchEndTs = 0
  let lastUserScrollTs = 0
  let pending: { data: string; offset: number }[] = []
  let pendingBytes = 0
  let flushTimer: number | null = null

  function isUserScrolling() {
    return touchActive || momentumRaf !== 0 || performance.now() - lastUserScrollTs < SCROLL_IDLE_MS
  }

  // —— 快照回底守卫（2026-07-22 维护者报障"选完选项继续工作时弹到会话开头"）：
  // write 回调里单次 scrollToBottom 不够——重连抖动期快照/输出/resize 交错，
  // 回调之后的补写与 xterm 内部 reflow 仍可能把视口顶回开头（reset 后 ydisp=0）。
  // 快照落地后开一个 ~1.2s 结算窗多点回底；窗内用户主动滚动（滚轮/触摸）即撤防，不抢滚动权。
  const SETTLE_ASSERT_MS = [150, 500, 1200]
  let settleTimers: number[] = []
  let settleStartTs = 0
  let wheelIntentTs = 0 // 桌面滚轮滚动意图（只服务守卫撤防，不参与写入暂停——桌面滚轮本就不暂停写入）

  function cancelSettleGuard() {
    for (const t of settleTimers) clearTimeout(t)
    settleTimers = []
  }
  function startSettleGuard() {
    cancelSettleGuard()
    settleStartTs = performance.now()
    for (const ms of SETTLE_ASSERT_MS) {
      settleTimers.push(
        window.setTimeout(() => {
          if (!term) return
          // 结算窗开启后用户主动滚了：撤防，把滚动权还给用户
          if (wheelIntentTs > settleStartTs || touchActive || momentumRaf !== 0) {
            cancelSettleGuard()
            return
          }
          term.scrollToBottom()
        }, ms),
      )
    }
  }

  function onWheelIntent() {
    wheelIntentTs = performance.now()
  }

  // —— 触摸惯性补全（断触主因的根治）：xterm 的触摸滚动是纯手动 touchmove→scrollTop，
  // 没有 touchend/速度/动量代码，手指一离屏滚动瞬间死停。这里跟踪 touchmove 速度，
  // touchend 后用 rAF 指数衰减续滚出原生手感；再次触摸/到边界/速度耗尽即停。
  // 加边界橡皮筋（apple-design §9）：到顶/到底渐阻尼，回弹 damping=1.0 无振荡（常规移动手感）。
  const FLICK_MIN_V = 0.1 // px/ms，低于此不起滑
  const MOMENTUM_STOP_V = 0.02
  const VELOCITY_WINDOW_MS = 100 // 释放速度取最近 ~100ms 触点历史（apple-design §2：track history, not the current point）
  const RUBBERBAND_C = 0.55 // Apple 标准橡皮筋系数
  let viewportEl: HTMLElement | null = null // .xterm-viewport（xterm open 后查）
  let velocity = 0 // px/ms，向下滚为正
  let moveSamples: { y: number; ts: number }[] = []
  let momentumRaf = 0
  let momentumPos = 0 // 自持浮点位置，避免 scrollTop 取整吞掉小步进
  let overshootFrom = 0 // 橡皮筋起点（边界处真实 scrollTop）
  let inOvershoot = false
  let dragStartY = 0 // touchstart 时的 pageY
  let dragStartScroll = 0 // touchstart 时的 scrollTop
  let dragAtBoundary = false // 拖拽中已贴边（继续拖即为拽出边界）

  // apple-design §9: overshoot=拽出边界的像素，dimension=视口高度，返回阻尼后实际位移
  function rubberband(overshoot: number, dimension: number) {
    return (overshoot * dimension * RUBBERBAND_C) / (dimension + RUBBERBAND_C * Math.abs(overshoot))
  }

  function stopMomentum() {
    if (momentumRaf !== 0) {
      cancelAnimationFrame(momentumRaf)
      momentumRaf = 0
    }
    inOvershoot = false
  }

  function startMomentum() {
    if (!viewportEl || Math.abs(velocity) < FLICK_MIN_V) return
    momentumPos = viewportEl.scrollTop
    inOvershoot = false
    let prev = performance.now()
    const step = (ts: number) => {
      const el = viewportEl
      if (!el) {
        momentumRaf = 0
        return
      }
      const dt = ts - prev
      prev = ts
      const maxScroll = el.scrollHeight - el.clientHeight

      if (!inOvershoot) {
        // 正常滚动区
        momentumPos += velocity * dt
        const atTop = momentumPos <= 0
        const atBottom = momentumPos >= maxScroll
        if (atTop || atBottom) {
          // 碰边界：记录起点并切入橡皮筋态，速度保留用于拉伸量
          overshootFrom = atTop ? 0 : maxScroll
          inOvershoot = true
        } else {
          el.scrollTop = momentumPos
          velocity *= Math.pow(0.998, dt) // Apple 标准减速率
          if (Math.abs(velocity) < MOMENTUM_STOP_V) {
            momentumRaf = 0
            return
          }
          momentumRaf = requestAnimationFrame(step)
          return
        }
      }

      // 橡皮筋态：用剩余速度拉伸（阻尼），速度耗尽后回弹到边界
      if (inOvershoot) {
        const overshoot = momentumPos - overshootFrom
        const stretched = rubberband(overshoot, el.clientHeight)
        el.scrollTop = overshootFrom + stretched
        velocity *= Math.pow(0.95, dt / 16.7) // 橡皮筋内衰减快一些，尽快停住触发回弹
        if (Math.abs(velocity) < MOMENTUM_STOP_V * 2) {
          // 速度耗尽，弹回边界（damping=1.0 critically damped，apple-design §5 常规移动手感）
          const startPos = el.scrollTop
          const target = overshootFrom
          const spring = { velocity: 0, value: startPos }
          const stepSpring = (ts2: number) => {
            const el2 = viewportEl
            if (!el2) {
              momentumRaf = 0
              inOvershoot = false
              return
            }
            const dt2 = ts2 - prev
            prev = ts2
            // 简化弹簧：critically damped (ζ=1) 的解析解 ≈ 指数衰减到目标
            const diff = spring.value - target
            if (Math.abs(diff) < 0.5) {
              el2.scrollTop = target
              momentumRaf = 0
              inOvershoot = false
              return
            }
            // 响应 0.3s (apple-design §5 sheet/drawer 标准)，每帧向目标逼近
            const progress = 1 - Math.exp(-dt2 / 300)
            spring.value += (target - spring.value) * progress
            el2.scrollTop = spring.value
            momentumRaf = requestAnimationFrame(stepSpring)
          }
          momentumRaf = requestAnimationFrame(stepSpring)
          return
        }
        momentumPos += velocity * dt
        momentumRaf = requestAnimationFrame(step)
        return
      }

      momentumRaf = requestAnimationFrame(step)
    }
    momentumRaf = requestAnimationFrame(step)
  }

  function onTouchStart(e: TouchEvent) {
    touchActive = true
    stopMomentum()
    velocity = 0
    const y = e.touches[0]?.pageY
    if (y !== undefined && viewportEl) {
      dragStartY = y
      dragStartScroll = viewportEl.scrollTop
      dragAtBoundary = false
    }
    moveSamples = y === undefined ? [] : [{ y, ts: performance.now() }]
  }
  function onTouchMove(e: TouchEvent) {
    const y = e.touches[0]?.pageY
    if (y === undefined) return
    const now = performance.now()
    moveSamples.push({ y, ts: now })
    while (moveSamples.length > 1 && now - moveSamples[0]!.ts > VELOCITY_WINDOW_MS) moveSamples.shift()
  }

  // viewport 上的 capture touchmove：在 xterm 之前拦截,边界时接管橡皮筋
  function onViewportTouchMove(e: TouchEvent) {
    const y = e.touches[0]?.pageY
    if (y === undefined || !viewportEl) return
    const el = viewportEl
    const maxScroll = el.scrollHeight - el.clientHeight
    const fingerDelta = dragStartY - y // 手指向上划为正
    const targetScroll = dragStartScroll + fingerDelta
    const atTop = targetScroll <= 0
    const atBottom = targetScroll >= maxScroll

    if (atTop || atBottom) {
      // 到边界：阻止 xterm 自己的滚动，改由我们施加橡皮筋
      e.preventDefault()
      e.stopPropagation()
      dragAtBoundary = true
      overshootFrom = atTop ? 0 : maxScroll
      const overshoot = atTop ? targetScroll : targetScroll - maxScroll
      const stretched = rubberband(overshoot, el.clientHeight)
      el.scrollTop = overshootFrom + stretched
    } else {
      // 正常区：放行给 xterm 的 handleTouchMove
      dragAtBoundary = false
    }
  }
  function onTouchEnd() {
    touchActive = false
    lastTouchEndTs = performance.now()
    const first = moveSamples[0]
    const last = moveSamples[moveSamples.length - 1]
    moveSamples = []
    // 拖拽中到过边界：松手后触发回弹（不管有没有越界拉伸，统一弹回边界）
    if (dragAtBoundary && viewportEl) {
      dragAtBoundary = false
      const el = viewportEl
      const startPos = el.scrollTop
      const target = overshootFrom
      if (Math.abs(startPos - target) > 0.5) {
        // 有拉伸，弹回
        const spring = { value: startPos }
        let prev = performance.now()
        const stepSpring = (ts: number) => {
          const el2 = viewportEl
          if (!el2) {
            momentumRaf = 0
            return
          }
          const dt = ts - prev
          prev = ts
          const diff = spring.value - target
          if (Math.abs(diff) < 0.5) {
            el2.scrollTop = target
            momentumRaf = 0
            return
          }
          const progress = 1 - Math.exp(-dt / 300)
          spring.value += (target - spring.value) * progress
          el2.scrollTop = spring.value
          momentumRaf = requestAnimationFrame(stepSpring)
        }
        momentumRaf = requestAnimationFrame(stepSpring)
        return
      }
      // 到边界但未拉伸（刚碰到就松手）：不起滑
      velocity = 0
      return
    }
    // 样本跨度太短（点按）或松手前已停稳（按住不动再抬手）都不起滑
    if (!first || !last || last.ts - first.ts < 20 || lastTouchEndTs - last.ts > 100) {
      velocity = 0
      return
    }
    velocity = (first.y - last.y) / (last.ts - first.ts)
    startMomentum()
  }
  function onTouchCancel() {
    // 系统抢走手势（touchcancel）：只复位，不起滑
    touchActive = false
    lastTouchEndTs = performance.now()
    moveSamples = []
    velocity = 0
    stopMomentum()
  }
  // scroll 不冒泡但捕获相位可在容器上收到 .xterm-viewport 的滚动；
  // 只有触摸期/惯性尾巴内的滚动才记为用户滑动，xterm 自己的程序化滚动不算
  function onAnyScroll() {
    if (touchActive || performance.now() - lastTouchEndTs < MOMENTUM_TAIL_MS) {
      lastUserScrollTs = performance.now()
      scheduleFlush()
    }
  }

  function flushPending() {
    if (!term || !pending.length) return
    const chunks = pending
    pending = []
    pendingBytes = 0
    const last = chunks[chunks.length - 1]!
    term.write(chunks.map((c) => c.data).join(''), () => wsClient.queueAck(sessionId, last.offset))
  }

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(() => {
      flushTimer = null
      if (!pending.length) return
      if (isUserScrolling() && pendingBytes < PENDING_CAP_BYTES) {
        scheduleFlush() // 还在滑，续约下一窗
        return
      }
      flushPending()
    }, SCROLL_IDLE_MS)
  }

  function mount(el: HTMLElement) {
    container = el
    term = new Terminal({
      fontSize: ui.fontSize,
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      lineHeight: 1.15,
      scrollback: 3000,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: ui.theme === 'light' ? LIGHT_TERM_THEME : DARK_TERM_THEME,
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    viewportEl = el.querySelector('.xterm-viewport')
    // GPU 渲染：默认 DOM 渲染器每滚一步整屏重建可见行，手机拖拽掉帧（「不跟手」主因）；
    // WebGL 上下文丢失（iOS 退后台等）自动 dispose 回退 DOM 渲染
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* WebGL 不可用（旧设备/受限 webview）：保持 DOM 渲染 */
    }
    term.onData((data) => {
      // 断线时按键静默丢失是「输入进不到」主诉之一：失败即触发立即重连（顶部横幅已提示断线，这里不再弹 toast 刷屏）
      const ok = wsClient.send({ type: 'input', sessionId, data })
      // 记录 xterm 已发文本：fallback 兜底按此去重（见 fallbackIfXtermSilent）
      lastXtermSentText = data
      lastXtermSentTs = performance.now()
      // 输入诊断埋点：每次 onData 记一条（含 send 结果），排查手机端吞字/标点丢失
      logInput({ kind: 'data', detail: escapeDetail(data), ok })
      if (!ok) wsClient.reconnectNow()
    })

    // IME 组字与按键事件埋点（capture 阶段、先于 xterm 处理）：微信输入法类第三方键盘
    // 在隐藏 textarea 上组字异常时，comp 序列（start/update/end 的 data）是定位关键证据
    const onComp = (e: Event) => {
      const ce = e as CompositionEvent
      keyCompTs = performance.now() // 听写签名排除：有组字活动 = 正常 IME，不走听写旁路
      dictationShadow = ''
      composing = e.type !== 'compositionend'
      logInput({ kind: 'comp', detail: `${e.type} data=${escapeDetail(ce.data ?? '')}` })
    }
    const onKeyCapture = (e: Event) => {
      const ke = e as KeyboardEvent
      keyCompTs = performance.now() // 同上：有按键 = 非听写
      dictationShadow = ''
      if (e.type === 'keypress') {
        lastKeypressTs = performance.now() // 桌面字符经 keypress 路径发送，兜底需排除
        return
      }
      if (e.type !== 'keydown') return
      logInput({ kind: 'key', detail: `key=${ke.key} code=${ke.code} composing=${ke.isComposing}` })
    }
    // beforeinput/input 埋点：iOS 听写（语音输入）不经过 keydown/composition，而是连续
    // insert/delete 改写 textarea——重复输入 bug 的取证全靠这两条事件的 inputType 序列
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent
      logInput({
        kind: 'binput',
        detail: `${e.type} inputType=${ie.inputType} data=${escapeDetail(ie.data ?? '∅')}`,
      })
      if (e.type === 'beforeinput') {
        dictationIntercept(e as InputEvent)
        return
      }
      fallbackIfXtermSilent(e as InputEvent)
    }

    // —— xterm 沉默兜底（iOS 标点打不上修复，2026-07-22 日志+源码双重取证）
    // xterm _inputEvent 只在 (!e.composed || !_keyDownSeen) 时发送 insertText；
    // 系统 IME 直接上屏的标点（keydown 刚过=keyDownSeen、事件 composed=true）被 return false
    // 丢弃，iOS 又无 keypress 兜底 → 静默吞字。
    // ⚠️ defaultPrevented 不能判 xterm 是否已发：xterm 发送后也调 cancel(e)，但 cancel 只在
    // cancelEvents 选项开启时才 preventDefault（默认关）→ 已发也是 defaultPrevented=false。
    // 第三方 IME 上屏序列（deleteCompositionText→compositionend→Unidentified keydown→insertText）
    // xterm 在 input 事件里已正常发出，若只看 defaultPrevented 兜底会再发一遍（每个词翻倍，
    // 2026-07-22 手机端微信输入法实测"会话"→"会话会话"）。改为按 xterm 自己的 onData 发送
    // 记录去重：兜底在 setTimeout 里跑，此刻 xterm 已同步处理完同一事件，同文本即跳过。
    let lastXtermSentText = ''
    let lastXtermSentTs = 0
    const fallbackIfXtermSilent = (ie: InputEvent) => {
      if (ie.inputType !== 'insertText' || !ie.data || composing) return
      const data = ie.data
      setTimeout(() => {
        if (ie.defaultPrevented) return // 事件被其他 handler 取消（如 cancelEvents 开启后的 xterm）
        if (performance.now() - lastKeypressTs < 100) return // 桌面 keypress 路径已发送
        // xterm 已发同文本（IME 上屏/CompositionHelper 路径）：去重，防翻倍
        if (lastXtermSentText === data && Math.abs(performance.now() - lastXtermSentTs) < 300) return
        if (composing) return
        const ta = el.querySelector('textarea')
        if (ta && ta.value) ta.value = '' // 清掉拒收残留，防堆积污染 IME 上下文
        const ok = wsClient.send({ type: 'input', sessionId, data })
        logInput({ kind: 'data', detail: `fallback→${escapeDetail(data)}`, ok })
        if (!ok) wsClient.reconnectNow()
      }, 0)
    }

    // —— iOS 听写旁路（语音输入全量重发 bug 修复，2026-07-22 日志取证）
    // 听写每修正一次识别就以「全量文本」insertText 改写 textarea（无 keydown/composition）；
    // xterm 处理完清空 textarea，下一次改写与空值 diff = 全量重发 → 终端收到多段重复。
    // 旁路：capture 阶段识别听写签名后 preventDefault，自己维护影子文本算增量直发 pty。
    // 签名 = insertText + 500ms 内无 keydown/composition（IME 上屏有 composition 序列，
    // 键盘输入有 keydown，均不命中）；首事件常是单字（实测"现"漏拦→"现现在"），
    // 故不限长度，让影子从第一个字起接管。
    // 实测听写修正间隔可达 7s（说话停顿），且每次 insertText 都带全量文本——差量算法
    // 自修正，影子无需短过期；2min 仅作兜底。keydown/composition/粘贴/替换/撤销即重置。
    let dictationShadow = ''
    let dictationLastTs = 0
    let keyCompTs = 0
    let lastKeypressTs = 0
    let composing = false
    const DICTATION_IDLE_MS = 120_000
    // 明确非听写来源的编辑事件：出现即作废影子（deleteContent* 是听写流程的一部分，不在列）
    const NON_DICTATION_TYPES = new Set(['insertFromPaste', 'insertFromDrop', 'insertReplacementText', 'historyUndo', 'historyRedo'])
    const dictationIntercept = (ie: InputEvent) => {
      if (NON_DICTATION_TYPES.has(ie.inputType)) {
        dictationShadow = ''
        return
      }
      if (ie.inputType !== 'insertText' || !ie.data) return
      const now = performance.now()
      if (now - keyCompTs < 500) {
        dictationShadow = ''
        return
      }
      ie.preventDefault()
      ie.stopPropagation()
      if (now - dictationLastTs > DICTATION_IDLE_MS) dictationShadow = ''
      dictationLastTs = now
      const prev = dictationShadow
      const next = ie.data
      let p = 0
      while (p < prev.length && p < next.length && prev[p] === next[p]) p++
      const out = '\x7f'.repeat(prev.length - p) + next.slice(p)
      if (!out) {
        dictationShadow = next
        logInput({ kind: 'data', detail: 'dictation→∅(增量为空)' })
        return
      }
      const ok = wsClient.send({ type: 'input', sessionId, data: out })
      // 送达才推进影子：未送达保持旧影子，下一事件按旧影子差量补发，防丢段（2026-07-22 实测 ✗未送达后整句丢失）
      if (ok) dictationShadow = next
      logInput({ kind: 'data', detail: `dictation→${escapeDetail(out)}`, ok })
      if (!ok) wsClient.reconnectNow()
    }
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend'] as const) {
      el.addEventListener(t, onComp, { capture: true })
    }
    el.addEventListener('keydown', onKeyCapture, { capture: true })
    el.addEventListener('keypress', onKeyCapture, { capture: true })
    el.addEventListener('beforeinput', onBeforeInput, { capture: true })
    el.addEventListener('input', onBeforeInput, { capture: true })
    imeListeners = { el, onComp, onKeyCapture, onBeforeInput }

    fitNow()
    resizeObserver = new ResizeObserver(() => scheduleFit())
    resizeObserver.observe(el)
    window.visualViewport?.addEventListener('resize', scheduleFit)

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false }) // 非 passive：橡皮筋期需 preventDefault
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchCancel, { passive: true })
    el.addEventListener('scroll', onAnyScroll, { passive: true, capture: true })
    // 桌面滚轮=用户滚动意图：只用于快照回底守卫的撤防（写入暂停仍只认触摸，桌面滚轮不受影响）
    el.addEventListener('wheel', onWheelIntent, { passive: true })

    // 橡皮筋需在 .xterm-viewport 上接管触摸,在 xterm 自己的 handler 之前拦截
    viewportEl?.addEventListener('touchmove', onViewportTouchMove, { passive: false, capture: true })

    offMsg = wsClient.onMessage(onMsg)
    offOpen = wsClient.onOpen(attach)
    if (wsClient.connected.value) attach()
  }

  function attach() {
    if (!term) return
    fitNow()
    wsClient.send({ type: 'attach', sessionId, cols: term.cols, rows: term.rows })
  }

  function onMsg(msg: ServerMsg) {
    if (!term) return
    // 服务端 error：强制 detach（flow_stalled）/快照缓冲溢出（attach_overflow）等。
    // 不处理的话 attachment 已被服务端清掉而 WS 仍 OPEN，reconnectNow 直接 return，终端永久冻结
    if (msg.type === 'error' && msg.sessionId === sessionId) {
      term.writeln(`\r\n\x1b[33m[服务端] ${msg.message}\x1b[0m`)
      if ((msg.code === 'flow_stalled' || msg.code === 'attach_overflow') && wsClient.connected.value) {
        term.writeln('\x1b[90m正在重新接入…\x1b[0m')
        attach() // 连接还活着，直接重发 attach 走快照恢复
      }
      return
    }
    if (msg.type === 'snapshot' && msg.sessionId === sessionId) {
      // 快照全量覆盖到 msg.offset，攒着的旧输出作废
      pending = []
      pendingBytes = 0
      currentEpoch = msg.epoch
      appliedOffset = msg.offset
      term.reset()
      if (msg.cols !== term.cols || msg.rows !== term.rows) {
        // exited 会话按落盘快照的原始尺寸呈现；运行中会话服务端已按我方尺寸 resize，两者相等
        term.resize(msg.cols, msg.rows)
      }
      if (msg.data) {
        term.write(msg.data, () => {
          // 快照=会话最新状态，写完显式回底：reset 后 xterm 在部分场景（大快照分块、
          // alt-buffer 切换）视口停在顶部不动（2026-07-22 维护者报障"输入命令后跳回顶部"）
          term?.scrollToBottom()
          startSettleGuard() // 回调后仍有补写/reflow 顶回开头的缝隙，结算窗内多点回底
          wsClient.queueAck(sessionId, msg.offset)
        })
      } else {
        term.scrollToBottom()
        startSettleGuard()
      }
      return
    }
    if (msg.type === 'output' && msg.sessionId === sessionId) {
      if (msg.epoch !== currentEpoch || msg.offset <= appliedOffset) return
      appliedOffset = msg.offset
      if (isUserScrolling() && pendingBytes < PENDING_CAP_BYTES) {
        pending.push({ data: msg.data, offset: msg.offset })
        pendingBytes += msg.data.length
        scheduleFlush()
        return
      }
      if (pending.length) flushPending() // 保序：先补攒下的，再写新块
      term.write(msg.data, () => wsClient.queueAck(sessionId, msg.offset))
    }
  }

  function fitNow() {
    if (!fit || !term || !container) return
    if (container.clientWidth < 20 || container.clientHeight < 20) return
    // 贴底时 resize/reflow 后保持贴底（xterm reflow 在大 scrollback 下视口可能漂移）
    const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY
    try {
      fit.fit()
    } catch {
      return
    }
    if (wasAtBottom) term.scrollToBottom()
    if (term.cols !== lastReported.cols || term.rows !== lastReported.rows) {
      lastReported = { cols: term.cols, rows: term.rows }
      wsClient.send({ type: 'resize', sessionId, cols: term.cols, rows: term.rows })
    }
  }

  function scheduleFit() {
    if (fitTimer !== null) return
    fitTimer = window.setTimeout(() => {
      fitTimer = null
      fitNow()
    }, 150)
  }

  function setFontSize(size: number) {
    if (!term) return
    term.options.fontSize = size
    scheduleFit()
  }

  function setColorTheme(mode: 'dark' | 'light') {
    if (!term) return
    term.options.theme = mode === 'light' ? LIGHT_TERM_THEME : DARK_TERM_THEME
  }

  function focus() {
    term?.focus()
  }

  function scrollToBottom() {
    term?.scrollToBottom()
  }

  function unmount() {
    offMsg?.()
    offOpen?.()
    wsClient.send({ type: 'detach', sessionId })
    if (fitTimer !== null) clearTimeout(fitTimer)
    if (flushTimer !== null) clearTimeout(flushTimer)
    cancelSettleGuard()
    stopMomentum()
    pending = []
    pendingBytes = 0
    window.visualViewport?.removeEventListener('resize', scheduleFit)
    if (container) {
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
      container.removeEventListener('scroll', onAnyScroll, { capture: true })
      container.removeEventListener('wheel', onWheelIntent)
    }
    if (viewportEl) {
      viewportEl.removeEventListener('touchmove', onViewportTouchMove, { capture: true })
    }
    if (imeListeners) {
      const { el: iel, onComp, onKeyCapture, onBeforeInput } = imeListeners
      for (const t of ['compositionstart', 'compositionupdate', 'compositionend'] as const) {
        iel.removeEventListener(t, onComp, { capture: true })
      }
      iel.removeEventListener('keydown', onKeyCapture, { capture: true })
      iel.removeEventListener('keypress', onKeyCapture, { capture: true })
      iel.removeEventListener('beforeinput', onBeforeInput, { capture: true })
      iel.removeEventListener('input', onBeforeInput, { capture: true })
      imeListeners = null
    }
    viewportEl = null
    resizeObserver?.disconnect()
    term?.dispose()
    term = null
    fit = null
    container = null
  }

  return { mount, unmount, attach, focus, fitNow, setFontSize, setColorTheme, scrollToBottom }
}
