// 多端 resize 仲裁（手机端纯观看不许挤小桌面端 PTY，控制者永远说了算）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldApplyResize } from './resize-policy'

const DESKTOP = { cols: 220, rows: 50 }
const MOBILE = { cols: 52, rows: 24 }

test('无控制者：先到先得，任何尺寸都放行（单端场景与旧行为一致）', () => {
  assert.equal(shouldApplyResize(DESKTOP, MOBILE, { isController: false, hasController: false }), true)
})

test('控制者：缩小也放行（开车的人用自己的尺寸）', () => {
  assert.equal(shouldApplyResize(DESKTOP, MOBILE, { isController: true, hasController: true }), true)
  assert.equal(shouldApplyResize(MOBILE, DESKTOP, { isController: true, hasController: true }), true)
})

test('非控制者缩小被拒：手机竖屏观看不许挤窄桌面（核心 bug 场景）', () => {
  assert.equal(shouldApplyResize(DESKTOP, MOBILE, { isController: false, hasController: true }), false)
})

test('非控制者双向更大才放行（观看者可以撑大）', () => {
  const BIGGER = { cols: 260, rows: 60 }
  assert.equal(shouldApplyResize(DESKTOP, BIGGER, { isController: false, hasController: true }), true)
})

test('非控制者单维更小也拒：宽更宽但行数更少，照样不放行', () => {
  assert.equal(shouldApplyResize(DESKTOP, { cols: 300, rows: 30 }, { isController: false, hasController: true }), false)
  assert.equal(shouldApplyResize(DESKTOP, { cols: 200, rows: 60 }, { isController: false, hasController: true }), false)
})

test('非控制者等尺寸放行（幂等无操作，session.resize 内部也会早退）', () => {
  assert.equal(shouldApplyResize(DESKTOP, DESKTOP, { isController: false, hasController: true }), true)
})
