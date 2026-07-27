import { test } from 'node:test'
import assert from 'node:assert/strict'
import { duplicateBindingVictims } from './session-dedup'

test('双绑体检:同 nativeId 两会话,留 startedAt 最早,晚者为 victim', () => {
  const victims = duplicateBindingVictims([
    { id: 'A', agentSessionId: 'session_x', startedAt: 1000, createdAt: 900 },
    { id: 'B', agentSessionId: 'session_x', startedAt: 2000, createdAt: 1900 },
  ])
  assert.deepEqual(victims, ['B'])
})

test('双绑体检:三绑留最早,余两为 victim（顺序与 startedAt 无关，按保留者外全部）', () => {
  const victims = duplicateBindingVictims([
    { id: 'A', agentSessionId: 'x', startedAt: 3000, createdAt: 0 },
    { id: 'B', agentSessionId: 'x', startedAt: 1000, createdAt: 0 },
    { id: 'C', agentSessionId: 'x', startedAt: 2000, createdAt: 0 },
  ])
  assert.deepEqual([...victims].sort(), ['A', 'C']) // B 最早留
})

test('无双绑:每个 nativeId 一个会话,无 victim', () => {
  const victims = duplicateBindingVictims([
    { id: 'A', agentSessionId: 'x', startedAt: 1, createdAt: 0 },
    { id: 'B', agentSessionId: 'y', startedAt: 2, createdAt: 0 },
  ])
  assert.deepEqual(victims, [])
})

test('未绑(agentSessionId null)不参与,不会被误清', () => {
  const victims = duplicateBindingVictims([
    { id: 'A', agentSessionId: null, startedAt: 1, createdAt: 0 },
    { id: 'B', agentSessionId: null, startedAt: 2, createdAt: 0 },
  ])
  assert.deepEqual(victims, [])
})

test('startedAt 缺失时退 createdAt 决定原主（restore 早期会话可能无 startedAt）', () => {
  const victims = duplicateBindingVictims([
    { id: 'A', agentSessionId: 'x', startedAt: null, createdAt: 5000 },
    { id: 'B', agentSessionId: 'x', startedAt: null, createdAt: 1000 },
  ])
  assert.deepEqual(victims, ['A']) // B createdAt 早留
})

test('混合:一组双绑 + 一组单绑 + 一个未绑,只动双绑组', () => {
  const victims = duplicateBindingVictims([
    { id: 'keep', agentSessionId: 'shared', startedAt: 100, createdAt: 0 },
    { id: 'dup', agentSessionId: 'shared', startedAt: 200, createdAt: 0 },
    { id: 'solo', agentSessionId: 'own', startedAt: 300, createdAt: 0 },
    { id: 'loose', agentSessionId: null, startedAt: 400, createdAt: 0 },
  ])
  assert.deepEqual(victims, ['dup'])
})
