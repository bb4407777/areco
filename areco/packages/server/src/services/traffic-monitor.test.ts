import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readClaudeTrafficState, transcriptFingerprint } from './traffic-monitor'

function transcriptRow(role: 'user' | 'assistant', content: unknown): string {
  return JSON.stringify({
    type: role,
    message: { content },
    timestamp: new Date().toISOString(),
  })
}

test('traffic monitor reads completed transcript lines and ignores an incomplete tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-traffic-'))
  const file = path.join(dir, 'transcript.jsonl')
  try {
    fs.writeFileSync(file, `${transcriptRow('user', '处理任务')}\n`)
    assert.ok(transcriptFingerprint(file))
    assert.equal(readClaudeTrafficState(file), 'working')

    fs.appendFileSync(
      file,
      `${transcriptRow('assistant', [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }])}\n`
    )
    assert.ok(transcriptFingerprint(file))
    assert.equal(readClaudeTrafficState(file), 'needs-user')

    fs.appendFileSync(file, `${transcriptRow('user', '继续')}\n`)
    assert.equal(readClaudeTrafficState(file), 'working')

    fs.appendFileSync(file, transcriptRow('assistant', '已完成'))
    assert.equal(transcriptFingerprint(file), null)

    fs.appendFileSync(file, '\n')
    assert.ok(transcriptFingerprint(file))
    assert.equal(readClaudeTrafficState(file), 'conclusion')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
