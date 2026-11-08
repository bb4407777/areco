/**
 * 播报用的客户端分句器，逐条规则对齐 voice/server/sentencer.py。
 *
 * 为什么要在这里分句：iOS 的 `<audio>` 必须收完整段才能播（Web Audio 会被静音键掐掉），
 * 所以「一条长消息 = 一次 /api/tts」在手机上等于要等整段合成完才出声（实测 600 字 76 秒）。
 * 客户端先切成句、逐句请求，首句合成完就能播，后面的边播边合成。
 */

const HARD_BREAKS = new Set('。！？!?；;…\n')
const SOFT_BREAKS = new Set('，、,')
// 末尾不带句号：带了会被硬断成独立一句、还把下一句的句首字符甩到下一块
export const CODE_PLACEHOLDER = '（这里有段代码，略过）'

const MD_PATTERNS: Array<[RegExp, string]> = [
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/`/g, ''],
  [/\*\*|__|\*|~~/g, ''],
  [/^#{1,6}\s*/gm, ''],
  [/^\s*[-*+]\s+/gm, ''],
  [/^\s*\d+\.\s+/gm, ''],
]

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F000}-\u{1F0FF}\u{2600}-\u{26FF}\u{FE0F}\u{1F900}-\u{1F9FF}]+/gu

function clean(text: string): string {
  let out = text
  for (const [pattern, replacement] of MD_PATTERNS) out = out.replace(pattern, replacement)
  return out.replace(EMOJI, '')
}

export class SentenceAssembler {
  private buf = ''
  private raw = ''
  private inCode = false
  private emittedAny = false

  constructor(private readonly maxBuffer = 50, private readonly firstMin = 10) {}

  feed(delta: string): string[] {
    this.raw += delta
    while (true) {
      const idx = this.raw.indexOf('```')
      if (idx < 0) break
      const head = this.raw.slice(0, idx)
      this.raw = this.raw.slice(idx + 3)
      if (!this.inCode) {
        this.buf += clean(head)
        this.inCode = true
      } else {
        this.inCode = false
        this.buf += CODE_PLACEHOLDER
      }
    }
    // 末尾两字可能是被切开的 ``` 或半个转义，先留在 raw 里等下一批
    if (!this.inCode && this.raw.length > 2) {
      this.buf += clean(this.raw.slice(0, -2))
      this.raw = this.raw.slice(-2)
    }
    return this.drain()
  }

  flush(): string[] {
    const tail = this.inCode ? '' : this.raw
    this.raw = ''
    this.inCode = false
    this.buf += clean(tail)
    const out = this.drain()
    const rest = this.buf.trim()
    this.buf = ''
    if (rest) {
      out.push(rest)
      this.emittedAny = true
    }
    return out
  }

  private drain(): string[] {
    const out: string[] = []
    while (true) {
      let cut = -1
      for (let i = 0; i < this.buf.length; i++) {
        const ch = this.buf[i]
        if (HARD_BREAKS.has(ch)) {
          cut = i
          break
        }
        if (SOFT_BREAKS.has(ch)) {
          if (this.buf.length > this.maxBuffer) {
            cut = i
            break
          }
          if (!this.emittedAny && out.length === 0 && i + 1 >= this.firstMin) {
            cut = i
            break
          }
        }
      }
      if (cut < 0) break
      const sentence = this.buf.slice(0, cut + 1).trim()
      this.buf = this.buf.slice(cut + 1)
      if (sentence.replace(/[。！？!?；;…，、,\s]/g, '')) {
        out.push(sentence)
        this.emittedAny = true
      }
    }
    return out
  }
}

/** 整段文本 → 可逐句请求的句子数组；空文本返回空数组。 */
export function splitForSpeech(text: string, maxBuffer = 50, firstMin = 10): string[] {
  if (!text.trim()) return []
  const assembler = new SentenceAssembler(maxBuffer, firstMin)
  return [...assembler.feed(text), ...assembler.flush()]
}
