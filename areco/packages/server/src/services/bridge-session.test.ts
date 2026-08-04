// BridgeSession 单测：假 bridge client（不起 Python sidecar、不调模型）。
// 覆盖：spawn 异步就绪、sendline→chat、流式增量进 output 事件（CRLF 规范化）、
// 工具事件渲染、运行中 sendline→steer、stop→destroy+user-stop、首句命名。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentBridgeClient } from './agent-bridge'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-bridge-session-'))
process.env.ARECO_ROOT = root

// session.ts 经 ESM 加载会撞 @xterm/headless（UMD 包）无具名导出的限制，走 CJS require 绕过
//（同 session.test.ts）。bridge-runtime 必须从同一个 require 图里取——分开 import 会拿到
// 另一个模块实例，setBridgeRuntimeForTesting 注进 A、BridgeSession 读 B，测试假client失效。
const require = createRequire(import.meta.url)
const { BridgeSession } = require('./bridge-session.ts') as typeof import('./bridge-session')
const { setBridgeRuntimeForTesting } = require('./bridge-runtime.ts') as typeof import('./bridge-runtime')

interface FakeCall {
  method: string
  args: unknown[]
}

/** 假 client：chat 记一笔，streamOutput 立刻回放两段增量 + 一个工具事件再 done */
function makeFakeClient(opts: { finalStatus?: string } = {}) {
  const calls: FakeCall[] = []
  const client = {
    chat: async (req: Record<string, unknown>) => {
      calls.push({ method: 'chat', args: [req] })
      return { ok: true, run_id: 'run-fake', session_id: req.session_id, status: 'running' }
    },
    streamOutput: async (runId: string, onChunk: (c: Record<string, unknown>) => void) => {
      calls.push({ method: 'streamOutput', args: [runId] })
      onChunk({ delta: '你好', cursor: 3, event_cursor: 0, events: [], done: false, status: 'running' })
      onChunk({
        delta: '\n世界',
        cursor: 7,
        event_cursor: 0,
        events: [{ type: 'tool.started', name: 'terminal', args_preview: 'echo hi' }],
        done: false,
        status: 'running',
      })
      return {
        delta: '',
        cursor: 7,
        event_cursor: 1,
        events: [],
        done: true,
        status: opts.finalStatus ?? 'complete',
        output: '你好\n世界',
      }
    },
    steer: async (sessionId: string, text: string) => {
      calls.push({ method: 'steer', args: [sessionId, text] })
      return { ok: true, steered: true }
    },
    interrupt: async (sessionId: string) => {
      calls.push({ method: 'interrupt', args: [sessionId] })
      return { ok: true, interrupted: true }
    },
    destroy: async (sessionId: string) => {
      calls.push({ method: 'destroy', args: [sessionId] })
      return { ok: true, destroyed: true }
    },
  }
  return { client: client as unknown as InstanceType<typeof AgentBridgeClient>, calls }
}

function makeSession(client: InstanceType<typeof AgentBridgeClient>, name = '占位 #1') {
  setBridgeRuntimeForTesting(client)
  return new BridgeSession({
    id: 'sess-test-1',
    name,
    autoNamed: true,
    templateId: 'hermes-flash',
    command: '',
    args: [],
    cwd: root,
    color: '#000000',
    claudeSessionId: null,
    harness: 'hermes-bridge',
    bridgeModel: 'pool-deepseek-v4-flash',
  })
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待条件超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('spawn 异步就绪后转 running，无 pty', async () => {
  const { client } = makeFakeClient()
  const s = makeSession(client)
  s.spawnProcess({ file: '', args: [], cwd: root, env: {} })
  assert.equal(s.status, 'spawning')
  await waitFor(() => s.status === 'running')
  assert.equal(s.pid, null) // bridge 会话没有自己的进程
  s.dispose()
})

test('sendline 触发 chat，增量进 output（CRLF 规范化），done 后回 idle', async () => {
  const { client, calls } = makeFakeClient()
  const s = makeSession(client)
  s.spawnProcess({ file: '', args: [], cwd: root, env: {} })
  await waitFor(() => s.status === 'running')

  const chunks: string[] = []
  s.on('output', (data: string) => chunks.push(data))
  s.sendline('打个招呼')
  assert.equal(s.trafficState, 'working')
  await waitFor(() => s.trafficState === 'idle')

  const chatReq = calls.find((c) => c.method === 'chat')?.args[0] as Record<string, unknown>
  assert.equal(chatReq.message, '打个招呼')
  assert.equal(chatReq.session_id, 'sess-test-1')
  assert.equal(chatReq.model, 'pool-deepseek-v4-flash')

  const out = chunks.join('')
  assert.ok(out.includes('你好\r\n世界'), `增量应 CRLF 规范化，实际: ${JSON.stringify(out)}`)
  assert.ok(out.includes('🔧 terminal'), '工具事件应渲染进输出流')
  assert.ok(out.includes('>>> 打个招呼'), '用户输入应本地回显')
  s.dispose()
})

test('运行中 sendline 走 steer 不新起 chat', async () => {
  const { client, calls } = makeFakeClient()
  // streamOutput 挂住：run 一直 running
  client.streamOutput = (() => new Promise(() => {})) as never
  const s = makeSession(client)
  s.spawnProcess({ file: '', args: [], cwd: root, env: {} })
  await waitFor(() => s.status === 'running')
  s.sendline('第一句')
  await waitFor(() => calls.some((c) => c.method === 'chat'))
  s.sendline('插一句')
  await waitFor(() => calls.some((c) => c.method === 'steer'))
  assert.equal(calls.filter((c) => c.method === 'chat').length, 1)
  assert.equal((calls.find((c) => c.method === 'steer')?.args ?? [])[1], '插一句')
  s.dispose()
})

test('stop 销毁 bridge 会话并按 user-stop 收场', async () => {
  const { client, calls } = makeFakeClient()
  const s = makeSession(client)
  s.spawnProcess({ file: '', args: [], cwd: root, env: {} })
  await waitFor(() => s.status === 'running')
  s.stop()
  assert.equal(s.status, 'exited')
  assert.equal(s.exitReason, 'user-stop')
  await waitFor(() => calls.some((c) => c.method === 'destroy'))
  assert.equal((calls.find((c) => c.method === 'destroy')?.args ?? [])[0], 'sess-test-1')
  s.dispose()
})

test('占位名会话首句命名', async () => {
  const { client } = makeFakeClient()
  const s = makeSession(client)
  s.spawnProcess({ file: '', args: [], cwd: root, env: {} })
  await waitFor(() => s.status === 'running')
  s.sendline('分析一下这个案件的诉讼时效问题')
  await waitFor(() => s.trafficState === 'idle')
  assert.notEqual(s.name, '占位 #1')
  assert.ok(s.name.length > 0)
  s.dispose()
})
