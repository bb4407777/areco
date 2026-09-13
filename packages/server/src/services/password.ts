// 口令哈希：新格式 scrypt:N:r:p:saltB64:hashB64；兼容验证旧版 Jupyter 风格 sha1|sha256|sha512:salt:hexhash
import crypto from 'node:crypto'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

export function hashPassword(password: string): string {
  if (!password) throw new Error('密码不能为空')
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${key.toString('base64')}`
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const LEGACY_ALGOS = new Set(['sha1', 'sha256', 'sha512'])

export function isLegacyHash(stored: string): boolean {
  const algo = stored.split(':')[0]?.toLowerCase() ?? ''
  return LEGACY_ALGOS.has(algo)
}

export function verifyPassword(password: string, stored: string): boolean {
  const value = (stored || '').trim()
  if (!value || !password) return false

  const parts = value.split(':')
  if (parts[0] === 'scrypt' && parts.length === 6) {
    const [, n, r, p, saltB64, hashB64] = parts
    try {
      const expected = Buffer.from(hashB64!, 'base64')
      const actual = crypto.scryptSync(password, Buffer.from(saltB64!, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: 128 * 1024 * 1024,
      })
      return safeEqual(expected, actual)
    } catch {
      return false
    }
  }

  // 旧格式：digest = hash(password + salt) hex（源自旧版 password-hash.mjs）
  if (parts.length === 3 && LEGACY_ALGOS.has(parts[0]!.toLowerCase())) {
    const [algo, salt, hex] = parts
    try {
      const actual = crypto.createHash(algo!.toLowerCase()).update(password, 'utf8').update(salt!, 'utf8').digest()
      return safeEqual(Buffer.from(hex!.trim(), 'hex'), actual)
    } catch {
      return false
    }
  }

  return false
}

export function validateStoredHash(stored: string): void {
  const value = (stored || '').trim()
  if (!value) return
  const parts = value.split(':')
  const okScrypt = parts[0] === 'scrypt' && parts.length === 6
  const okLegacy = parts.length === 3 && LEGACY_ALGOS.has(parts[0]!.toLowerCase())
  if (!okScrypt && !okLegacy) {
    throw new Error(`无法识别的 passwordHash 格式：${parts[0]}…（支持 scrypt:… 或旧版 sha256:salt:hash）`)
  }
}

// CLI：npm run hash -- "<密码>" [--save]
export async function runPasswordCli(argv: string[]) {
  const args = argv.filter((a) => a !== '--save')
  const save = argv.includes('--save')
  const password = args[0]
  if (!password) {
    console.error('用法: npm run hash -- "<密码>" [--save]')
    process.exit(1)
  }
  const hash = hashPassword(password)
  if (save) {
    const { loadConfig, saveConfig } = await import('../config')
    const config = loadConfig()
    config.server.passwordHash = hash
    saveConfig(config)
    console.log('已写入 config.json server.passwordHash（scrypt）')
  } else {
    console.log(hash)
  }
}

// tsx 直接运行本文件时进入 CLI
if (process.argv[1] && /password\.(ts|js)$/.test(process.argv[1])) {
  runPasswordCli(process.argv.slice(2))
}
