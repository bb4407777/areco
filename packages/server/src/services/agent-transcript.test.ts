import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  codexMeta,
  handoffTitleFromPrompt,
  legacyAgentTitleMatches,
  trafficStateFromCodex,
  workbuddyTitle,
} from './agent-transcript'

test('codexMeta reads a session_meta line larger than 4KB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-codex-meta-'))
  const file = path.join(dir, 'rollout.jsonl')
  try {
    const payload = {
      id: 'session-id',
      session_id: 'session-id',
      cwd: '/Users/example/project',
      base_instructions: 'x'.repeat(16 * 1024),
    }
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload })}\n{"type":"event_msg"}\n`)
    assert.deepEqual(codexMeta(file), {
      id: 'session-id',
      session_id: 'session-id',
      cwd: '/Users/example/project',
      base_instructions: payload.base_instructions,
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff title is recoverable from the prompt without the handoff file', () => {
  const prompt =
    '先读 /missing/handoff.md ——这是之前一段会话的完整记录（来自 areco手机端的会话点击进去会跳转错误,看下是什么原因?），读完后接着其中最后的任务继续。'
  assert.equal(
    handoffTitleFromPrompt(prompt),
    'areco手机端的会话点击进去会跳转错误,看下是什么原因?'
  )
})

test('legacy WorkBuddy session binds by its native AI title', () => {
  const raw = [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '这是一条测试消息' }] }),
    JSON.stringify({ type: 'ai-title', aiTitle: '测试会话技能' }),
  ].join('\n')
  assert.equal(workbuddyTitle(raw), '测试会话技能')
  assert.equal(legacyAgentTitleMatches('测试会话skill', workbuddyTitle(raw)), true)
  assert.equal(legacyAgentTitleMatches('解释ace的含义', workbuddyTitle(raw)), false)
})

test('Codex traffic follows task lifecycle instead of assistant progress messages', () => {
  const rows: Array<Record<string, unknown>> = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '正在检查。' }] },
    },
  ]
  assert.equal(trafficStateFromCodex(rows.map((row) => JSON.stringify(row)).join('\n')), 'working')

  rows.push({ type: 'event_msg', payload: { type: 'task_complete' } })
  assert.equal(trafficStateFromCodex(rows.map((row) => JSON.stringify(row)).join('\n')), 'conclusion')
})

test('Codex traffic is yellow only while request_user_input is pending', () => {
  const rows: Array<Record<string, unknown>> = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'request_user_input', call_id: 'call-1' },
    },
  ]
  assert.equal(trafficStateFromCodex(rows.map((row) => JSON.stringify(row)).join('\n')), 'needs-user')

  rows.push({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call-1', output: '继续' },
  })
  assert.equal(trafficStateFromCodex(rows.map((row) => JSON.stringify(row)).join('\n')), 'working')
})

// ---- workbuddy 恢复对话绑定（restart resume 的凭据来源）----

import crypto from 'node:crypto'
import { bindFromPools, type BindingTarget } from './agent-transcript'

/** 最小会话面字面量：绑定结果落在 bound 上供断言 */
function wbSession(name: string): BindingTarget & { bound: string | null } {
  return {
    id: crypto.randomUUID(),
    name,
    agentBindingHash: null,
    bound: null,
    bindAgentSession(id: string) {
      this.bound = id
    },
  }
}

function writeWb(file: string, userTexts: string[]) {
  const lines = userTexts.map((text) =>
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
  )
  lines.push(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] }))
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

test('workbuddy 绑定：同名复读文件只认最新 epoch 的那个', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    const older = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl')
    const latest = path.join(dir, '33333333-3333-4333-8333-333333333333.jsonl')
    // 恢复失败反复全新启动：用户每次都重发同一句开场，落盘出一批同标题文件
    writeWb(older, ['查freemodel余额'])
    writeWb(latest, ['查freemodel余额'])
    const session = wbSession('查freemodel余额')
    // 旧行为：epoch∪lifetime 池里 2 个同名候选 → 歧义不绑 → restart 拿不到 --resume 凭据
    assert.equal(bindFromPools(session, 'workbuddy', [latest], [latest, older]), latest)
    assert.equal(session.bound, '33333333-3333-4333-8333-333333333333')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('workbuddy 绑定：首条被吞字导致证据全灭时，按 epoch 窗口唯一非空文件兜底', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    const old1 = path.join(dir, 'aaaaaaaa-1111-4111-8111-111111111111.jsonl')
    const old2 = path.join(dir, 'bbbbbbbb-2222-4222-8222-222222222222.jsonl')
    const latest = path.join(dir, 'cccccccc-3333-4333-8333-333333333333.jsonl')
    writeWb(old1, ['查freemodel余额'])
    writeWb(old2, ['查freemodel余额'])
    // 启动竞态吞字：「查freemodel余额」落盘只剩「查」，哈希/标题/名称证据全部失效
    writeWb(latest, ['查'])
    const session = wbSession('查freemodel余额')
    assert.equal(bindFromPools(session, 'workbuddy', [latest], [old1, old2, latest]), latest)
    assert.equal(session.bound, 'cccccccc-3333-4333-8333-333333333333')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('workbuddy 绑定：epoch 窗口多候选且内容无证据时不凭时间乱绑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    const a = path.join(dir, 'dddddddd-1111-4111-8111-111111111111.jsonl')
    const b = path.join(dir, 'eeeeeeee-2222-4222-8222-222222222222.jsonl')
    writeWb(a, ['完全无关的甲话题'])
    writeWb(b, ['完全无关的乙话题'])
    const session = wbSession('查freemodel余额')
    assert.equal(bindFromPools(session, 'workbuddy', [a, b], [a, b]), null)
    assert.equal(session.bound, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('workbuddy 绑定：唯一候选是空占位文件时不兜底（空文件无可恢复）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    const empty = path.join(dir, 'ffffffff-1111-4111-8111-111111111111.jsonl')
    fs.writeFileSync(empty, '')
    const session = wbSession('查freemodel余额')
    assert.equal(bindFromPools(session, 'workbuddy', [empty], [empty]), null)
    assert.equal(session.bound, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 占用过滤：幽灵卡根治（2026-07-22 kimi 双会话 37s 连开撞车）----

test('占用闸：epoch 唯一候选已被另一活会话占用时不兜底、不读、不绑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    // 同 cwd 秒级连开两个 agent：后启动者自己的文件尚未落盘，
    // 窗口内唯一候选是前者的文件——旧行为兜底抢走并返回供读取 → 幽灵卡
    const foreign = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl')
    writeWb(foreign, ['[项目·areco研发] 维护者: 你好'])
    const session = wbSession('Kimi K3')
    const occupied = (id: string) => id === '11111111-1111-4111-8111-111111111111'
    assert.equal(bindFromPools(session, 'workbuddy', [foreign], [foreign], occupied), null)
    assert.equal(session.bound, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('占用闸：过滤掉占用文件后，自己的文件落盘即可按唯一候选正确绑定', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    const foreign = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl')
    const own = path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl')
    writeWb(foreign, ['[项目·areco研发] 维护者: 你好'])
    writeWb(own, ['areco项目里面+agent应该如果已经添加了的agent就不要再出现选项给添加了'])
    const session = wbSession('Kimi K3') // 卡片名与两条消息都对不上，纯靠占用过滤后的唯一兜底
    const occupied = (id: string) => id === '11111111-1111-4111-8111-111111111111'
    assert.equal(bindFromPools(session, 'workbuddy', [foreign, own], [foreign, own], occupied), own)
    assert.equal(session.bound, '22222222-2222-4222-8222-222222222222')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 红绿灯残余场景回归（2026-07-19 实机诊断）----

import { parseQclaw } from './agent-transcript'
import { trafficStateFromMessages } from '../../../shared/traffic'

test('Codex turn_aborted is needs-user, not a conclusion', () => {
  const rows: Array<Record<string, unknown>> = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'turn_aborted' } },
  ]
  assert.equal(trafficStateFromCodex(rows.map((row) => JSON.stringify(row)).join('\n')), 'needs-user')
})

test('qclaw assistant text+toolCall stays working (toolCall must not be dropped)', () => {
  const raw = [
    JSON.stringify({ type: 'message', message: { role: 'user', content: '读一下交接文件' } }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先读文件。' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/a.md' } },
        ],
        stopReason: 'toolUse',
      },
    }),
  ].join('\n')
  const messages = parseQclaw(raw)
  assert.equal(messages.at(-1)?.parts.some((p) => p.kind === 'tool_use' && p.name === 'read'), true)
  assert.equal(trafficStateFromMessages(messages), 'working')
})

test('qclaw ask_user_question is needs-user', () => {
  const raw = JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_2', name: 'ask_user_question', arguments: { question: '选哪个？' } }],
      stopReason: 'toolUse',
    },
  })
  assert.equal(trafficStateFromMessages(parseQclaw(raw)), 'needs-user')
})

test('qclaw assistant error stopReason concludes instead of stuck working', () => {
  const raw = [
    JSON.stringify({ type: 'message', message: { role: 'user', content: '干活' } }),
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 服务太火爆了，请稍后再尝试。' },
    }),
  ].join('\n')
  assert.equal(trafficStateFromMessages(parseQclaw(raw)), 'conclusion')
})

test('workbuddy 绑定：同名证据多候选时取最近写入的那个（时间只破平局）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-wb-bind-'))
  try {
    const older = path.join(dir, '99999999-1111-4111-8111-111111111111.jsonl')
    const newer = path.join(dir, '88888888-2222-4222-8222-222222222222.jsonl')
    writeWb(older, ['查freemodel余额'])
    writeWb(newer, ['查freemodel余额'])
    // 文件名字典序与新旧相反，排除"碰巧按名排序"的假象
    fs.utimesSync(older, new Date('2026-07-19T08:00:00Z'), new Date('2026-07-19T08:00:00Z'))
    fs.utimesSync(newer, new Date('2026-07-19T09:00:00Z'), new Date('2026-07-19T09:00:00Z'))
    const session = wbSession('查freemodel余额')
    // 复现重启会让 epoch 窗口漂移、吞字占位文件被清理后 epoch 池为空：
    // 同名证据在 lifetime 池并列两个 → 取最近写入的那个（真实案例：903e89cd）
    assert.equal(bindFromPools(session, 'workbuddy', [], [older, newer]), newer)
    assert.equal(session.bound, '88888888-2222-4222-8222-222222222222')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- kimi（Kimi Code CLI）wire.jsonl 解析与恢复凭据 ----

import { kimiSessionIdOf, kimiTitleOf, parseKimi } from './agent-transcript'

const K = (obj: Record<string, unknown>) => JSON.stringify(obj)

test('kimi wire：prompt/steer 成 user，text/think 分判，tool.call/result 成对，噪声全忽略', () => {
  const raw = [
    K({ type: 'metadata', protocol_version: '1.4', created_at: 1784458813357 }),
    K({ type: 'config.update', modelAlias: 'kimi-code/k3', time: 1784458813358 }),
    K({ type: 'turn.prompt', input: [{ type: 'text', text: '测试标题' }], time: 1784458827441 }),
    // 镜像行：同一句话不能出第二条 user 消息
    K({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '测试标题' }], origin: { kind: 'user' } }, time: 1784458827441 }),
    K({ type: 'llm.request', kind: 'loop', model: 'k3', time: 1784458827446 }),
    K({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 1784458827443 }),
    K({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: '先想一想要不要读文件。' } }, time: 1784458827450 }),
    K({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read', args: { path: '/tmp/a.md' }, toolCallId: 'tool_1' }, time: 1784458827460 }),
    K({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'tool_1', result: { output: '文件内容' }, isError: null }, time: 1784458827470 }),
    K({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '知道，chatlog 是对话日志看板。' } }, time: 1784458827480 }),
    K({ type: 'turn.steer', input: [{ type: 'text', text: '你可以用集群来做吗？' }], time: 1784460067935 }),
    K({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '   ' } }, time: 1784460067940 }),
    K({ type: 'usage.record', time: 1784460067950 }),
  ].join('\n')

  const messages = parseKimi(raw)
  assert.deepEqual(
    messages.map((m) => [m.role, m.parts.map((p) => p.kind)]),
    [
      ['user', ['text']],
      ['assistant', ['thinking']],
      ['assistant', ['tool_use']],
      ['user', ['tool_result']],
      ['assistant', ['text']],
      ['user', ['text']],
    ]
  )
  assert.equal(messages[0].parts[0].kind === 'text' && messages[0].parts[0].text, '测试标题')
  assert.equal(messages[0].timestamp, new Date(1784458827441).toISOString())
  assert.equal(messages[1].parts[0].kind === 'thinking' && messages[1].parts[0].text, '先想一想要不要读文件。')
  const toolUse = messages[2].parts[0]
  assert.equal(toolUse.kind === 'tool_use' && toolUse.name, 'Read')
  assert.equal(toolUse.kind === 'tool_use' && toolUse.input.includes('/tmp/a.md'), true)
  const toolResult = messages[3].parts[0]
  assert.equal(toolResult.kind === 'tool_result' && toolResult.text, '文件内容')
  assert.equal(toolResult.kind === 'tool_result' && toolResult.isError, false)
  assert.equal(messages[5].parts[0].kind === 'text' && messages[5].parts[0].text, '你可以用集群来做吗？')
})

test('kimi wire：tool.result 的 JSON 字符串形态剥壳取 output；带 error 判 isError', () => {
  const raw = [
    K({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't1', result: '{"output":"剥出来的"}' }, time: 1000 }),
    K({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't2', result: { error: 'Command failed' }, time: 2000 } }),
    K({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't3', result: '非 JSON 原串', time: 3000 } }),
  ].join('\n')
  const [a, b, c] = parseKimi(raw)
  assert.deepEqual(a.parts[0], { kind: 'tool_result', text: '剥出来的', isError: false })
  assert.equal(b.parts[0].kind === 'tool_result' && b.parts[0].isError, true)
  assert.equal(b.parts[0].kind === 'tool_result' && b.parts[0].text, 'Command failed')
  assert.deepEqual(c.parts[0], { kind: 'tool_result', text: '非 JSON 原串', isError: false })
})

test('kimi traffic：尾条 assistant 纯文本判绿、尾条 tool.call 判红', () => {
  const done = [
    K({ type: 'turn.prompt', input: [{ type: 'text', text: '干活' }], time: 1000 }),
    K({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '干完了。' } }, time: 2000 }),
  ].join('\n')
  assert.equal(trafficStateFromMessages(parseKimi(done)), 'conclusion')

  const running = [
    K({ type: 'turn.prompt', input: [{ type: 'text', text: '干活' }], time: 1000 }),
    K({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: { command: 'ls' }, toolCallId: 't1' }, time: 2000 }),
  ].join('\n')
  assert.equal(trafficStateFromMessages(parseKimi(running)), 'working')
})

test('kimiSessionIdOf 从 wire 路径提取 session id；kimiTitleOf 读 state.json（New Session 视为无标题）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-kimi-'))
  try {
    const sessDir = path.join(dir, 'wd_tester_abc', 'session_ab076add-fdab-4463-88f9-4cfc426931bd')
    const wire = path.join(sessDir, 'agents', 'main', 'wire.jsonl')
    fs.mkdirSync(path.dirname(wire), { recursive: true })
    fs.writeFileSync(wire, '')
    assert.equal(kimiSessionIdOf(wire), 'session_ab076add-fdab-4463-88f9-4cfc426931bd')
    assert.equal(kimiSessionIdOf(path.join(dir, 'nowhere', 'wire.jsonl')), '')

    fs.writeFileSync(path.join(sessDir, 'state.json'), JSON.stringify({ title: '测试标题', workDir: '/Users/tester' }))
    assert.equal(kimiTitleOf(wire), '测试标题')
    fs.writeFileSync(path.join(sessDir, 'state.json'), JSON.stringify({ title: 'New Session', workDir: '/Users/tester' }))
    assert.equal(kimiTitleOf(wire), '')
    fs.rmSync(path.join(sessDir, 'state.json'))
    assert.equal(kimiTitleOf(wire), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 交接用全量读取（sessionHandoff 不走分页）----

import { readAgentFileAllMessages } from './agent-transcript'

test('readAgentFileAllMessages 尾部截断时对齐到行首，小文件全量返回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-handoff-all-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const lines = ['第一条', '第二条', '第三条'].map((text) =>
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
    )
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
    // 不截断：全量返回
    const all = readAgentFileAllMessages(file, 'workbuddy')
    assert.equal(all.length, 3)
    // 截断起点落在第一条行中间（字节计）：残首行丢弃，只剩完整行
    const headBytes = Buffer.byteLength(lines[0]) + 1
    const size = fs.statSync(file).size
    const tail = readAgentFileAllMessages(file, 'workbuddy', size - headBytes + 3)
    assert.equal(tail.length, 2)
    assert.equal(tail[0].parts[0].kind === 'text' ? tail[0].parts[0].text : '', '第二条')
    // 文件不存在：空数组
    assert.deepEqual(readAgentFileAllMessages(path.join(dir, 'missing.jsonl'), 'workbuddy'), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
