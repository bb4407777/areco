import assert from 'node:assert/strict'
import test from 'node:test'
import { typewriterStep } from './typewriter'

test('追平后归零，小积压逐字吐', () => {
  assert.equal(typewriterStep(10, 10), 0)
  assert.equal(typewriterStep(12, 10), 0) // 全页替换后收缩：调用方重置，这里只须不出负步
  assert.equal(typewriterStep(9, 10), 1)
  assert.equal(typewriterStep(0, 40), 1)
})

test('积压越大步子越大，封顶 24', () => {
  assert.equal(typewriterStep(0, 800), 10)
  assert.equal(typewriterStep(0, 100000), 24)
  // 单调不减：更大的积压不会吐得更慢
  let prev = 0
  for (const pending of [1, 80, 160, 800, 2000, 5000]) {
    const step = typewriterStep(0, pending)
    assert.ok(step >= prev)
    prev = step
  }
})

test('有限拍数内追平大段落盘（不会永远落后）', () => {
  let shown = 0
  const full = 20000
  let ticks = 0
  while (shown < full && ticks < 5000) {
    shown += typewriterStep(shown, full)
    ticks++
  }
  assert.equal(shown >= full, true)
  assert.ok(ticks < 1200) // 55ms/拍 → 20k 字一分钟出头内追完
})
