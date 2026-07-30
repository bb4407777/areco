// 多端共享 PTY 的 resize 仲裁（2026-07-22：手机端只看一眼就把桌面端挤成手机宽度的实锤 bug）。
// 病根：attach/resize 无条件把共享 PTY 改成最后来者的尺寸。规则：
//  - 控制者（最近一次向该会话发过 input/sendline 的连接）永远可以改尺寸——开车的人用自己的尺寸；
//  - 尚无控制者时先到先得（单端场景与旧行为一致）；
//  - 非控制者只许"更大不许更小"：观看者可以把 PTY 撑大，但不许把它挤小。
//    大端观看时双向都更大才放行，任一维更小都拒（手机竖屏 cols 小 rows 大，照样不许挤窄桌面）。
export interface Dims {
  cols: number
  rows: number
}

export function shouldApplyResize(
  current: Dims,
  next: Dims,
  opts: { isController: boolean; hasController: boolean }
): boolean {
  if (opts.isController || !opts.hasController) return true
  return next.cols >= current.cols && next.rows >= current.rows
}
