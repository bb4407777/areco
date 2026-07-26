// Host/Origin 校验（防 DNS rebinding）+ cookie 会话守卫 + X-API-Key 程序化访问守卫。Koa 中间件与 WS upgrade 原始校验共用一套判定。
import crypto from 'node:crypto'
import type { Context, Next } from 'koa'
import type { IncomingMessage } from 'node:http'
import type { AuthService } from '../services/auth'
import type { AppConfig } from '../config'
import { createLogger } from '../logger'

const log = createLogger('guard')

function stripPort(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    // [::1]:8790
    const end = value.indexOf(']')
    return end > 0 ? value.slice(1, end) : value
  }
  const i = value.lastIndexOf(':')
  // 无冒号或是裸 IPv6（多个冒号且无中括号）
  if (i < 0 || value.indexOf(':') !== i) return value
  return value.slice(0, i)
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true // Tailscale CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true // link-local
  return false
}

export function hostnameAllowed(hostname: string, extraAllowed: string[]): boolean {
  const h = hostname.toLowerCase()
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (isPrivateIpv4(h)) return true
  // ULA（含 Tailscale v6 fd7a:…）/ link-local：必须是 IPv6 字面量（含冒号），否则 fd.evil.com 之类域名可借前缀绕过
  if (h.includes(':') && (h.startsWith('fd') || h.startsWith('fe80'))) return true
  if (h.endsWith('.ts.net') || h.endsWith('.local') || h === 'localhost.localdomain') return true
  return extraAllowed.some((x) => x.toLowerCase() === h)
}

export interface GuardVerdict {
  ok: boolean
  status: number
  reason: string
}

/** Host + Origin 判定（HTTP 与 WS upgrade 共用） */
export function checkHostOrigin(req: IncomingMessage, config: AppConfig): GuardVerdict {
  const extra = config.server.allowedHosts
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (!hostnameAllowed(stripPort(hostHeader), extra)) {
    return { ok: false, status: 403, reason: `Host 不在允许范围: ${hostHeader}` }
  }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  if (!origin) return { ok: true, status: 200, reason: '' } // 无 Origin（curl / vite 代理已剥）→ 交给 cookie 校验
  if (origin === 'null') return { ok: false, status: 403, reason: 'Origin: null 被拒绝' }
  try {
    const parsed = new URL(origin)
    if (parsed.host.toLowerCase() === hostHeader.toLowerCase()) return { ok: true, status: 200, reason: '' }
    // 默认要求 Origin 与 Host 一致（同站，防跨端口 CSRF）；仅放行 config.allowedHosts 显式配置的额外来源
    if (extra.some((x) => x.toLowerCase() === parsed.hostname.toLowerCase())) {
      return { ok: true, status: 200, reason: '' }
    }
    return { ok: false, status: 403, reason: `Origin 不在允许范围: ${origin}` }
  } catch {
    return { ok: false, status: 403, reason: `Origin 无法解析: ${origin}` }
  }
}

export function createHostOriginGuard(config: AppConfig) {
  return async (ctx: Context, next: Next) => {
    const verdict = checkHostOrigin(ctx.req, config)
    if (!verdict.ok) {
      log.warn(`${verdict.reason}（${ctx.method} ${ctx.path}，来自 ${ctx.ip}）`)
      ctx.status = verdict.status
      ctx.body = { ok: false, error: { code: 'forbidden_host', message: verdict.reason } }
      return
    }
    await next()
  }
}

/** 登录守卫：API 未登录 → 401 JSON；页面 → 302 /login?next=… */
export function createSessionGuard(auth: AuthService) {
  return async (ctx: Context, next: Next) => {
    if (!auth.enabled || auth.isAuthedRequest(ctx.req) || ctx.state.apiKeyAuthed === true) {
      // 滑动续期后重发 cookie，浏览器 Max-Age 与服务端 TTL 口径一致（活跃用户不被强制登出）
      const renew = auth.renewCookieHeader(ctx.req)
      if (renew) ctx.set('Set-Cookie', renew)
      await next()
      return
    }
    if (ctx.path.startsWith('/api')) {
      ctx.status = 401
      ctx.body = { ok: false, error: { code: 'unauthorized', message: '需要登录' } }
      return
    }
    const next_ = ctx.path + (ctx.querystring ? `?${ctx.querystring}` : '')
    ctx.redirect(`/login?next=${encodeURIComponent(next_)}`)
  }
}

/**
 * API Key 守卫：与 cookie 登录是 OR 关系——程序化客户端（如 Hermes/stand-worker）带 X-API-Key
 * 命中 config.apiKeys 即视为已认证，绕过 cookie 登录；浏览器不带 key 时完全保持旧行为。
 *
 * 必须注册在 createSessionGuard 之前：sessionGuard 是全局前置守卫，若把它做成路由级中间件，
 * 它会在 sessionGuard 之后才执行，导致只带 X-API-Key（无 cookie）的请求被先 401 掉。
 *
 * 作用面（程序化访问面）：/api/sessions、/api/rooms、/api/config/whitelist、/api/standcode。
 * 其余 /api 路由（templates/files/server/history 等）不认 key，仍走 cookie 登录——最小授权，
 * 一个泄漏的 agent key 不足以重启服务或读文件。/healthz 在一切守卫之前已短路返回，天然放行。
 *
 * 三条放行/拦截规则：
 *  - apiKeys 为空（未配置）→ 守卫整体 no-op，纯旧行为（安全默认，不破坏免密 loopback）；
 *  - 请求未带 X-API-Key → 透传，交回 sessionGuard 按 cookie 判定（浏览器照常登录）；
 *  - 带了 key：命中 → 置 ctx.state.apiKeyAuthed=true 透传；未命中 → 401 invalid_api_key。
 */
const API_KEY_HEADER = 'x-api-key'
function isApiKeyScope(path: string): boolean {
  return (
    path.startsWith('/api/sessions') ||
    path.startsWith('/api/rooms') ||
    path.startsWith('/api/config/whitelist') ||
    // StandCode 角色默认：caller.py 等程序化客户端需读（不泄露凭证，风险与 rooms 同级）
    path.startsWith('/api/standcode')
  )
}
export function createApiKeyGuard(config: AppConfig) {
  const keys = config.apiKeys ?? []
  return async (ctx: Context, next: Next) => {
    if (keys.length === 0) {
      await next()
      return
    }
    if (!isApiKeyScope(ctx.path)) {
      await next()
      return
    }
    const provided = ctx.get(API_KEY_HEADER)
    if (!provided) {
      await next()
      return
    }
    // 常量时间比对，抗时序侧信道（key 列表通常很短，开销可忽略）
    if (keys.some((k) => k.length === provided.length && timingSafeEqualStr(k, provided))) {
      ctx.state.apiKeyAuthed = true
      await next()
      return
    }
    log.warn(`X-API-Key 无效（${ctx.method} ${ctx.path}，来自 ${ctx.ip}）`)
    ctx.status = 401
    ctx.body = { ok: false, error: { code: 'invalid_api_key', message: 'X-API-Key 无效' } }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  // Node 的 timingSafeEqual 要求两端等长且 Buffer；调用方已保证 length 相同
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return crypto.timingSafeEqual(ba, bb)
}

/** WS upgrade 校验：Host/Origin + cookie，双过才放行 */
export function verifyUpgrade(req: IncomingMessage, auth: AuthService, config: AppConfig): GuardVerdict {
  const hostOrigin = checkHostOrigin(req, config)
  if (!hostOrigin.ok) return hostOrigin
  if (!auth.isAuthedRequest(req)) return { ok: false, status: 401, reason: '未登录' }
  return { ok: true, status: 200, reason: '' }
}
