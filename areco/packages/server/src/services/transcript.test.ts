import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTranscriptLine } from './transcript'

function userLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { content }, timestamp: '2026-07-26T12:00:00.000Z' })
}

test('task-notification 合成 user 行归 notice 段（agent 侧），不冒充用户指令', () => {
  const msg = parseTranscriptLine(
    userLine('<task-notification>\n<task-id>a1</task-id>\n<summary>Agent "波5" finished</summary>\n<result>done</result>\n</task-notification>')
  )
  assert.ok(msg)
  assert.equal(msg.role, 'user')
  assert.equal(msg.parts.length, 1)
  assert.equal(msg.parts[0].kind, 'notice')
})

test('真人指令仍是 text 段（用户侧）', () => {
  const msg = parseTranscriptLine(userLine('帮我看看这个 bug'))
  assert.ok(msg)
  assert.equal(msg.parts[0].kind, 'text')
})

test('提到 task-notification 字样但非开头的正文不误归', () => {
  const msg = parseTranscriptLine(userLine('为什么 <task-notification> 显示在用户侧？'))
  assert.ok(msg)
  assert.equal(msg.parts[0].kind, 'text')
})

test('assistant 字符串正文不受通知归类影响', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: '<task-notification>…（复述通知内容的回答）' },
    timestamp: null,
  })
  const msg = parseTranscriptLine(line)
  assert.ok(msg)
  assert.equal(msg.parts[0].kind, 'text')
})
