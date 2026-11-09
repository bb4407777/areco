// 采集 worklet：设备采样率 → 线性重采样 16k → 512 样本 Int16 帧 postMessage。
// 移植自 hermes-live web/worklets/mic-processor.js，供语音输入使用。
const OUT_SAMPLES = 512 // 16k 下 32ms，与 ASR sidecar 约定一致
const SCRATCH = 1 << 10

class AsrMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.srcPos = 0
    this.scratch = new Float32Array(SCRATCH)
    this.carryLen = 0
    this.out = new Int16Array(OUT_SAMPLES)
    this.outIdx = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true

    const buf = this.scratch
    const carry = this.carryLen
    if (carry + ch.length > SCRATCH) {
      this.carryLen = 0
      this.srcPos = 0
      return true
    }
    buf.set(ch, carry)
    const n = carry + ch.length

    let pos = this.srcPos
    while (pos + 1 < n) {
      const i = pos | 0
      const frac = pos - i
      const s = buf[i] + (buf[i + 1] - buf[i]) * frac
      this.out[this.outIdx++] = s < -1 ? -32768 : s > 0.99997 ? 32767 : (s * 32768) | 0
      if (this.outIdx === OUT_SAMPLES) {
        const copy = this.out.slice(0)
        this.port.postMessage(copy.buffer, [copy.buffer])
        this.outIdx = 0
      }
      pos += this.ratio
    }

    const keep = Math.min(pos | 0, n - 1)
    buf.copyWithin(0, keep, n)
    this.carryLen = n - keep
    this.srcPos = pos - keep
    return true
  }
}

registerProcessor('asr-mic', AsrMicProcessor)
