import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { mcodeEntries, readMcdeTranscript } from './mcode-sessions'

const SID = 'mvs_0123456789abcdef0123456789abcdef'

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-mcode-'))
  const file = path.join(dir, 'runtime-state.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, title TEXT, workspace_dir TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER)`)
  db.exec(`CREATE TABLE local_runtime_message_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    role TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL)`)
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?)').run(
    SID,
    '把中枢换到主板 ds',
    '/Users/example/project',
    1794000000000,
    1794000060000
  )
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)').run(
    SID,
    'm1',
    'user',
    1794000000000,
    JSON.stringify({ msg_type: 1, msg_content: '把中枢换到主板 ds' })
  )
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)').run(
    SID,
    'm2',
    'assistant',
    1794000030000,
    JSON.stringify({
      msg_type: 2,
      thinking_content: '先读配置',
      msg_content: '',
      tool_calls: [{ tool_name: 'read', tool_call_args: '{"path":"a.txt"}' }],
    })
  )
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)').run(
    SID,
    'm3',
    'assistant',
    1794000060000,
    JSON.stringify({ msg_type: 1, msg_content: '已切好' })
  )
  db.close()
  return file
}

test('mcode 列表：标题/工作目录/时间取 session 表', () => {
  const file = fixture()
  const prev = process.env.ARECO_MCODE_DB
  process.env.ARECO_MCODE_DB = file
  try {
    const entries = mcodeEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].source, 'mcode')
    assert.equal(entries[0].id, SID)
    assert.equal(entries[0].title, '把中枢换到主板 ds')
    assert.equal(entries[0].cwd, '/Users/example/project')
    assert.equal(entries[0].mtimeMs, 1794000060000)
  } finally {
    if (prev === undefined) delete process.env.ARECO_MCODE_DB
    else process.env.ARECO_MCODE_DB = prev
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('mcode 正文：思考/工具/正文按段还原，空消息跳过', () => {
  const file = fixture()
  const prev = process.env.ARECO_MCODE_DB
  process.env.ARECO_MCODE_DB = file
  try {
    const page = readMcdeTranscript(SID)
    assert.equal(page.messages.length, 3)
    assert.equal(page.messages[0].role, 'user')
    assert.deepEqual(page.messages[1].parts.map((p) => p.kind), ['thinking', 'tool_use'])
    assert.equal(page.messages[2].parts[0].kind, 'text')
    assert.throws(() => readMcdeTranscript('../x'), /不合法/)
  } finally {
    if (prev === undefined) delete process.env.ARECO_MCODE_DB
    else process.env.ARECO_MCODE_DB = prev
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})
