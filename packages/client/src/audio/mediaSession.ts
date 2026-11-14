/**
 * iOS 静音键的绕道：WKWebView 里 Web Audio 的输出受侧边静音开关支配（实测拨到静音整场无声），
 * 而媒体元素（<audio>）走的是媒体通道，不受静音键影响。
 *
 * 做法：在用户手势里起一个无声的循环 <audio>，把页面音频会话钉在「媒体播放」通道上；
 * Web Audio 随后复用同一个会话输出，静音键开着也能听见。元素只有几十字节静音 PCM，
 * 页面存活期间常驻，不增加可感知的耗电与流量。
 */

/** 0.25 秒 8kHz 单声道 16bit 静音 WAV，转成 data URL 当循环源。 */
function silentWavUrl(): string {
  const rate = 8000
  const samples = Math.floor(rate * 0.25)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples * 2, true)
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return `data:audio/wav;base64,${btoa(binary)}`
}

let holder: HTMLAudioElement | null = null

/** 必须在用户手势里调一次（点播报即手势）；重复调用无副作用。 */
export function holdMediaSession(): void {
  if (holder) return
  try {
    const audio = new Audio(silentWavUrl())
    audio.loop = true
    audio.volume = 0
    audio.setAttribute('playsinline', '')
    holder = audio
    void audio.play().catch(() => {
      // 手势丢失或系统拒绝：撤掉，下次点击再试
      holder = null
    })
  } catch {
    holder = null
  }
}
