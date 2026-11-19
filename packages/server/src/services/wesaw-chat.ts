// weSaw tab 的对话框：把输入打给该工作区的 agent（CodeBuddy 无头 CLI）。
//
// 与 weSaw 对话栏同一路（2026-11-19 高律师令「两边要同步」）：
//   · 会话＝工作区 .agent-session.json 里绑定的 CodeBuddy sessionId，weSaw 对话栏、
//     微信消化工人、areco 都续接同一份 JSONL，任何一边发的命令另一边都看得到；
//   · 并发用 weSaw 自己的工作区运行锁 <工作区>/.agent-run.lock（同一协议 owner/pid/startedAt），
//     拿到锁才 spawn，避免两个进程 resume 同一会话把 JSONL 写花；
//   · 消息不再另存：正文由 readWesawTranscript 从同一份会话文件读，两边显示同源。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { cbSessionFile, readBinding, wesawWorkspaceDir } from './wesaw'

/** 单条最长跑 60 分钟，超时杀进程（10 分钟会砍掉读卷宗、出件的长活，2026-11-19 高律师报「完成不了任务就没后续」） */
const MAX_RUN_MS = 60 * 60_000
/** weSaw 对话栏同款：封掉会往外说话的自家工具，避免 agent 直接发微信 */
const DENY_TOOLS = 'WeChatReply,WeComReply,SendMessage,MessageColleague,SpeakInChannel,TeamCreate,TeamDelete'
/** weSaw 的工作区运行锁（与 agent-chat-service.ts、dispatch worker 同一文件同一协议） */
const LOCK_NAME = '.agent-run.lock'
const LOCK_STALE_MS = 20 * 60_000
const LOCK_WAIT_MS = 20_000
const LOCK_OWNER = 'areco-chat'

const CANDIDATES = [
  process.env.CODEBUDDY_BIN ?? '',
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
  path.join(process.env.HOME ?? '', '.workbuddy', 'binaries', 'codebuddy'),
]

function cliPath(): string | null {
  for (const p of CANDIDATES) {
    if (!p) continue
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      // 下一个候选
    }
  }
  return null
}

export interface WesawChatTurn {
  role: 'user' | 'assistant'
  text: string
  ts: number
  error?: boolean
}

const running = new Set<string>()

// ---- 共享运行锁 ----

interface LockInfo {
  owner?: string
  pid?: number
  startedAt?: number
}

function readLock(dir: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, LOCK_NAME), 'utf8')) as LockInfo
  } catch {
    return null
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 锁有效＝文件在、pid 活、未超 20 分钟（僵锁视同无锁，与 weSaw 同口径） */
function lockHeld(dir: string): boolean {
  const lock = readLock(dir)
  if (!lock) return false
  if (!pidAlive(lock.pid)) return false
  return Date.now() - (lock.startedAt ?? 0) < LOCK_STALE_MS
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function acquireLock(dir: string, waitMs: number): Promise<boolean> {
  const lockPath = path.join(dir, LOCK_NAME)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ owner: LOCK_OWNER, pid: process.pid, startedAt: Date.now() }), {
        flag: 'wx',
      })
      return true
    } catch {
      const lock = readLock(dir)
      const stale = !lock || !pidAlive(lock.pid) || Date.now() - (lock.startedAt ?? 0) >= LOCK_STALE_MS
      if (stale) {
        // 僵锁：接管（先删再抢，删失败也无妨，下一轮再试）
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // 已被别人接管
        }
        continue
      }
      if (Date.now() >= deadline) return false
      await sleep(500)
    }
  }
}

function releaseLock(dir: string): void {
  const lock = readLock(dir)
  if (lock && lock.owner === LOCK_OWNER && lock.pid === process.pid) {
    try {
      fs.unlinkSync(path.join(dir, LOCK_NAME))
    } catch {
      // 已被清掉
    }
  }
}

// ---- 绑定 ----

/** 该工作区当前绑定的 CodeBuddy 会话；文件不存在就当没有（下次跑会开新会话并回写绑定） */
function boundSession(dir: string): string {
  const bind = readBinding(dir)
  if (bind.cli !== 'codebuddy' || !bind.sessionId) return ''
  return cbSessionFile(dir, bind.sessionId) ? bind.sessionId : ''
}

/** 开新会话后回写绑定，weSaw 对话栏与工人随即续接这一路 */
function writeBinding(dir: string, sessionId: string): void {
  const file = path.join(dir, '.agent-session.json')
  let current: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') current = parsed
  } catch {
    current = {}
  }
  const next = { ...current, cli: 'codebuddy', sessionId, track: (current.track as string) || 'codebuddy-ds' }
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next))
    fs.renameSync(tmp, file)
  } catch {
    // 写不进去不阻断对话，下一轮还按原绑定走
  }
}

// ---- 读取 ----

/** 对话轮次由正文（readWesawTranscript）统一给出，这里不再单独存一份，避免两边各显示一套 */
export function wesawChatTurns(_talker: string): WesawChatTurn[] {
  return []
}

/** 本页是否在跑：自己 spawn 的，或 weSaw／工人在同一工作区持锁 */
export function wesawChatBusy(talker: string): boolean {
  if (running.has(talker)) return true
  const dir = wesawWorkspaceDir(talker)
  return dir ? lockHeld(dir) : false
}

// ---- 发送 ----

function run(talker: string, dir: string, text: string, resumeId: string): void {
  const bin = cliPath()
  if (!bin) {
    running.delete(talker)
    releaseLock(dir)
    return
  }
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--model',
    'deepseek-v4.1-flash',
    '--permission-mode',
    'bypassPermissions',
  ]
  if (resumeId) args.push('--resume', resumeId)
  args.push(text)
  args.push('--disallowedTools', DENY_TOOLS)

  // CodeBuddy CLI 是 `#!/usr/bin/env node` 脚本：服务由 launchd/start.sh 起时 PATH 只有
  // /opt/homebrew/bin，node 装在 ~/.npm-global/bin 找不到 → env: node: No such file。
  const nodeDir = path.dirname(process.execPath)
  const env = {
    ...process.env,
    PATH: [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].filter(Boolean).join(':'),
  }
  const child = spawn(bin, args, { cwd: dir, env })
  let buffered = ''
  let newSession = ''
  let settled = false

  const finish = (): void => {
    if (settled) return
    settled = true
    if (newSession && newSession !== resumeId) writeBinding(dir, newSession)
    running.delete(talker)
    releaseLock(dir)
  }

  const timer = setTimeout(() => child.kill('SIGTERM'), MAX_RUN_MS)

  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const head = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string }
        if (head.type === 'system' && head.subtype === 'init' && head.session_id) newSession = head.session_id
      } catch {
        // 非 JSON 行忽略
      }
    }
  })
  child.stderr?.on('data', () => {
    // 错误正文留在 CLI 输出／会话文件里，这里不再另存
  })
  child.on('error', finish)
  child.on('close', () => {
    clearTimeout(timer)
    finish()
  })
}

/** 发一条消息；返回是否已开始执行（进度与结果都靠轮询正文取） */
export async function sendWesawMessage(talker: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const body = text.trim()
  if (!body) return { ok: false, error: '消息为空' }
  if (running.has(talker)) return { ok: false, error: '上一条还在处理，等它跑完' }
  const dir = wesawWorkspaceDir(talker)
  if (!dir) return { ok: false, error: '这个会话还没有工作区，agent 无处落脚' }
  if (!cliPath()) return { ok: false, error: '找不到 CodeBuddy CLI，无法发送' }
  if (lockHeld(dir)) return { ok: false, error: 'weSaw 正在处理这条会话，等它跑完再发' }
  const got = await acquireLock(dir, LOCK_WAIT_MS)
  if (!got) return { ok: false, error: 'weSaw 正在处理这条会话，等它跑完再发' }
  running.add(talker)
  run(talker, dir, body, boundSession(dir))
  return { ok: true }
}
