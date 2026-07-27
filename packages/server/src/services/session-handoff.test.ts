import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Template } from '../../../shared/protocol'
import type { Session } from './session'
import { acceptsInitialPromptArg, handoffAgentKind, readSessionHandoffMessages } from './session-handoff'
import { cwdToSlug } from './transcript'

function template(patch: Partial<Template>): Template {
  return {
    id: 't',
    name: 'T',
    command: 'zsh',
    args: [],
    cwd: '/tmp',
    color: '#000',
    autoStart: false,
    enabled: true,
    ...patch,
  }
}

test('首条 prompt 投递按 harness/CLI 能力判断，不拿 transcriptDir 猜', () => {
  assert.equal(
    acceptsInitialPromptArg(
      template({
        command: 'qoderclicn',
        transcriptDir: '/Users/gao/.qoder-cn/projects',
      }),
    ),
    true,
  )
  assert.equal(acceptsInitialPromptArg(template({ command: 'codebuddy', harness: 'workbuddy' })), true)
  assert.equal(acceptsInitialPromptArg(template({ command: '/wrapper/wb', harness: 'workbuddy' })), true)
  assert.equal(acceptsInitialPromptArg(template({ command: '/wrapper/codex', harness: 'codex' })), true)
  assert.equal(acceptsInitialPromptArg(template({ command: '/wrapper/qoder', harness: 'qoder' })), true)
  assert.equal(
    acceptsInitialPromptArg(template({ command: 'unknown-cli', transcriptDir: '/tmp/unknown/projects' })),
    false,
  )
  assert.equal(acceptsInitialPromptArg(template({ command: 'kimi', harness: 'kimi' })), false)
  assert.equal(acceptsInitialPromptArg(template({ command: 'reasonix' })), false)
})

test('harness-first 包装器仍按真实 agent 类型读取交接 transcript', () => {
  const session = { command: '/Users/gao/Code/areco/bin/reasonix-stand' } as unknown as Session
  assert.equal(handoffAgentKind(session), 'reasonix')
  assert.equal(handoffAgentKind(session, template({ command: session.command, harness: 'reasonix' })), 'reasonix')
  assert.equal(
    handoffAgentKind({ command: '/wrapper/kimi' } as Session, template({ command: '/wrapper/kimi', harness: 'kimi' })),
    'kimi',
  )
  assert.equal(
    handoffAgentKind(
      { command: '/wrapper/workbuddy' } as Session,
      template({ command: '/wrapper/workbuddy', harness: 'workbuddy' }),
    ),
    'workbuddy',
  )
})

test('从 qoder transcriptDir 会话交接能定位 claude-layout 文件并读取全文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-qoder-handoff-'))
  const cwd = path.join(root, 'workspace')
  const projects = path.join(root, 'projects')
  const projectDir = path.join(projects, cwdToSlug(cwd))
  fs.mkdirSync(projectDir, { recursive: true })
  const file = path.join(projectDir, 'qoder-session.jsonl')
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'user', message: { content: '先检查登录问题' } }),
      JSON.stringify({ type: 'assistant', message: { content: '已经找到根因' } }),
      '',
    ].join('\n'),
  )
  const now = Date.now()
  const session = {
    id: 'qoder-handoff-test',
    command: 'qoderclicn',
    cwd,
    transcriptDir: projects,
    claudeSessionId: null,
    createdAt: now - 5_000,
    startedAt: now - 5_000,
    exitedAt: null,
    isRunning: true,
  } as unknown as Session
  try {
    const messages = readSessionHandoffMessages(session)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[1].role, 'assistant')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
