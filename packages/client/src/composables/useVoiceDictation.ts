// 语音输入：麦克风 → 16k PCM 帧 → /ws/asr → 豆包流式 ASR。
// 交互与 Hermes-live 一致：点一下开始持续收音，VAD 自动断句，中间结果实时写进输入框；
// 再点一下停止。识别文字只填入输入框，不自动发送。
import { ref, onBeforeUnmount } from 'vue'

export interface VoiceDictationOptions {
  getText: () => string
  setText: (value: string) => void
  onError?: (message: string) => void
}

const FRAME_LIMIT = 64 * 1024 // 上行背压：隧道抖动时宁可丢帧，也不让旧音频堆积

function joinText(base: string, add: string): string {
  if (!base) return add
  if (!add) return base
  const needSpace = /[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(add)
  return base.replace(/\s+$/, '') + (needSpace ? ' ' : '') + add
}

export function useVoiceDictation(opts: VoiceDictationOptions) {
  const listening = ref(false)
  const starting = ref(false)
  const partial = ref('')

  let ws: WebSocket | null = null
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let node: AudioWorkletNode | null = null
  let base = ''

  function cleanup() {
    node?.port.close()
    node = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    void ctx?.close().catch(() => undefined)
    ctx = null
    if (ws) {
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
      ws = null
    }
  }

  function commitPartial() {
    if (!partial.value) return
    base = joinText(base, partial.value)
    opts.setText(base)
    partial.value = ''
  }

  async function start() {
    if (listening.value || starting.value) return
    starting.value = true
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风（需要 HTTPS 或本机访问）')
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      ctx = new AudioContext()
      await ctx.resume()
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}asr-mic-worklet.js`)
      const source = ctx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(ctx, 'asr-mic')
      // worklet 需接入音频图才会被驱动：经 0 增益节点到输出
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute).connect(ctx.destination)

      base = opts.getText()
      partial.value = ''

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${location.host}/ws/asr`)
      ws.binaryType = 'arraybuffer'
      await new Promise<void>((resolve, reject) => {
        if (!ws) return reject(new Error('语音服务连接失败'))
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('语音服务连接失败'))
      })
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        let msg: { type?: string; text?: string; message?: string }
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.type === 'partial' && msg.text) {
          partial.value = msg.text
          opts.setText(joinText(base, msg.text))
        } else if (msg.type === 'final' && msg.text) {
          base = joinText(base, msg.text)
          partial.value = ''
          opts.setText(base)
        } else if (msg.type === 'error') {
          opts.onError?.(msg.message || '语音识别失败')
        }
      }
      ws.onclose = () => {
        if (listening.value) {
          cleanup()
          listening.value = false
          commitPartial()
        }
      }
      node.port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > FRAME_LIMIT) return
        ws.send(event.data)
      }
      ws.send(JSON.stringify({ type: 'start' }))
      listening.value = true
    } catch (err) {
      cleanup()
      throw err
    } finally {
      starting.value = false
    }
  }

  async function stop() {
    if (!listening.value) return
    listening.value = false
    const sock = ws
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'stop' }))
      // 给 sidecar 一点时间把最后一句 final 吐回来
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    cleanup()
    commitPartial()
  }

  async function toggle() {
    if (listening.value) await stop()
    else await start()
  }

  onBeforeUnmount(() => {
    if (listening.value || ws) void stop()
  })

  return { listening, starting, partial, start, stop, toggle }
}
