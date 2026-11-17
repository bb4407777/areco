// 请求号幂等窗：客户端回执超时用同一个 id 重发，服务端只放行第一次
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdempotencyWindow } from './idempotency'

test('同一请求号只放行一次，不同号各放行', () => {
  const win = new IdempotencyWindow()
  assert.equal(win.first('a'), true)
  assert.equal(win.first('a'), false)
  assert.equal(win.first('a'), false)
  assert.equal(win.first('b'), true)
})

test('不带请求号一律放行（老客户端无法判重）', () => {
  const win = new IdempotencyWindow()
  assert.equal(win.first(undefined), true)
  assert.equal(win.first(undefined), true)
  assert.equal(win.first(''), true)
})

test('过了窗口期允许再次放行', async () => {
  const win = new IdempotencyWindow(50)
  assert.equal(win.first('x'), true)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(win.first('x'), true)
})

test('条目数超上限时清表，不无限涨', () => {
  const win = new IdempotencyWindow(10 * 60_000, 5)
  for (let i = 0; i < 50; i++) win.first(`id-${i}`)
  assert.ok(win.size <= 5, `size=${win.size}`)
})
