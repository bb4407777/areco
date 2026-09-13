// 轻量分级 logger：模块前缀 + 时间戳，可选落盘 data/logs/server.log
import fs from 'node:fs'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: Level = (process.env.ARECO_LOG_LEVEL as Level) || (process.env.AGENT_REMOTE_LOG_LEVEL as Level) || 'info'
let logFilePath: string | null = null

// 日志轮转：原先只 appendFileSync、无上限无清理，实测 data/logs/server.log 已长到 29MB
// 且仍在涨。除了占盘，真正的风险是卷满之后 appendFileSync 抛错 —— 它被 catch 吞掉，
// 于是日志静默停写，而同期不 catch 的 saveConfig / atomicWrite 会开始真失败。
const MAX_LOG_BYTES = Number(process.env.ARECO_LOG_MAX_BYTES || 16 * 1024 * 1024)
const KEEP_ROTATIONS = 3
let writtenSinceCheck = 0

export function enableFileLog(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  logFilePath = path.join(dir, 'server.log')
}

/**
 * 超过上限就 server.log → .1 → .2 → .3，.3 被丢弃。
 *
 * 不每行都 stat（那是每条日志一次 syscall），累计写够 CHECK_EVERY 字节才查一次。
 * 代价是文件最多超限 CHECK_EVERY：默认 16MB 上限对应 64KB 步长，超 0.4%，无所谓；
 * 但上限被调得很小时 64KB 会反过来主导（实测 20KB 上限得到 ~100KB 文件），
 * 所以步长跟着上限收缩。
 */
const CHECK_EVERY = Math.max(4096, Math.min(65536, Math.floor(MAX_LOG_BYTES / 8)))

function rotateIfNeeded(nextLineBytes: number): void {
  if (!logFilePath) return
  writtenSinceCheck += nextLineBytes
  if (writtenSinceCheck < CHECK_EVERY) return
  writtenSinceCheck = 0
  try {
    if (fs.statSync(logFilePath).size < MAX_LOG_BYTES) return
    for (let i = KEEP_ROTATIONS; i >= 1; i--) {
      const older = `${logFilePath}.${i}`
      if (i === KEEP_ROTATIONS) {
        fs.rmSync(older, { force: true })
        continue
      }
      if (fs.existsSync(older)) fs.renameSync(older, `${logFilePath}.${i + 1}`)
    }
    fs.renameSync(logFilePath, `${logFilePath}.1`)
  } catch {
    /* 轮转失败就继续往原文件写，总比丢日志好 */
  }
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function emit(level: Level, module: string, args: unknown[]) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const line = `[${ts()}] [${level.toUpperCase()}] [${module}] ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a)))
    .join(' ')}`
  // eslint-disable-next-line no-console
  ;(level === 'error' ? console.error : console.log)(line)
  if (logFilePath) {
    try {
      rotateIfNeeded(line.length + 1)
      fs.appendFileSync(logFilePath, line + '\n')
    } catch {
      /* 落盘失败不影响运行 */
    }
  }
}

export function createLogger(module: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', module, args),
    info: (...args: unknown[]) => emit('info', module, args),
    warn: (...args: unknown[]) => emit('warn', module, args),
    error: (...args: unknown[]) => emit('error', module, args),
  }
}

export function setLogLevel(level: Level) {
  minLevel = level
}
