// 访问认证：内存会话 + 滑动 TTL + cookie；登录按 IP 限流（移植自旧版 access-auth.mjs，哈希升级 scrypt）
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { verifyPassword, isLegacyHash, validateStoredHash } from './password'
import { createLogger } from '../logger'

const log = createLogger('auth')

export const SESSION_COOKIE = 'areco_session'
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const seg = part.trim()
    const i = seg.indexOf('=')
    if (i <= 0) continue
    try {
      cookies.set(seg.slice(0, i).trim(), decodeURIComponent(seg.slice(i + 1).trim()))
    } catch {
      /* 忽略畸形 cookie 段 */
    }
  }
  return cookies
}

export class AuthService {
  private sessions = new Map<string, number>() // token → expiresAt
  private lastCleanup = 0

  constructor(
    private getPasswordHash: () => string,
    private ttlMs: number
  ) {
    validateStoredHash(getPasswordHash())
    if (isLegacyHash(getPasswordHash())) {
      log.warn('passwordHash 仍是旧版快哈希格式（sha256），建议重置：npm run hash -- "新密码" --save')
    }
  }

  get enabled(): boolean {
    return Boolean(this.getPasswordHash().trim())
  }

  verifyPassword(password: string): boolean {
    return verifyPassword(password, this.getPasswordHash())
  }

  createSession(): string {
    const token = crypto.randomBytes(32).toString('hex')
    this.sessions.set(token, Date.now() + this.ttlMs)
    this.cleanup()
    return token
  }

  destroySession(token: string) {
    this.sessions.delete(token)
  }

  /** 校验并滑动续期 */
  touchToken(token: string | undefined): boolean {
    if (!token) return false
    this.cleanup()
    const expiresAt = this.sessions.get(token)
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(token)
      return false
    }
    this.sessions.set(token, Date.now() + this.ttlMs)
    return true
  }

  /** 从原始 http 请求（含 WS upgrade）校验登录态 */
  isAuthedRequest(req: IncomingMessage): boolean {
    if (!this.enabled) return true
    return this.touchToken(parseCookies(req.headers.cookie).get(SESSION_COOKIE))
  }

  tokenOf(req: IncomingMessage): string | undefined {
    return parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  }

  /**
   * 已登录请求滑动续期后要重发的 Set-Cookie 头；未启用/未登录返回 undefined。
   * 服务端 touchToken 每次都滑动 TTL，但 cookie Max-Age 是签发时固定的——不重发的话活跃用户到期仍被强制登出。
   * 需在 isAuthedRequest（touch）之后调用。
   */
  renewCookieHeader(req: IncomingMessage): string | undefined {
    if (!this.enabled) return undefined
    const token = this.tokenOf(req)
    if (!token || !this.sessions.has(token)) return undefined
    const secure =
      Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
      String(req.headers['x-forwarded-proto'] ?? '').includes('https')
    return this.buildSetCookie(token, secure)
  }

  buildSetCookie(token: string, secure: boolean): string {
    const attrs = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ]
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }

  buildClearCookie(secure: boolean): string {
    const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }

  private cleanup() {
    const now = Date.now()
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token)
    }
    this.lastCleanup = now
  }
}

// ---- 登录限流：滑动窗口 5 次/分钟 → 指数封禁（60s×2^n，封顶 1h） ----

const WINDOW_MS = 60_000
const MAX_FAILS = 5
const BASE_BAN_MS = 60_000
const MAX_BAN_MS = 3600_000

interface LimiterEntry {
  fails: number[]
  banUntil: number
  banCount: number
}

export class LoginLimiter {
  private entries = new Map<string, LimiterEntry>()
  private lastCleanup = 0

  /** 惰性清理：只增不清会内存无界增长；记录时顺手删掉窗口外且无封禁的陈旧条目 */
  private cleanup() {
    const now = Date.now()
    if (now - this.lastCleanup < WINDOW_MS) return
    for (const [ip, e] of this.entries) {
      if (e.banUntil <= now && e.fails.every((t) => now - t >= WINDOW_MS)) this.entries.delete(ip)
    }
    this.lastCleanup = now
  }
  check(ip: string): { allowed: boolean; retryAfterSec: number } {
    const e = this.entries.get(ip)
    if (!e) return { allowed: true, retryAfterSec: 0 }
    const now = Date.now()
    if (e.banUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((e.banUntil - now) / 1000) }
    }
    return { allowed: true, retryAfterSec: 0 }
  }

  recordFail(ip: string) {
    this.cleanup()
    const now = Date.now()
    const e = this.entries.get(ip) ?? { fails: [], banUntil: 0, banCount: 0 }
    e.fails = e.fails.filter((t) => now - t < WINDOW_MS)
    e.fails.push(now)
    if (e.fails.length >= MAX_FAILS) {
      const banMs = Math.min(BASE_BAN_MS * 2 ** e.banCount, MAX_BAN_MS)
      e.banUntil = now + banMs
      e.banCount += 1
      e.fails = []
      log.warn(`登录失败过多，封禁 ${ip} ${Math.round(banMs / 1000)}s（第 ${e.banCount} 次）`)
    }
    this.entries.set(ip, e)
  }

  recordSuccess(ip: string) {
    this.entries.delete(ip)
  }
}
