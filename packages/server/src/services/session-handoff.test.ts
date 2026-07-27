import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Template } from '../../../shared/protocol'
import type { Session } from './session'
import { acceptsInitialPromptArg, readSessionHandoffMessages } from './session-handoff'
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

test('交接给 qoder/transcriptDir 模板时首条 prompt 走命令参数，不走 TUI 注入', () => {
  assert.equal(
    acceptsInitialPromptArg(
      template({
        command: 'qoderclicn',
        transcriptDir: '/Users/gao/.qoder-cn/projects',
      }),
    ),
    true,
  )
  assert.equal(acceptsInitialPromptArg(template({ command: 'reasonix' })), false)
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
