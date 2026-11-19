// 抖音私信工作台代理（2026-11-19）：把本机 douyin-im-export（127.0.0.1:8021）挂到 areco 的 /douyin 下。
// 目的与待办看板同款：前端同源 iframe 内嵌，免跨域、免另开端口，吃 areco 的会话 cookie 守卫。
// 与 todo-proxy 的唯一差别是路径前缀改写——抖音工作台是单文件前端，内联写死了
// '/api/…'、'/media?…'、'/thumb?…' 这类根绝对路径，挂在子路径下必须在 HTML 里补上 /douyin 前缀，
// 否则 iframe 里的请求会打到 areco 自己的 /api 上。其余请求（含视频 Range）一律原样透传。
import http from 'node:http'
import type { Context, Next } from 'koa'

const DOUYIN_HOST = process.env.DOUYIN_BOARD_HOST || '127.0.0.1'
const DOUYIN_PORT = Number(process.env.DOUYIN_BOARD_PORT || 8021)
const PREFIX = '/douyin'

/** areco 内嵌版式：与 weSaw 页同口径——只留会话列表 ＋ 助手对话框，去掉中间的会话内容与右侧工作区 */
const EMBED_CSS = `<style>
main,main.w0,main.a0,main.w0.a0{grid-template-columns:300px minmax(0,1fr)!important}
section.reader,aside.work,#toggleWork,#toggleAgent{display:none!important}
@media (max-width:760px){
  main,main.w0,main.a0,main.w0.a0{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:40% minmax(0,1fr)!important}
  aside.agentcol{border-left:0;border-top:1px solid var(--line)}
}
</style>`

/** 前端内联的根绝对路径 → 带前缀（只动这三种，别的一概不碰） */
function rewriteHtml(html: string): string {
  const withPrefix = html
    .replace(/(["'])\/api\//g, `$1${PREFIX}/api/`)
    .replace(/(["'])\/media\?/g, `$1${PREFIX}/media?`)
    .replace(/(["'])\/thumb\?/g, `$1${PREFIX}/thumb?`)
  return withPrefix.includes('</head>')
    ? withPrefix.replace('</head>', `${EMBED_CSS}</head>`)
    : withPrefix
}

export function createDouyinProxy() {
  return async (ctx: Context, next: Next) => {
    if (ctx.path !== PREFIX && !ctx.path.startsWith(`${PREFIX}/`)) return next()

    const sub = ctx.path.slice(PREFIX.length) || '/'
    const search = ctx.querystring ? `?${ctx.querystring}` : ''
    const hasBody = ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH'
    let payload: Buffer | null = null
    if (hasBody) {
      const b = (ctx.request as unknown as { body?: unknown }).body
      payload = Buffer.from(typeof b === 'string' ? b : JSON.stringify(b ?? {}), 'utf-8')
    }

    await new Promise<void>((resolve) => {
      const headers: Record<string, string | number> = {
        host: `${DOUYIN_HOST}:${DOUYIN_PORT}`,
        accept: String(ctx.headers.accept || '*/*'),
      }
      // 视频/图片按 Range 取，直传浏览器带来的 Range 才能拖动进度条
      if (ctx.headers.range) headers.range = String(ctx.headers.range)
      if (hasBody) {
        headers['content-type'] = String(ctx.headers['content-type'] || 'application/json; charset=utf-8')
        headers['content-length'] = payload ? payload.length : 0
      }
      const req = http.request(
        {
          host: DOUYIN_HOST,
          port: DOUYIN_PORT,
          path: `${sub}${search}`,
          method: ctx.method,
          headers,
          timeout: 30000,
        },
        (res) => {
          const type = String(res.headers['content-type'] || '')
          ctx.status = res.statusCode || 502
          ctx.set('cache-control', 'no-store')
          if (type.includes('text/html')) {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              ctx.type = 'text/html; charset=utf-8'
              ctx.body = rewriteHtml(Buffer.concat(chunks).toString('utf-8'))
              resolve()
            })
            return
          }
          ctx.set('content-type', type || 'application/octet-stream')
          for (const key of ['accept-ranges', 'content-range', 'content-length']) {
            const v = res.headers[key]
            if (v) ctx.set(key, String(v))
          }
          ctx.body = res
          resolve()
        }
      )
      req.on('timeout', () => req.destroy(new Error('抖音工作台超时')))
      req.on('error', (e: Error) => {
        ctx.status = 502
        ctx.type = 'text/html; charset=utf-8'
        ctx.body =
          '<!doctype html><meta charset="utf-8"><body style="font:15px/1.7 -apple-system;padding:40px;color:#2b2924">' +
          '<h3>抖音工作台没起来</h3>' +
          '<p>areco 已连上代理，但 <code>127.0.0.1:8021</code> 没有响应：' +
          String(e.message) +
          '</p><p>到 <code>~/Code/douyin-im-export</code> 执行 <code>python3 serve.py</code> 后刷新本页。</p></body>'
        resolve()
      })
      if (payload) req.write(payload)
      req.end()
    })
  }
}
