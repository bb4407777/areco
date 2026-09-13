// 打字机步进：transcript 按步落盘（一步一大坨、间隔数秒），前端匀速吐字造连续体感。
// 积压越多每拍吐越多（pending/80，封顶一拍 24 字），追得上新落盘的内容但不瞬贴——
// 快追时仍保持"在打字"的观感；追平后返回 0，调用方停表等下一坨。
export const TYPEWRITER_TICK_MS = 55

export function typewriterStep(shownLen: number, fullLen: number): number {
  const pending = fullLen - shownLen
  if (pending <= 0) return 0
  return Math.min(24, Math.max(1, Math.ceil(pending / 80)))
}
