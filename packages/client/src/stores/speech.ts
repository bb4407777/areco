import { defineStore } from 'pinia'
import { AudioBlockedError, PcmCancelledError, PcmPlayer, type SpeechPlayer } from '../audio/pcmPlayer'
import { WavElementPlayer, isIOSLike } from '../audio/wavPlayer'

export interface SpeechItem {
  messageId: string
  text: string
}

interface QueueEntry {
  item: SpeechItem
  manual: boolean
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
  private readonly playedAuto = new Set<string>()
  private readonly pendingAuto = new Set<string>()

  constructor(
    private readonly player: SpeechPlayer = new PcmPlayer(),
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
    if (!this.autoEnabled || !item.text.trim()) return false
    if (this.playedAuto.has(item.messageId) || this.pendingAuto.has(item.messageId)) return false
    if (this.current?.manual || this.queue.some((entry) => entry.manual)) return false
    this.pendingAuto.add(item.messageId)
    this.queue.push({ item, manual: false })
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
          const response = await this.fetchImpl('/api/tts', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: entry.item.text }),
            signal: controller.signal,
          })
          if (generation !== this.generation) continue
          if (!response.ok) throw new Error(`语音服务 HTTP ${response.status}`)
          if (!response.body) throw new Error('语音服务未返回音频流')
          await this.player.play(response.body)
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
            if (succeeded) this.playedAuto.add(entry.item.messageId)
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
        // iOS 上用 <audio> 播放（Web Audio 会被侧边静音开关掐掉），其余端仍是流式 Web Audio
        const player: SpeechPlayer = isIOSLike() ? new WavElementPlayer() : new PcmPlayer()
        queue = new SpeechQueue(player, globalThis.fetch.bind(globalThis), {
          onPlaying: (id) => { this.playingId = id },
          onBlocked: (blocked) => { this.blocked = blocked },
          onError: (error) => { this.error = error },
        })
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
    },
    stop() {
      this.core().stop()
    },
    async resumeAudio() {
      await this.core().resumeAudio()
    },
  },
})
