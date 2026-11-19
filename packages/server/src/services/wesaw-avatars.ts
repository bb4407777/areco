// 微信会话头像：weSaw 启动缓存里已经存好（qlogo 直链或内嵌 base64），areco 直接取用，不经 weSaw 主进程。
// 首次请求按需取 → sips 缩到 128px → 落 ~/Documents/weSaw/avatars/<talker>.jpg，之后只读本地文件。
// 取不到（无头像、链接过期、无 sips）一律返回 null，前端退回首字。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

const BOOTSTRAP_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'weSaw',
  'cache',
  'bootstrap'
)
/** 头像缓存目录：与 weSaw 的 document 同根，可整体清掉重建 */
export const AVATAR_DIR = path.join(os.homedir(), 'Documents', 'weSaw', 'avatars')

const MAX_EDGE = 128
const FETCH_TIMEOUT_MS = 8000

interface StartupIndex {
  file: string
  mtimeMs: number
  avatars: Map<string, string>
}

let startup: StartupIndex | null = null

/** weSaw 每个账号一份启动缓存，取最新那份 */
function newestStartupFile(): string | null {
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(BOOTSTRAP_ROOT)
  } catch {
    return null
  }
  let best: { file: string; mtimeMs: number } | null = null
  for (const dir of dirs) {
    const file = path.join(BOOTSTRAP_ROOT, dir, 'startup.json')
    try {
      const st = fs.statSync(file)
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs }
    } catch {
      continue
    }
  }
  return best?.file ?? null
}

/** talker → 头像来源（http 直链或 data URL）；缓存文件不变就不重读 9.8MB 的 json */
function avatarSources(): Map<string, string> {
  const file = newestStartupFile()
  if (!file) return new Map()
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return new Map()
  }
  if (startup && startup.file === file && startup.mtimeMs === mtimeMs) return startup.avatars
  const avatars = new Map<string, string>()
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      contacts?: { m_nsUsrName?: string; avatar?: string }[]
    }
    for (const c of data.contacts ?? []) {
      const who = c.m_nsUsrName
      const src = c.avatar
      if (who && src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image'))) {
        avatars.set(who, src)
      }
    }
  } catch {
    // 缓存损坏就当没有头像，前端用首字
  }
  startup = { file, mtimeMs, avatars }
  return avatars
}

/** 文件名：非 [字母数字._-] 换成下划线，若发生过替换就补短 hash 防撞名 */
function cacheName(talker: string): string {
  const safe = talker.replace(/[^A-Za-z0-9._-]/g, '_')
  const tag = safe === talker ? '' : `-${crypto.createHash('md5').update(talker).digest('hex').slice(0, 8)}`
  return `${safe}${tag}.jpg`
}

async function download(src: string): Promise<Buffer | null> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    if (comma < 0) return null
    try {
      return Buffer.from(src.slice(comma + 1), 'base64')
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(src, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

/** 原图缩到 128px 落盘；sips 失败返回 null（不拿几百 KB 的原图凑数） */
async function saveShrunk(raw: Buffer, file: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true })
    fs.writeFileSync(tmp, raw)
    await runFile('sips', ['-Z', String(MAX_EDGE), '-s', 'format', 'jpeg', tmp, '--out', file])
    return fs.statSync(file).size > 0
  } catch {
    return false
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件已不在
    }
  }
}

const inflight = new Map<string, Promise<boolean>>()

async function build(talker: string, file: string): Promise<boolean> {
  const src = avatarSources().get(talker)
  if (!src) return false
  const raw = await download(src)
  if (!raw?.length) return false
  return saveShrunk(raw, file)
}

export interface WesawAvatar {
  buf: Buffer
  mtimeMs: number
}

/** 取某会话的头像：本地有就读文件，没有就按启动缓存现取一次 */
export async function readWesawAvatar(talker: string): Promise<WesawAvatar | null> {
  const file = path.join(AVATAR_DIR, cacheName(talker))
  try {
    const st = fs.statSync(file)
    if (st.size > 0) return { buf: fs.readFileSync(file), mtimeMs: st.mtimeMs }
  } catch {
    // 还没缓存
  }
  let job = inflight.get(talker)
  if (!job) {
    job = build(talker, file).finally(() => inflight.delete(talker))
    inflight.set(talker, job)
  }
  if (!(await job)) return null
  try {
    const st = fs.statSync(file)
    return { buf: fs.readFileSync(file), mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}
