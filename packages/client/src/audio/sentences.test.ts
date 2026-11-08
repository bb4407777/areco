import assert from 'node:assert/strict'
import test from 'node:test'
import { CODE_PLACEHOLDER, splitForSpeech } from './sentences'

test('按句末标点切分，句内逗号不断句', () => {
  assert.deepEqual(splitForSpeech('我先看一下材料，再说结论。第二句在这里！'), [
    '我先看一下材料，再说结论。',
    '第二句在这里！',
  ])
})

test('没有句末标点时整段作一句', () => {
  assert.deepEqual(splitForSpeech('没有标点的一段话'), ['没有标点的一段话'])
})

test('去掉 markdown 修饰与列表标记', () => {
  assert.deepEqual(splitForSpeech('**第一句**。\n- 第二句。'), ['第一句。', '第二句。'])
})

test('代码块不朗读，只留提示', () => {
  const out = splitForSpeech('看这段。```js\nconst a = 1\n```看完了吧。')
  assert.deepEqual(out, ['看这段。', CODE_PLACEHOLDER + '看完了吧。'])
})

test('超长无标点句按逗号截断', () => {
  const text = '甲'.repeat(30) + '，' + '乙'.repeat(30) + '。'
  const out = splitForSpeech(text)
  assert.equal(out.length, 2)
  assert.ok(out[0].endsWith('，'))
})

test('空文本不产生请求', () => {
  assert.deepEqual(splitForSpeech('   \n '), [])
})

test('纯符号碎片不单独成句：并进上一句', () => {
  assert.deepEqual(splitForSpeech('他来了。——然后呢？'), ['他来了。', '——然后呢？'])
})

test('整段只有符号时不出句', () => {
  assert.deepEqual(splitForSpeech('—— …。（）'), [])
})
