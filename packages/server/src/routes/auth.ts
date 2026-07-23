// 登录/登出路由 + SSR 登录页（移植旧版 access-auth.mjs：修复 title 不生效 bug、接入限流、暗色主题对齐新客户端）
import Router from '@koa/router'
import type { Context } from 'koa'
import type { AuthService, LoginLimiter } from '../services/auth'
import { createLogger } from '../logger'

const log = createLogger('login')

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function normalizeNext(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  // 挡 //（协议相对）与 \（Chrome/Safari 把 \ 当 /，/\evil.com 会跳外站）
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  return value
}

function isZh(ctx: Context): boolean {
  const accept = ctx.get('accept-language') || ''
  const first = accept.split(',')[0]?.trim().toLowerCase() ?? ''
  return !first || first.startsWith('zh')
}

function isSecure(ctx: Context): boolean {
  if ((ctx.socket as { encrypted?: boolean }).encrypted) return true
  return (ctx.get('x-forwarded-proto') || '').includes('https')
}

function renderLoginPage(opts: { title: string; zh: boolean; nextPath: string; errorMessage?: string }): string {
  const s = opts.zh
    ? { hint: '请输入访问密码以继续。', label: '密码', button: '继续', lang: 'zh-CN' }
    : { hint: 'Enter the access password to continue.', label: 'Password', button: 'Continue', lang: 'en' }
  const notice = opts.errorMessage
    ? `<p class="error">${escapeHtml(opts.errorMessage)}</p>`
    : `<p class="hint">${escapeHtml(s.hint)}</p>`
  return `<!doctype html>
<html lang="${s.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#101014" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: dark light; font-family: "PingFang SC", "Segoe UI", system-ui, sans-serif; }
  @media (prefers-color-scheme: light) {
    body { background: #f5f6f8 !important; color: #23272f !important; }
    main { background: #ffffff !important; border-color: #e3e5ea !important; box-shadow: 0 12px 40px rgba(16,24,40,.12) !important; }
    .hint { color: #667085 !important; }
    label { color: #667085 !important; }
    input[type="password"] { background: #ffffff !important; color: #23272f !important; border-color: #d3d6de !important; }
    button { background: #0ea373 !important; color: #ffffff !important; }
  }
  @media (hover: none) and (pointer: coarse) { input[type="password"] { font-size: 16px; } }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #101014; color: #e6e6ea; }
  main { width: min(400px, calc(100vw - 40px)); padding: 30px 28px; border-radius: 14px;
         background: #18181d; border: 1px solid #2a2a32; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  h1 { margin: 0 0 8px; font-size: 21px; letter-spacing: .3px; }
  h1 .dot { color: #63e2b7; }
  p { margin: 0 0 18px; line-height: 1.5; font-size: 14px; }
  .hint { color: #9a9aa5; }
  .error { color: #f87171; background: rgba(248,113,113,.08); border: 1px solid rgba(248,113,113,.25);
           border-radius: 8px; padding: 10px 12px; }
  label { display: block; margin-bottom: 8px; font-size: 13px; color: #9a9aa5; }
  input[type="password"] { width: 100%; padding: 12px 14px; border: 1px solid #33333d; border-radius: 9px;
    background: #101014; color: #e6e6ea; font-size: 15px; box-sizing: border-box; outline: none; }
  input[type="password"]:focus { border-color: #63e2b7; }
  button { width: 100%; margin-top: 16px; padding: 12px 14px; border: 0; border-radius: 9px;
    background: #63e2b7; color: #101014; font-size: 15px; font-weight: 700; cursor: pointer; }
  button:active { opacity: .85; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(opts.title)}<span class="dot"> ●</span></h1>
  ${notice}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(opts.nextPath)}" />
    <label for="password">${s.label}</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">${s.button}</button>
  </form>
</main>
</body>
</html>`
}

export function createAuthRouter(auth: AuthService, limiter: LoginLimiter, title: string): Router {
  const router = new Router()

  router.get('/login', (ctx) => {
    const nextPath = normalizeNext(ctx.query.next)
    if (!auth.enabled || auth.isAuthedRequest(ctx.req)) {
      ctx.redirect(nextPath)
      return
    }
    ctx.type = 'text/html; charset=utf-8'
    ctx.set('Cache-Control', 'no-store')
    ctx.body = renderLoginPage({ title, zh: isZh(ctx), nextPath })
  })

  router.post('/login', (ctx) => {
    const zh = isZh(ctx)
    const body = (ctx.request.body ?? {}) as Record<string, unknown>
    const nextPath = normalizeNext(body.next ?? ctx.query.next)

    const verdict = limiter.check(ctx.ip)
    if (!verdict.allowed) {
      ctx.status = 429
      ctx.set('Retry-After', String(verdict.retryAfterSec))
      ctx.type = 'text/html; charset=utf-8'
      ctx.body = renderLoginPage({
        title,
        zh,
        nextPath,
        errorMessage: zh
          ? `尝试次数过多，请 ${verdict.retryAfterSec} 秒后再试。`
          : `Too many attempts. Retry in ${verdict.retryAfterSec}s.`,
      })
      return
    }

    const password = typeof body.password === 'string' ? body.password : ''
    if (!auth.verifyPassword(password)) {
      limiter.recordFail(ctx.ip)
      log.warn(`登录失败（${ctx.ip}）`)
      ctx.status = 401
      ctx.type = 'text/html; charset=utf-8'
      ctx.body = renderLoginPage({
        title,
        zh,
        nextPath,
        errorMessage: zh ? '密码不正确。' : 'Password is incorrect.',
      })
      return
    }

    limiter.recordSuccess(ctx.ip)
    const token = auth.createSession()
    ctx.set('Set-Cookie', auth.buildSetCookie(token, isSecure(ctx)))
    ctx.set('Cache-Control', 'no-store')
    ctx.status = 303
    ctx.redirect(nextPath)
    log.info(`登录成功（${ctx.ip}）`)
  })

  router.post('/logout', (ctx) => {
    const token = auth.tokenOf(ctx.req)
    if (token) auth.destroySession(token)
    ctx.set('Set-Cookie', auth.buildClearCookie(isSecure(ctx)))
    ctx.status = 303
    ctx.redirect('/login')
  })

  return router
}
