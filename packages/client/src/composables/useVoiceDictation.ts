// 语音输入：麦克风 → 16k PCM 帧 → /ws/asr → 豆包流式 ASR。
// 交互与 Hermes-live 一致：点一下开始持续收音，VAD 自动断句，中间结果实时写进输入框；
// 再点一下停止。断句出 final 时交给 onUtterance——调用方接了它就是「说完自动发送」，
// 不接则退回纯听写（识别文字只填输入框）。
import { ref, onBeforeUnmount } from 'vue'
import { syncNativeMic } from '../audio/nativePlayer'

export interface VoiceDictationOptions {
  getText: () => string
  setText: (value: string) => void
  onError?: (message: string) => void
  /** 一句话断句完成。返回 false/抛出 = 没发出去，文本留在输入框继续累积 */
  onUtterance?: (text: string) => boolean | void | Promise<boolean | void>
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
    // 麦克风已放开：让原生把音频会话复位回播放通道
    syncNativeMic(false)
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
      // 收麦一开就告知原生：它会避开音频会话，不至于把正在播的报推给系统掐掉
      syncNativeMic(true)
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
          const full = joinText(base, msg.text)
          partial.value = ''
          if (!opts.onUtterance) {
            // 纯听写：文字累积在输入框，等人自己按发送
            base = full
            opts.setText(base)
            return
          }
          // 自动发送：先清空本地累积（调用方的 send 会清输入框），发送失败再把全文还回去
          base = ''
          opts.setText('')
          void Promise.resolve(opts.onUtterance(full))
            .then((sent) => {
              if (sent === false) {
                base = full
                opts.setText(full)
              }
            })
            .catch(() => {
              base = full
              opts.setText(full)
            })
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
