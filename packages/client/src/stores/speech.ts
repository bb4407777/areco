import { defineStore } from 'pinia'
import { AudioBlockedError, EmptyAudioError, PcmCancelledError, type SpeechPlayer } from '../audio/pcmPlayer'
import { createSpeechPlayer, syncNativeAudioAuto } from '../audio/nativePlayer'
import { splitForSpeech } from '../audio/sentences'

type AudioResult = { response: Response } | { error: unknown }

export interface SpeechItem {
  messageId: string
  text: string
}

interface QueueEntry {
  item: SpeechItem
  manual: boolean
  /** 自动播报：这条消息到目前为止的全文；念的是尾巴时据此记账，下轮才知道念到哪 */
  fullText?: string
}

interface SpeechEvents {
  onPlaying?: (messageId: string | null) => void
  onBlocked?: (blocked: boolean) => void
  onError?: (message: string | null) => void
}

/** 与 Vue 解耦的队列核心，便于 Fake TTS/播放器单测。 */
export class SpeechQueue {
  autoEnabled = false
  private queue: QueueEntry[] = []
  private current: QueueEntry | null = null
  private generation = 0
  private pumping = false
  private abort: AbortController | null = null
  private readonly playedAuto = new Map<string, string>()
  private readonly pendingAuto = new Set<string>()

  constructor(
    private readonly player: SpeechPlayer = createSpeechPlayer(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly events: SpeechEvents = {},
  ) {}

  playManual(item: SpeechItem) {
    if (!item.text.trim()) return
    this.generation++
    this.abort?.abort()
    this.player.stop()
    this.queue = []
    this.pendingAuto.clear()
    this.queue.push({ item, manual: true })
    this.pump()
  }

  enqueueAuto(item: SpeechItem): boolean {
    if (!this.autoEnabled) return false
    const full = item.text.trim()
    if (!full) return false
    // 同一条消息续写：键不变，只念新增的尾巴，不再从头念一遍
    const spoken = this.playedAuto.get(item.messageId)
    if (spoken === full) return false
    if (spoken !== undefined && !full.startsWith(spoken)) return false
    if (this.pendingAuto.has(item.messageId)) return false
    if (this.current?.manual || this.queue.some((entry) => entry.manual)) return false
    const text = spoken === undefined ? full : full.slice(spoken.length).trim()
    if (!text) return false
    this.pendingAuto.add(item.messageId)
    this.queue.push({ item: { messageId: item.messageId, text }, manual: false, fullText: full })
    this.pump()
    return true
  }

  setAutoEnabled(enabled: boolean) {
    this.autoEnabled = enabled
    if (enabled) return
    this.queue = this.queue.filter((entry) => entry.manual)
    this.pendingAuto.clear()
    if (this.current && !this.current.manual) this.stop()
  }

  stop() {
    this.generation++
    this.queue = []
    this.pendingAuto.clear()
    this.abort?.abort()
    this.abort = null
    this.player.stop()
    this.current = null
    this.events.onPlaying?.(null)
  }

  async resumeAudio(): Promise<boolean> {
    try {
      await this.player.unlock()
      this.events.onBlocked?.(false)
      return true
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  hasPlayedAuto(messageId: string): boolean {
    return this.playedAuto.has(messageId)
  }

  /**
   * 逐句请求音频并顺序播放。
   *
   * 一条消息只发一次 /api/tts 时，iOS 的 <audio> 要等整段合成完才出声（600 字 76 秒）；
   * 切成句子后首句合成完即可播，另留 LOOKAHEAD 句预取，播放与合成并行。
   */
  private async speak(text: string, generation: number, signal: AbortSignal): Promise<void> {
    const sentences = splitForSpeech(text)
    if (!sentences.length) return
    const lookahead = 2
    const inflight: Array<Promise<AudioResult>> = []
    let next = 0
    const launch = () => {
      while (inflight.length < lookahead && next < sentences.length) {
        inflight.push(this.requestAudio(sentences[next++], signal))
      }
    }
    launch()
    while (inflight.length) {
      const result = await inflight.shift()!
      if (generation !== this.generation || signal.aborted) throw new PcmCancelledError()
      launch()
      if ('error' in result) throw result.error
      const response = result.response
      if (!response.ok) throw new Error(`语音服务 HTTP ${response.status}`)
      if (!response.body) throw new Error('语音服务未返回音频流')
      try {
        await this.player.play(response.body)
      } catch (err) {
        // 这一句没合成出音频（纯符号、服务端跳过）：继续下一句，不弹「播报失败」
        if (err instanceof EmptyAudioError) continue
        throw err
      }
    }
  }

  /** 单句请求。错误收进返回值而不是抛出：预取是提前创建的，未消费的 rejection 会变成未处理异常。 */
  private async requestAudio(text: string, signal: AbortSignal): Promise<AudioResult> {
    try {
      const response = await this.fetchImpl('/api/tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      })
      return { response }
    } catch (error) {
      return { error }
    }
  }

  private pump() {
    if (this.pumping) return
    this.pumping = true
    void (async () => {
      while (this.queue.length) {
        const entry = this.queue.shift()!
        const generation = this.generation
        this.current = entry
        this.events.onPlaying?.(entry.item.messageId)
        this.events.onError?.(null)
        const controller = new AbortController()
        this.abort = controller
        let succeeded = false
        try {
          await this.player.unlock()
          if (generation !== this.generation) continue
          this.events.onBlocked?.(false)
          await this.speak(entry.item.text, generation, controller.signal)
          if (generation !== this.generation) continue
          succeeded = true
        } catch (err) {
          if (generation !== this.generation || controller.signal.aborted || err instanceof PcmCancelledError) continue
          if (err instanceof AudioBlockedError || (err instanceof Error && err.name === 'AudioBlockedError')) {
            this.events.onBlocked?.(true)
            // 自动播放被浏览器拦住：清空待播且不认作已播，等用户手势恢复后再接新消息。
            this.queue = this.queue.filter((item) => item.manual)
            this.pendingAuto.clear()
          } else {
            this.events.onError?.(err instanceof Error ? err.message : String(err))
          }
        } finally {
          if (this.abort === controller) this.abort = null
          if (this.current === entry) {
            this.current = null
            this.events.onPlaying?.(null)
          }
          if (!entry.manual) {
            this.pendingAuto.delete(entry.item.messageId)
            if (succeeded) this.playedAuto.set(entry.item.messageId, entry.fullText ?? entry.item.text)
          }
        }
      }
      this.pumping = false
      if (this.queue.length) this.pump()
    })()
  }
}

let queue: SpeechQueue | null = null

export const useSpeechStore = defineStore('speech', {
  state: () => ({
    autoEnabled: false,
    playingId: null as string | null,
    blocked: false,
    error: null as string | null,
  }),
  actions: {
    core(): SpeechQueue {
      if (!queue) {
        queue = new SpeechQueue(createSpeechPlayer(), globalThis.fetch.bind(globalThis), {
          onPlaying: (id) => { this.playingId = id },
          onBlocked: (blocked) => { this.blocked = blocked },
          onError: (error) => { this.error = error },
        })
        queue.setAutoEnabled(this.autoEnabled)
      }
      return queue
    },
    playManual(item: SpeechItem) {
      this.core().playManual(item)
    },
    enqueueAuto(item: SpeechItem): boolean {
      return this.core().enqueueAuto(item)
    },
    setAutoEnabled(enabled: boolean) {
      this.autoEnabled = enabled
      this.core().setAutoEnabled(enabled)
      // 壳里后台要能收到新消息并自动播，得让原生留一路静音保活
      syncNativeAudioAuto(enabled)
    },
    stop() {
      this.core().stop()
    },
    async resumeAudio() {
      await this.core().resumeAudio()
    },
  },
})
