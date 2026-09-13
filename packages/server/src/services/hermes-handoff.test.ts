import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Template } from '../../../shared/protocol'
import type { Session } from './session'
import { hermesHomeOf, isHermesTemplate, readHermesHandoffMessages } from './hermes-handoff'

function template(home: string): Template {
  return {
    id: 'hermes',
    name: 'Hermes',
    command: '/usr/bin/env',
    args: [`HERMES_HOME=${home}`, '/opt/bin/hermes', 'chat', '--cli'],
    cwd: '/workspace',
    color: '#000',
    autoStart: false,
    enabled: true,
  }
}

test('旧式 env 模板能识别 Hermes 并解析 HERMES_HOME', () => {
  const t = template('/tmp/hermes-home')
  assert.equal(isHermesTemplate(t), true)
  assert.equal(hermesHomeOf(t), '/tmp/hermes-home')
})

test('Hermes 接手从 state.db 按 cwd + 生命周期定位 CLI 会话并读取消息', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-hermes-handoff-'))
  const db = new DatabaseSync(path.join(home, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at REAL, message_count INTEGER);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, reasoning TEXT,
      tool_name TEXT, timestamp REAL, active INTEGER
    );
    INSERT INTO sessions VALUES ('cli-session', 'cli', '/workspace', 1000, 2);
    INSERT INTO messages VALUES (1, 'cli-session', 'user', '检查接手', NULL, NULL, 1001, 1);
    INSERT INTO messages VALUES (2, 'cli-session', 'assistant', '已经完成', '先核对记录', NULL, 1002, 1);
  `)
  db.close()
  let bound = ''
  const session = {
    id: 'areco-hermes',
    command: '/usr/bin/env',
    cwd: '/workspace',
    createdAt: 999_000,
    startedAt: 999_000,
    exitedAt: 1003_000,
    isRunning: false,
    agentSessionId: null,
    bindAgentSession(id: string) {
      bound = id
    },
  } as unknown as Session
  try {
    const messages = readHermesHandoffMessages(session, template(home))
    assert.equal(bound, 'cli-session')
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.deepEqual(messages[1].parts.map((p) => p.kind), ['thinking', 'text'])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
