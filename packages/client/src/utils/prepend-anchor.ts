// 顶部插入内容后，把视口钉回原来那条消息上。
// 锚点取「视口里第一条消息」而不是 DOM 第一条：加载更早时视口本来就在顶部附近，第一条通常可见；
// 但若用户中途滑过，DOM 首条在屏外，按它算位移会把视口带偏。
// 正常情况下浏览器自带的滚动锚定已经在布局时把位置钉住（此时 delta≈0，这里什么都不做，避免二次补偿），
// 只在它没兜住、或图片/折叠块晚一帧才量高时补一次。
export async function prependKeepingAnchor(
  el: HTMLElement,
  insert: () => Promise<void>,
  frames = 3
): Promise<void> {
  const box = el.getBoundingClientRect()
  const anchor =
    [...el.querySelectorAll<HTMLElement>('.msg')].find((m) => m.getBoundingClientRect().bottom > box.top + 1) ??
    null
  const before = anchor?.getBoundingClientRect().top ?? 0
  await insert()
  if (!anchor) return
  const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  let delta = anchor.getBoundingClientRect().top - before
  for (let i = 0; i <= frames && Math.abs(delta) >= 1; i++) {
    el.scrollTop += delta
    await raf()
    delta = anchor.getBoundingClientRect().top - before
  }
}

/** 视口被消息气泡覆盖的比例；低说明屏上大片留白（一页全是被折叠的工具/思考） */
export function messageCoverage(el: HTMLElement): number {
  const box = el.getBoundingClientRect()
  if (!box.height) return 1
  let covered = 0
  for (const m of el.querySelectorAll<HTMLElement>('.msg')) {
    const r = m.getBoundingClientRect()
    if (r.bottom <= box.top || r.top >= box.bottom) continue
    covered += Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)
  }
  return covered / box.height
}
