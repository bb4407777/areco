import assert from 'node:assert/strict'
import test from 'node:test'
import { isTaskNotification, parseTaskNotification } from './notify'

const SAMPLE = `<task-notification>
<task-id>a9990eda6ee2124a5</task-id>
<tool-use-id>toolu_01XkEVdr2Lp8sqLxQeYkxNNH</tool-use-id>
<output-file>/private/tmp/claude-501/tasks/a9990eda6ee2124a5.output</output-file>
<status>completed</status>
<summary>Agent "波5-丙：末批 8 job" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>All 8 jobs closed out. Results:

**24民0257: SKIP** — 链条裁定适用。</result>
<usage><subagent_tokens>179413</subagent_tokens></usage>
</task-notification>`

test('task-notification 前缀识别（含前导空白），普通指令不误伤', () => {
  assert.equal(isTaskNotification(SAMPLE), true)
  assert.equal(isTaskNotification('\n  ' + SAMPLE), true)
  assert.equal(isTaskNotification('帮我看看 <task-notification> 是什么'), false)
  assert.equal(isTaskNotification('修一下这个 bug'), false)
})

test('parse 提取 summary 做标题、result 做正文', () => {
  const n = parseTaskNotification(SAMPLE)
  assert.ok(n)
  assert.equal(n.summary, 'Agent "波5-丙：末批 8 job" finished')
  assert.ok(n.body.startsWith('All 8 jobs closed out.'))
  assert.ok(n.body.includes('24民0257'))
})

test('标签缺失时兜底：标题给通用名、正文给原文', () => {
  const n = parseTaskNotification('<task-notification>\n<task-id>x</task-id>\n</task-notification>')
  assert.ok(n)
  assert.equal(n.summary, '子任务通知')
  assert.ok(n.body.includes('<task-id>x</task-id>'))
  assert.equal(parseTaskNotification('普通消息'), null)
})
