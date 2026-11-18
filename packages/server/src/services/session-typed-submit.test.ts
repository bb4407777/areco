// 直输回车被 TUI 吞掉：以转写为判据，整行没进去就按可靠通道重投一次（2026-11-18 实锤）
// 现场：按回车那一刻屏幕输入框里还有整行，两秒多后框空了、agent 转写里没有这一句，
// 用户看到的是「字在输入栏里凭空消失」。旧逻辑只留一句「从未见到尾字」就收手，消息进了黑洞。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { Session as SessionType } from './session'
import type { SpawnSpec } from './templates'

const { Session } = createRequire(import.meta.url)('./session.ts') as typeof import('./session')
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')

const catSpec: SpawnSpec = { file: '/bin/cat', args: [], cwd: os.tmpdir(), env: {} }

function makeSession(): SessionType {
  return new Session({
    id: 'typed-submit-session',
    name: 'test',
    templateId: 'test',
    command: 'cat',
    args: [],
    cwd: os.tmpdir(),
    color: '#fff',
    claudeSessionId: null,
  })
}

async function boxScreen(lines: string[]): Promise<InstanceType<typeof Terminal>> {
  const term = new Terminal({ cols: 144, rows: 31, allowProposedApi: true })
  term.write(lines.join('\r\n'))
  await new Promise((r) => setTimeout(r, 30))
  return term
}

/** 一行 workbuddy 转写里的 user 消息 */
function wbUserLine(text: string): string {
  return JSON.stringify({
    type: 'message',
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'input_text', text }],
  }) + '\n'
}

function tempTranscript(initial: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-typed-'))
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, initial)
  return file
}

type Guard = (snippet: string, line: string, probe: unknown) => void

const EMPTY_BOX = ['  > ', '  ───────────────────────────', '']

test('整行被 TUI 吞掉、转写里也没有 → 重投一次', async () => {
  const session = makeSession()
  session.spawnProcess(catSpec)
  ;(session as unknown as { harness: string }).harness = 'workbuddy'
  try {
    ;(session as unknown as { shadow: unknown }).shadow = await boxScreen(EMPTY_BOX)
    const file = tempTranscript(wbUserLine('上一条'))
    const from = fs.statSync(file).size
    const sent: string[] = []
    ;(session as unknown as { sendline: (t: string) => void }).sendline = (t: string) => {
      sent.push(t)
    }
    const guard = (session as unknown as { guardTypedSubmit: Guard }).guardTypedSubmit
    guard.call(session, '实验文字ABC', '请把实验文字ABC发出去', {
      path: file,
      from,
      key: '实验文字ABC',
      loose: false,
    })
    await new Promise((r) => setTimeout(r, 6500))
    assert.deepEqual(sent, ['请把实验文字ABC发出去'])
  } finally {
    session.dispose()
  }
})

test('转写里已经有这一句 → 认已提交，不重投', async () => {
  const session = makeSession()
  session.spawnProcess(catSpec)
  ;(session as unknown as { harness: string }).harness = 'workbuddy'
  try {
    ;(session as unknown as { shadow: unknown }).shadow = await boxScreen(EMPTY_BOX)
    const file = tempTranscript(wbUserLine('上一条'))
    const from = fs.statSync(file).size
    fs.appendFileSync(file, wbUserLine('请把实验文字ABC发出去'))
    const sent: string[] = []
    ;(session as unknown as { sendline: (t: string) => void }).sendline = (t: string) => {
      sent.push(t)
    }
    const guard = (session as unknown as { guardTypedSubmit: Guard }).guardTypedSubmit
    guard.call(session, '实验文字ABC', '请把实验文字ABC发出去', {
      path: file,
      from,
      key: '实验文字ABC',
      loose: false,
    })
    await new Promise((r) => setTimeout(r, 2500))
    assert.deepEqual(sent, [])
  } finally {
    session.dispose()
  }
})

// ---- 输入框通道：屏幕清空了但转写里没有这一句 → 按可靠通道重投（2026-11-18「Cindy」会话）----

test('submitUntilAccepted：框空了、转写没有这一句 → 宽限期后重投一次', async () => {
  const session = makeSession()
  session.spawnProcess(catSpec)
  ;(session as unknown as { harness: string }).harness = 'workbuddy'
  try {
    ;(session as unknown as { shadow: unknown }).shadow = await boxScreen(EMPTY_BOX)
    const file = tempTranscript(wbUserLine('上一条'))
    const from = fs.statSync(file).size
    const body = 'Cindy有没有配置好？'
    const sent: string[] = []
    ;(session as unknown as { sendline: (t: string) => void }).sendline = (t: string) => {
      sent.push(t)
    }
    ;(session as unknown as { submitAck: unknown }).submitAck = {
      path: file,
      from,
      key: body.replace(/\s+/g, ''),
      loose: false,
    }
    const submit = (session as unknown as {
      submitUntilAccepted: (s: string, b: string, absent: boolean, before: string | null, busy: boolean, pasted: boolean) => void
    }).submitUntilAccepted
    submit.call(session, '配置好？', body, false, '', false, true)
    await new Promise((r) => setTimeout(r, 12_000))
    assert.deepEqual(sent, [body])
  } finally {
    session.dispose()
  }
})

test('submitUntilAccepted：转写里有这一句 → 直接认成功，不重投', async () => {
  const session = makeSession()
  session.spawnProcess(catSpec)
  ;(session as unknown as { harness: string }).harness = 'workbuddy'
  try {
    ;(session as unknown as { shadow: unknown }).shadow = await boxScreen(EMPTY_BOX)
    const body = 'Cindy有没有配置好？'
    const file = tempTranscript(wbUserLine('上一条') + wbUserLine(body))
    const sent: string[] = []
    ;(session as unknown as { sendline: (t: string) => void }).sendline = (t: string) => {
      sent.push(t)
    }
    ;(session as unknown as { submitAck: unknown }).submitAck = {
      path: file,
      from: 0,
      key: body.replace(/\s+/g, ''),
      loose: false,
    }
    const submit = (session as unknown as {
      submitUntilAccepted: (s: string, b: string, absent: boolean, before: string | null, busy: boolean, pasted: boolean) => void
    }).submitUntilAccepted
    submit.call(session, '配置好？', body, false, '', false, true)
    await new Promise((r) => setTimeout(r, 4000))
    assert.deepEqual(sent, [])
  } finally {
    session.dispose()
  }
})
