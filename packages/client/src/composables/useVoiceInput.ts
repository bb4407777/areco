// 语音输入（长按说话→转写）：getUserMedia + AudioContext(16kHz) + AudioWorklet 采 Int16 PCM，
// 累积内存；松手拼 WAV 整段 POST /api/voice/transcribe → 回填输入框 / 直接发送。
// 克隆 useFileDrop 的 composable 约定（Options 对象 + 返回 ref/函数，状态局部不放 store）。
// 采集处理器在 packages/client/public/voice-processor.js（vite 原样 serve 到根，addModule('/voice-processor.js')）。
import { onUnmounted, ref, type Ref } from 'vue'
import { useMessage } from 'naive-ui'

type InputEl = HTMLTextAreaElement | HTMLInputElement

export interface VoiceOptions {
  text: Ref<string> // 绑定的输入文本，转写结果填这里（沿用 useFileDrop 的 text 回填模式）
  inputEl: Ref<InputEl | null> // 输入元素，填入模式聚焦+光标到末尾
  afterFill?: () => void // 回填后的额外动作（textarea 自动长高），可选
  onSubmit?: () => void // 松开直接发模式：转写完调用（PromptBar 绑成 () => send()）
  engine: Ref<string> // ASR 引擎：funasr/sensevoice/aliyun/whisper，随请求带
  hotwords: Ref<string> // 热词，空格分隔（仅 paraformer 用）
  fillMode: Ref<'send' | 'fill'> // 松开后：send=直接发送（默认），fill=仅填入
}

const TARGET_SR = 16000

export function useVoiceInput(opts: VoiceOptions) {
  const message = useMessage()
  const recording = ref(false)
  const transcribing = ref(false)
  const error = ref('')

  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let node: AudioWorkletNode | null = null
  let chunks: ArrayBuffer[] = []
  let cancelling = false // 上滑取消标记：松手时不转写不发
  let starting = false // pressStart 异步启动中（getUserMedia/addModule，含首次权限弹窗）
  let pendingStop = false // 启动期间已收到 pressEnd：启动完成后立即收，防权限弹窗时松手致开麦停不下

  async function pressStart() {
    if (recording.value || transcribing.value || starting) return
    starting = true
    pendingStop = false
    error.value = ''
    cancelling = false
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
      })
      // 强制 16kHz AudioContext（浏览器默认常是 44.1/48k）；addModule 必须在 user gesture 内
      const Ctor =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor({ sampleRate: TARGET_SR })
      if (audioCtx.state === 'suspended') await audioCtx.resume()
      await audioCtx.audioWorklet.addModule('/voice-processor.js')
      const src = audioCtx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(audioCtx, 'pcm-capture-processor', { processorOptions: { chunk: 2048 } })
      chunks = []
      node.port.onmessage = (ev: MessageEvent) => chunks.push(ev.data as ArrayBuffer)
      src.connect(node)
      node.connect(audioCtx.destination) // worklet 须连 destination 图才运转（其 process 不写输出=静音，无啸叫）
      if (pendingStop) {
        // 启动期间（含首次麦克风权限弹窗）用户已松手：别真开录，直接收麦
        cleanup()
        return
      }
      recording.value = true
    } catch (err) {
      cleanup()
      error.value = err instanceof Error ? err.message : String(err)
      message.error(`麦克风启动失败：${error.value}`)
    } finally {
      starting = false
    }
  }

  async function pressEnd() {
    if (starting) {
      // 还在异步启动（getUserMedia/权限弹窗/addModule）：标记，pressStart 完成后自查并收麦
      pendingStop = true
      return
    }
    if (!recording.value) return
    recording.value = false
    if (node) node.port.onmessage = null
    const collected = chunks
    chunks = []
    cleanup()
    if (cancelling) return // 上滑取消：不转写不发
    if (collected.length === 0) return
    transcribing.value = true
    try {
      const wav = encodeWav(collected, TARGET_SR)
      const params = new URLSearchParams({ engine: opts.engine.value })
      if (opts.hotwords.value.trim()) params.set('hotwords', opts.hotwords.value.trim())
      const res = await fetch(`/api/voice/transcribe?${params.toString()}`, {
        method: 'POST',
        body: wav,
        headers: { 'content-type': 'application/octet-stream' }, // 强制 octet-stream，避 bodyparser 吞流（同 useFileDrop）
        credentials: 'same-origin',
      })
      if (res.status === 404) throw new Error('语音端点未上线：服务端还是旧版本，重启 8790 后可用')
      const parsed = (await res.json()) as { ok: boolean; data?: { text: string }; error?: { message: string } }
      if (!parsed.ok || !parsed.data) throw new Error(parsed.error?.message ?? `转写失败（HTTP ${res.status}）`)
      const text = parsed.data.text.trim()
      if (!text) {
        message.warning('没听清，请重说一次')
        return
      }
      opts.text.value = text
      opts.afterFill?.()
      if (opts.fillMode.value === 'send') {
        opts.onSubmit?.()
      } else {
        await focusEnd()
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      message.error(`语音转写失败：${error.value}`)
    } finally {
      transcribing.value = false
    }
  }

  function focusEnd() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const el = opts.inputEl.value
        if (el) {
          el.focus()
          const len = el.value.length
          el.setSelectionRange(len, len)
        }
        resolve()
      })
    })
  }

  function cleanup() {
    if (stream) stream.getTracks().forEach((t) => t.stop())
    stream = null
    if (audioCtx) {
      try {
        void audioCtx.close()
      } catch {
        /* ignore */
      }
    }
    audioCtx = null
    node = null
  }

  /** 上滑取消：标记后 pressEnd 跳过转写与发送 */
  function cancel() {
    cancelling = true
    if (recording.value) void pressEnd()
  }

  // iOS 后台/锁屏音频会挂起，中止录音避免半截脏数据
  function onVisibility() {
    if (document.hidden && (recording.value || transcribing.value)) {
      cancelling = true
      void pressEnd()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    cleanup()
  })

  return { recording, transcribing, error, pressStart, pressEnd, cancel }
}

/** 拼 Int16 PCM chunks → WAV Blob（44 字节头 + PCM data，16kHz 单声道 16bit）。 */
function encodeWav(chunkList: ArrayBuffer[], sampleRate: number): Blob {
  const total = chunkList.reduce((n, c) => n + c.byteLength, 0)
  const buffer = new ArrayBuffer(44 + total)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + total, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, total, true)
  const out = new Uint8Array(buffer, 44)
  let offset = 0
  for (const c of chunkList) {
    out.set(new Uint8Array(c), offset)
    offset += c.byteLength
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
