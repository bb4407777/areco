// weSaw tab 的对话框：把输入直接打给该工作区的 agent（CodeBuddy 无头 CLI），
// 会话按联系人各自续接（--resume 我们的 sessionId），消息落 data/wesaw-chat.json。
//
// 为什么不再用 weSaw 绑定的引擎：kimi 已 403（订阅不可用）、qoder 额度见底，
// 现在能跑的是 CodeBuddy；用 --resume 自己那一路才不会跟 weSaw 的绑定互相串。
// 只写自己的状态文件，不动各工作区的 .agent-session.json／project.md（2026-11-19）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DATA_DIR } from '../config'
import { wesawWorkspaceDir } from './wesaw'

const STORE = path.join(DATA_DIR, 'wesaw-chat.json')
/** 单条最长跑 60 分钟，超时杀进程（10 分钟会砍掉读卷宗、出件的长活，2026-11-19 高律师报「完成不了任务就没后续」） */
const MAX_RUN_MS = 60 * 60_000
/** weSaw 对话栏同款：封掉会往外说话的自家工具，避免 agent 直接发微信 */
const DENY_TOOLS = 'WeChatReply,WeComReply,SendMessage,MessageColleague,SpeakInChannel,TeamCreate,TeamDelete'

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

interface Entry {
  sessionId: string
  turns: WesawChatTurn[]
}

let cache: Record<string, Entry> | null = null
const busy = new Set<string>()

function load(): Record<string, Entry> {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8')) as Record<string, Entry>
    cache = raw && typeof raw === 'object' ? raw : {}
  } catch {
    cache = {}
  }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true })
    const tmp = `${STORE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 1))
    fs.renameSync(tmp, STORE)
  } catch {
    // 落盘失败不影响本轮对话
  }
}

/** 该联系人已经聊过的轮次（不含 project.md 历史） */
export function wesawChatTurns(talker: string): WesawChatTurn[] {
  return load()[talker]?.turns ?? []
}

export function wesawChatBusy(talker: string): boolean {
  return busy.has(talker)
}

/** 从一行 stream-json 里取 assistant 文本；工具中间消息跳过 */
function assistantText(line: string): string | null {
  try {
    const row = JSON.parse(line) as {
      type?: string
      message?: { role?: string; content?: unknown }
    }
    if (row.type !== 'assistant' || row.message?.role !== 'assistant') return null
    const content = row.message.content
    const texts: string[] = []
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          const t = (part as { text?: string }).text
          if (t) texts.push(t)
        }
      }
    }
    const text = texts.join('\n').trim()
    return text || null
  } catch {
    return null
  }
}

function run(talker: string, dir: string, text: string, sessionId: string): void {
  const bin = cliPath()
  const entry = load()[talker] ?? { sessionId: '', turns: [] }
  if (!bin) {
    entry.turns.push({ role: 'assistant', text: '找不到 CodeBuddy CLI，无法发送。', ts: Date.now(), error: true })
    load()[talker] = entry
    save()
    return
  }
  const args = ['-p', text, '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions']
  if (sessionId) args.push('--resume', sessionId)
  args.push('--disallowedTools', DENY_TOOLS)

  // CodeBuddy CLI 是 `#!/usr/bin/env node` 脚本：服务由 launchd/start.sh 起时 PATH 只有
  // /opt/homebrew/bin，node 装在 ~/.npm-global/bin 找不到 → env: node: No such file。
  // 把当前 node 可执行文件所在目录补进 PATH（2026-11-19 赵云播发送失败实录）。
  const nodeDir = path.dirname(process.execPath)
  const env = {
    ...process.env,
    PATH: [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '']
      .filter(Boolean)
      .join(':'),
  }
  const child = spawn(bin, args, { cwd: dir, env })
  let buffered = ''
  let answer = ''
  let errTail = ''
  let newSession = sessionId
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    const final = answer.trim()
    if (final) entry.turns.push({ role: 'assistant', text: final, ts: Date.now() })
    else if (errTail.trim()) entry.turns.push({ role: 'assistant', text: `发送失败：${errTail.trim().slice(-400)}`, ts: Date.now(), error: true })
    else entry.turns.push({ role: 'assistant', text: '（agent 没有返回内容）', ts: Date.now(), error: true })
    entry.sessionId = newSession
    load()[talker] = entry
    save()
    busy.delete(talker)
  }
  const timer = setTimeout(() => {
    errTail = '超时：60 分钟未完成，已中止'
    child.kill('SIGTERM')
  }, MAX_RUN_MS)

  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const head = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string; result?: string }
        if (head.type === 'system' && head.subtype === 'init' && head.session_id) newSession = head.session_id
        if (head.type === 'result' && typeof head.result === 'string' && !answer.trim()) answer = head.result
      } catch {
        // 不是 JSON 的行忽略
      }
      const t = assistantText(line)
      if (t) answer = t
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    errTail = (errTail + chunk.toString('utf8')).slice(-2000)
  })
  child.on('error', (err) => {
    clearTimeout(timer)
    errTail = String(err)
    finish()
  })
  child.on('close', () => {
    clearTimeout(timer)
    finish()
  })
}

/** 发一条消息；返回是否已开始执行（执行完的结果靠轮询 turns 取） */
export function sendWesawMessage(talker: string, text: string): { ok: boolean; error?: string } {
  const body = text.trim()
  if (!body) return { ok: false, error: '消息为空' }
  if (busy.has(talker)) return { ok: false, error: '上一条还在处理，等它跑完' }
  const dir = wesawWorkspaceDir(talker)
  if (!dir) return { ok: false, error: '这个会话还没有工作区，agent 无处落脚' }
  const store = load()
  const entry = store[talker] ?? { sessionId: '', turns: [] }
  entry.turns.push({ role: 'user', text: body, ts: Date.now() })
  store[talker] = entry
  save()
  busy.add(talker)
  run(talker, dir, body, entry.sessionId)
  return { ok: true }
}
