/** 从 Vite 首页找入口模块；script 属性顺序不固定，先切标签再独立取 type/src。 */
export function entryAssetFromHtml(html: string, base = 'http://areco.local/'): string | null {
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0]
    if (!/\btype=["']module["']/i.test(tag)) continue
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
    if (!src) continue
    const path = new URL(src, base).pathname
    if (/\/assets\/js\/index-[^/]+\.js$/.test(path)) return path
  }
  return null
}
