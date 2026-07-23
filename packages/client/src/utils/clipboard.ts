// 复制到剪贴板：clipboard API 在非安全上下文（手机走 http://局域网 IP）不可用，
// 备 textarea+execCommand 兜底——须在用户手势（点击）内调用，否则 iOS 拒绝
export async function copyPlainText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    /* 权限被拒/非安全上下文：落兜底 */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}
