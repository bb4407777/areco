// 轻量分级 logger：模块前缀 + 时间戳，可选落盘 data/logs/server.log
import fs from 'node:fs'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: Level = (process.env.ARECO_LOG_LEVEL as Level) || (process.env.AGENT_REMOTE_LOG_LEVEL as Level) || 'info'
let logFilePath: string | null = null

export function enableFileLog(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  logFilePath = path.join(dir, 'server.log')
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
