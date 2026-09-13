import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionStatus } from './protocol'
import { isExitedSessionCleanupCandidate } from './session-cleanup'

test('一键清理只选中未归档且已退出的会话', () => {
  assert.equal(isExitedSessionCleanupCandidate({ archived: false, status: 'exited' }), true)
  assert.equal(isExitedSessionCleanupCandidate({ archived: true, status: 'exited' }), false)

  for (const status of ['spawning', 'running', 'stopping', 'error'] satisfies SessionStatus[]) {
    assert.equal(isExitedSessionCleanupCandidate({ archived: false, status }), false, status)
  }
})
