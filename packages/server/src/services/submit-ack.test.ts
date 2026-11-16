// 提交回执的判据：转写里出现这条 user 消息才算收下。
// 这一层单独测，因为它替代了「看屏幕猜」——判错就是重复发消息或字永远挂在输入框。
import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonlHasUserKey } from './submit-ack'

const row = (role: string, text: string) =>
  JSON.stringify({ type: 'message', role, content: [{ type: 'input_text', text }] })

test('尾段命中即算回执（长文按尾部 24 字认）', () => {
  const raw = [row('user', '把这份合同逐条核对，重点看违约责任和付款节点。')].join('\n')
  assert.equal(jsonlHasUserKey(raw, '违约责任和付款节点。'), true)
})

test('只有 assistant 行不算回执', () => {
  const raw = [row('assistant', '违约责任和付款节点我已经看过了')].join('\n')
  assert.equal(jsonlHasUserKey(raw, '违约责任和付款节点'), false)
})

test('别的消息不算回执（防止把上一轮当成这一轮）', () => {
  const raw = [row('user', '上一条完全不同的指令')].join('\n')
  assert.equal(jsonlHasUserKey(raw, '违约责任和付款节点'), false)
})

test('短消息（<8 字）不做内容比对，新落的 user 行即算', () => {
  const raw = [row('user', '好了吗')].join('\n')
  assert.equal(jsonlHasUserKey(raw, '好了吗', true), true)
})

test('末行写了一半（JSON 不完整）也能认出前面那条完整消息', () => {
  const raw = [
    row('user', '完整的一条'),
    '{"type":"message","role":"user","content":[{"type":"input_te',
  ].join('\n')
  assert.equal(jsonlHasUserKey(raw, '完整的一条'), true)
})
