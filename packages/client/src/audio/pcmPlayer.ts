export class AudioBlockedError extends Error {
  constructor() {
    super('浏览器尚未允许声音')
    this.name = 'AudioBlockedError'
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

  async unlock(): Promise<void> {
    if (typeof AudioContext === 'undefined') throw new Error('当前浏览器不支持 Web Audio')
    this.context ??= new AudioContext()
    if (this.context.state !== 'running') await this.context.resume()
    if (this.context.state !== 'running') throw new AudioBlockedError()
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
      await Promise.all(completions)
      if (generation !== this.generation) throw new PcmCancelledError()
    } catch (err) {
      if (generation !== this.generation) throw new PcmCancelledError()
      throw err
    } finally {
      if (this.reader === reader) this.reader = null
    }
  }

  stop(): void {
    this.generation++
    const reader = this.reader
    this.reader = null
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
