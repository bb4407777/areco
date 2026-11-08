import { PcmCancelledError, type SpeechPlayer } from './pcmPlayer'

/** 24k PCM16LE 单声道加 44 字节 WAV 头；长度按实际字节填，Safari 才能算准时长。 */
export function pcm16ToWav(pcm: Uint8Array, sampleRate = 24000): Blob {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)                 // PCM
  view.setUint16(22, 1, true)                 // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)    // 字节率
  view.setUint16(32, 2, true)                 // 块对齐
  view.setUint16(34, 16, true)                // 位深
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  // 复制成独立 ArrayBuffer：Uint8Array 可能只是某个 SharedArrayBuffer 的视图，Blob 不收
  const body = new Uint8Array(pcm.byteLength)
  body.set(pcm)
  return new Blob([header, body.buffer as ArrayBuffer], { type: 'audio/wav' })
}

/**
 * iOS 上的播报播放器。
 * Web Audio 在 WKWebView / Safari 里受侧边静音开关支配（拨到静音就一点声都没有），
 * <audio> 走的是媒体通道，不受静音键影响，所以 iOS 一律用它。
 * 代价是要收完整段再播：服务端本来就是边合成边推，等待约等于合成耗时。
 */
export class WavElementPlayer implements SpeechPlayer {
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  private generation = 0
  /** play() 里等 onended 的收口函数：stop() 时必须调它，否则 await 永远悬着、队列卡死 */
  private settle: (() => void) | null = null

  async unlock(): Promise<void> {
    // 媒体通道无需 AudioContext 解锁；这里只清理上一段（走 stop，暂停而不是丢掉引用）。
    this.stop()
  }

  async play(stream: ReadableStream<Uint8Array>): Promise<void> {
    this.stop()
    const generation = this.generation
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (generation !== this.generation) throw new PcmCancelledError()
        if (value?.byteLength) {
          chunks.push(value)
          total += value.byteLength
        }
      }
      if (generation !== this.generation) throw new PcmCancelledError()
      if (!total) throw new Error('语音服务未返回音频')

      const pcm = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        pcm.set(chunk, offset)
        offset += chunk.byteLength
      }

      const url = URL.createObjectURL(pcm16ToWav(pcm))
      // 复用同一个 <audio> 元素：逐句播报时每句新建 Audio，iOS 会对新元素重新查自动播放许可，
      // 第二句起就可能被拦（表现为播一句就没声）。整段播报共用解锁过的那个元素。
      this.release()
      const audio = this.ensureAudio()
      this.url = url
      audio.src = url

      await new Promise<void>((resolve, reject) => {
        this.settle = resolve
        audio.onended = () => resolve()
        audio.onerror = () => reject(new Error('音频播放失败'))
        audio.play().catch((err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
      if (generation !== this.generation) throw new PcmCancelledError()
    } finally {
      if (this.settle) this.settle = null
    }
  }

  /** 元素只建一次并长期留着；stop() 只暂停，不丢引用。 */
  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio()
      this.audio.preload = 'auto'
    }
    return this.audio
  }

  stop(): void {
    this.generation++
    const audio = this.audio
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.src = ''
    }
    // 先收口挂起的 play()，再放手引用：否则新一段播报永远排在这一段后面（表现为点了没反应）
    const settle = this.settle
    this.settle = null
    settle?.()
    this.release()
  }

  private release(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
  }
}

/** iOS/iPadOS 的 WebKit 都受静音开关支配；桌面 Safari 不受影响，走流式 Web Audio 即可。 */
export function isIOSLike(): boolean {
  const ua = navigator.userAgent
  if (/iP(hone|ad|od)/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
