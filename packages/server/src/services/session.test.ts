import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import { test } from 'node:test'
import type { Session as SessionType } from './session'
import type { SpawnSpec } from './templates'

// session.ts 经 ESM 加载会撞上 @xterm/headless（UMD 包）无具名导出的限制，测试走 CJS require 绕过
const { Session } = createRequire(import.meta.url)('./session.ts') as typeof import('./session')

const STOP_GRACE_MS = 5000 // 与 session.ts 内部常量一致

function makeSession(): SessionType {
  return new Session({
    id: 'test-session',
    name: 'test',
    templateId: 'test',
    command: 'cat',
    args: [],
    cwd: os.tmpdir(),
    color: '#fff',
    claudeSessionId: null,
  })
}

const catSpec: SpawnSpec = { file: '/bin/cat', args: [], cwd: os.tmpdir(), env: {} }

test('sendline validates running state before marking working', () => {
  const session = makeSession()
  assert.equal(session.trafficState, 'exited')
  assert.throws(() => session.sendline('hello'), /会话未在运行/)
  // 已退出会话不得留下持久化的假 working 状态
  assert.equal(session.trafficState, 'exited')
})

test('repeated stop leaves no orphan SIGKILL timer behind', async () => {
  const session = makeSession()
  try {
    session.spawnProcess(catSpec)
    session.stop()
    session.stop() // 第二次 stop 覆盖句柄前必须清掉旧定时器
    await once(session, 'exit')
    assert.equal(session.exitReason, 'user-stop')
    // restart 出新进程后，孤定时器到点会 SIGKILL 新进程并记为 crash：
    // 真实等待超过兜底宽限期，确认新进程仍存活（不用 mock timers——会卡死 node-pty 内部定时器）
    session.spawnProcess(catSpec)
    await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 1000))
    assert.equal(session.isRunning, true)
  } finally {
    session.dispose()
  }
})
