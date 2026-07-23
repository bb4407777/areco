// areco 语音输入 AudioWorklet 处理器：跑在独立音频线程，把麦克风 Float32 样本转 Int16 PCM，
// 累积到 chunk 样本数后投递到主线程（transferable，零拷贝）。16kHz 单声道，2048 样本/块 = 128ms/块。
// 采集不占主线程——UI 卡顿也不会丢音频帧。移植自白龙马 voice-core.js 的 PcmCaptureProcessor
// （web 版去掉 Electron 的 Blob URL hack，vite 直接把 public/ 原样 serve 到根）。
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const chunk = options && options.processorOptions && options.processorOptions.chunk
    this._size = chunk || 2048
    this._buf = new Int16Array(this._size)
    this._n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i]
        if (s > 1) s = 1
        else if (s < -1) s = -1
        this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff
        if (this._n >= this._size) {
          const out = this._buf.slice(0, this._n)
          this.port.postMessage(out.buffer, [out.buffer])
          this._n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
