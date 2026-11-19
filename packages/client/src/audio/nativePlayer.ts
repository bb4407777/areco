import { EmptyAudioError, PcmCancelledError, PcmPlayer, type SpeechPlayer } from './pcmPlayer'

/**
 * 原生播放通道（iOS 壳）。
 *
 * 壳里注册了 WKScriptMessageHandler "arecoAudio"：网页把 TTS 的 PCM16LE 分片发过去，
 * 由 AVAudioEngine 播。比 Web Audio 强在锁屏/切后台能继续出声——WKWebView 的
 * AudioContext 一进后台就被挂起（2026-11-19 实测）。
 * 浏览器里没有这个 handler，回落 PcmPlayer。
 */
interface NativeAudioHandler {
  postMessage(body: unknown): void
}

/** 锁屏是否继续播报：设置页可改，随每条 config 消息告知原生 */
let backgroundAudio = true

/** 同步后台播放开关到原生（浏览器里没有桥，静默跳过） */
export function syncNativeAudioConfig(enabled: boolean) {
  backgroundAudio = enabled
  nativeHandler()?.postMessage({ t: 'config', background: enabled })
}

/** 原生回调登记表：一句播完由原生 __arecoAudioDone(id) 唤醒对应的 await */
const waiters = new Map<string, (error?: string) => void>()
let hooksInstalled = false

function nativeHandler(): NativeAudioHandler | null {
  const bridge = (window as unknown as {
    webkit?: { messageHandlers?: Record<string, NativeAudioHandler> }
  }).webkit?.messageHandlers?.['arecoAudio']
  return typeof bridge?.postMessage === 'function' ? bridge : null
}

function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true
  const w = window as unknown as Record<string, unknown>
  w.__arecoAudioDone = (id: string) => {
    const settle = waiters.get(id)
    waiters.delete(id)
    settle?.()
  }
  w.__arecoAudioFail = (id: string, message?: string) => {
    const settle = waiters.get(id)
    waiters.delete(id)
    settle?.(message || '原生播放失败')
  }
}

/** Uint8Array → base64；分块拼接，避免大数组一次 apply 爆栈 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

export class NativePcmPlayer implements SpeechPlayer {
  private readonly handler: NativeAudioHandler
  private generation = 0
  private seq = 0
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private interrupt: (() => void) | null = null

  constructor(handler: NativeAudioHandler) {
    this.handler = handler
    installHooks()
  }

  /** 原生播放不受自动播放策略限制，无需用户手势 */
  async unlock(): Promise<void> {}

  async play(stream: ReadableStream<Uint8Array>): Promise<void> {
    this.stop()
    const generation = this.generation
    const id = `a${++this.seq}-${Date.now()}`
    const handler = this.handler
    const reader = stream.getReader()
    this.reader = reader

    const cancelled = new Promise<never>((_, reject) => {
      this.interrupt = () => reject(new PcmCancelledError())
    })
    cancelled.catch(() => {})

    const done = new Promise<void>((resolve, reject) => {
      waiters.set(id, (error) => (error ? reject(new Error(error)) : resolve()))
    })

    let bytes = 0
    // 每次开播带上当前偏好，避免页面刷新后原生还按旧值走
    handler.postMessage({ t: 'config', background: backgroundAudio })
    handler.postMessage({ t: 'start', id })
    try {
      while (true) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        if (generation !== this.generation) throw new PcmCancelledError()
        if (!value?.byteLength) continue
        bytes += value.byteLength
        handler.postMessage({ t: 'chunk', id, b64: toBase64(value) })
      }
      if (generation !== this.generation) throw new PcmCancelledError()
      // 一句里一个样本都没有（纯标点）：服务端没合成出音频，跳过这一句
      if (!bytes) {
        handler.postMessage({ t: 'stop', id })
        waiters.delete(id)
        throw new EmptyAudioError()
      }
      handler.postMessage({ t: 'end', id })
      await Promise.race([done, cancelled])
    } catch (err) {
      waiters.delete(id)
      if (generation !== this.generation) {
        handler.postMessage({ t: 'stop', id })
        throw new PcmCancelledError()
      }
      throw err
    } finally {
      this.interrupt = null
      if (this.reader === reader) this.reader = null
    }
  }

  stop(): void {
    this.generation++
    const interrupt = this.interrupt
    this.interrupt = null
    const reader = this.reader
    this.reader = null
    interrupt?.()
    if (reader) void reader.cancel().catch(() => {})
    this.handler.postMessage({ t: 'stopAll' })
  }
}

/** 壳里用原生通道，浏览器里用 Web Audio */
export function createSpeechPlayer(): SpeechPlayer {
  const handler = nativeHandler()
  return handler ? new NativePcmPlayer(handler) : new PcmPlayer()
}
