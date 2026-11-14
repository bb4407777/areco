import { holdMediaSession } from './mediaSession'

export class AudioBlockedError extends Error {
  constructor() {
    super('浏览器尚未允许声音')
    this.name = 'AudioBlockedError'
  }
}

/** 服务端这段没合成出音频（例如只有标点）：跳过这一句，不当作播报失败 */
export class EmptyAudioError extends Error {
  constructor() {
    super('语音服务未返回音频')
    this.name = 'EmptyAudioError'
  }
}

export class PcmCancelledError extends Error {
  constructor() {
    super('播放已停止')
    this.name = 'PcmCancelledError'
  }
}

/** 跨网络 chunk 保留奇数字节，确保 PCM16LE 样本边界不漂移。 */
export class Pcm16Decoder {
  private pending: number | null = null

  push(chunk: Uint8Array): Float32Array {
    let bytes = chunk
    if (this.pending !== null) {
      bytes = new Uint8Array(chunk.byteLength + 1)
      bytes[0] = this.pending
      bytes.set(chunk, 1)
      this.pending = null
    }
    const sampleCount = Math.floor(bytes.byteLength / 2)
    const out = new Float32Array(sampleCount)
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2)
    for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(i * 2, true) / 32768
    if (bytes.byteLength % 2) this.pending = bytes[bytes.byteLength - 1]!
    return out
  }
}

export interface SpeechPlayer {
  unlock(): Promise<void>
  play(stream: ReadableStream<Uint8Array>): Promise<void>
  stop(): void
}

/** 全局单 AudioContext；24kHz PCM 由 Web Audio 重采样到设备采样率。 */
export class PcmPlayer implements SpeechPlayer {
  private context: AudioContext | null = null
  private generation = 0
  private sources = new Set<AudioBufferSourceNode>()
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  /** 唤醒 play() 里等 onended 的等待：音频会话被挂起时 onended 不会来 */
  private interrupt: (() => void) | null = null
  /** 播放中每秒看一次上下文状态，挂起即报「被拦」而不是无限等 */
  private guardTimer: ReturnType<typeof setInterval> | null = null

  async unlock(): Promise<void> {
    if (typeof AudioContext === 'undefined') throw new Error('当前浏览器不支持 Web Audio')
    this.context ??= new AudioContext()
    if (this.context.state !== 'running') await this.context.resume()
    if (this.context.state !== 'running') throw new AudioBlockedError()
    // 借媒体元素把音频会话钉在播放通道，静音键开着也能出声（见 mediaSession.ts）
    holdMediaSession()
  }

  async play(stream: ReadableStream<Uint8Array>): Promise<void> {
    const context = this.context
    if (!context || context.state !== 'running') throw new AudioBlockedError()
    this.stop()
    const generation = this.generation
    const reader = stream.getReader()
    this.reader = reader
    const decoder = new Pcm16Decoder()
    const completions: Promise<void>[] = []
    let nextTime = context.currentTime + 0.04
    // stop() 也要能把这里唤醒：音频会话被系统挂起时 source 的 onended 永远不来，
    // 只靠 Promise.all(completions) 会把队列卡死在「播报中」，再点只会重复 stop。
    const interrupted = new Promise<never>((_, reject) => {
      this.interrupt = () => reject(new PcmCancelledError())
    })
    interrupted.catch(() => {})
    const suspendGuard = new Promise<never>((_, reject) => {
      this.guardTimer = setInterval(() => {
        if (context.state !== 'running') reject(new AudioBlockedError())
      }, 1000)
    })
    suspendGuard.catch(() => {})

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (generation !== this.generation) throw new PcmCancelledError()
        if (!value?.byteLength) continue
        const samples = decoder.push(value)
        if (!samples.length) continue
        const buffer = context.createBuffer(1, samples.length, 24000)
        buffer.getChannelData(0).set(samples)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        this.sources.add(source)
        completions.push(new Promise<void>((resolve) => {
          source.onended = () => {
            this.sources.delete(source)
            source.disconnect()
            resolve()
          }
        }))
        source.start(nextTime)
        nextTime += buffer.duration
      }
      await Promise.race([Promise.all(completions), interrupted, suspendGuard])
      if (generation !== this.generation) throw new PcmCancelledError()
    } catch (err) {
      if (generation !== this.generation) throw new PcmCancelledError()
      throw err
    } finally {
      this.interrupt = null
      if (this.guardTimer !== null) {
        clearInterval(this.guardTimer)
        this.guardTimer = null
      }
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
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // 已结束的 source 无需重复停止。
      }
    }
    this.sources.clear()
  }
}
