import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isNameWorthy, isTopicContinuation, NameTracker, nameCandidateOf } from './session-namer'

function feed(tracker: NameTracker, source: Parameters<NameTracker['feed']>[1], lines: string[]) {
  tracker.feed(Buffer.from(lines.join('\n') + '\n', 'utf8'), source)
}

test('claude：custom-title/ai-title 两种原生标题行都跟，后出现的覆盖先出现的，prompt 行不参与', () => {
  const t = new NameTracker()
  feed(t, 'claude', [
    JSON.stringify({ type: 'user', message: { content: '帮我看看登录 bug' } }),
    JSON.stringify({ type: 'custom-title', customTitle: '登录 bug 排查' }),
    JSON.stringify({ type: 'user', message: { content: '换成 JWT 方案吧' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'JWT 迁移', sessionId: 'x' }), // 本机定制构建的标题行
  ])
  assert.equal(t.nativeTitle, 'JWT 迁移')
  assert.equal(t.promptTitle, '') // claude 不追 prompt
  assert.equal(nameCandidateOf(t, 'claude'), 'JWT 迁移')
})

test('workbuddy：ai-title 行成原生标题；无标题行时 prompt 兜底', () => {
  const titled = new NameTracker()
  feed(titled, 'workbuddy', [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下余额' }] }),
    JSON.stringify({ type: 'ai-title', aiTitle: '余额查询' }),
  ])
  assert.equal(titled.nativeTitle, '余额查询')
  assert.equal(nameCandidateOf(titled, 'workbuddy'), '余额查询')

  const untitled = new NameTracker()
  feed(untitled, 'workbuddy', [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下余额' }] }),
  ])
  assert.equal(nameCandidateOf(untitled, 'workbuddy'), '查一下余额')
})

test('codex：AGENTS.md 引导注入不算用户输入，最新 prompt 演化', () => {
  const t = new NameTracker()
  feed(t, 'codex', [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<environment_context>x</environment_context>' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一个任务' }] },
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '话题漂移到部署' }] },
    }),
  ])
  assert.equal(nameCandidateOf(t, 'codex'), '话题漂移到部署')
})

test('kimi：turn.prompt/steer 为候选，context 镜像行不算', () => {
  const t = new NameTracker()
  feed(t, 'kimi', [
    JSON.stringify({ type: 'turn.prompt', time: 1, input: [{ type: 'text', text: '先修会话命名' }] }),
    JSON.stringify({ type: 'context.append_message', time: 2, origin: 'user', text: '先修会话命名' }),
    JSON.stringify({ type: 'turn.steer', time: 3, input: [{ type: 'text', text: '顺便补个测试' }] }),
  ])
  assert.equal(nameCandidateOf(t, 'kimi'), '顺便补个测试')
})

test('qclaw：用户文本演化，toolResult 不算', () => {
  const t = new NameTracker()
  feed(t, 'qclaw', [
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '看看台账' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool 输出不该成名' }] } }),
  ])
  assert.equal(nameCandidateOf(t, 'qclaw'), '看看台账')
})

test('交接档案注入：能取档案标题就用，取不到不改名', () => {
  const t = new NameTracker()
  feed(t, 'codex', [
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '正常第一句话' }] },
    }),
    // 文件不存在、但嵌了「来自 X」——取 X 当标题（与绑定证据同口径）
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '先读 /missing/x.md ——这是之前一段会话的完整记录（来自 桥水达利欧skill），读完后接着其中最后的任务继续。' },
        ],
      },
    }),
  ])
  assert.equal(nameCandidateOf(t, 'codex'), '桥水达利欧skill')
})

test('半行不消费：无换行不动 offset，从 cursor 重读后才解析；长名截断带省略号', () => {
  const t = new NameTracker()
  const line = JSON.stringify({ type: 'custom-title', customTitle: 'x'.repeat(100) })
  const buf = Buffer.from(line + '\n', 'utf8')
  const cut = Math.floor(buf.length / 2)
  t.feed(buf.subarray(0, cut), 'claude') // 半行：无换行，消费 0 字节
  assert.equal(t.cursor, 0)
  assert.equal(t.nativeTitle, '')
  t.feed(buf.subarray(t.cursor), 'claude') // 调用方按 cursor 重读，半行字节自然拼回
  assert.equal(t.cursor, buf.length)
  assert.equal(t.nativeTitle, 'x'.repeat(79) + '…')
})

test('多字节字符跨 chunk 不炸：offset 只停在换行边界', () => {
  const t = new NameTracker()
  const line = JSON.stringify({ type: 'custom-title', customTitle: '中文字标题测试' })
  const buf = Buffer.from(line + '\n', 'utf8')
  // 从一个多字节字符中间切开喂：前半无换行不消费，重读全量后完整解析
  t.feed(buf.subarray(0, buf.length - 5), 'claude')
  assert.equal(t.cursor, 0)
  t.feed(buf.subarray(t.cursor), 'claude')
  assert.equal(t.nativeTitle, '中文字标题测试')
})

test('resetIfShrunk：文件被替换截断后从头重扫', () => {
  const t = new NameTracker()
  feed(t, 'claude', [JSON.stringify({ type: 'custom-title', customTitle: '旧标题' })])
  const cursor = t.cursor
  assert.ok(cursor > 0)
  t.resetIfShrunk(cursor - 1)
  assert.equal(t.cursor, 0)
  t.resetIfShrunk(cursor + 100)
  assert.equal(t.cursor, 0) // 已归零后 size 仍 >= 0，不再变化
})

test('无意义输入不当候选名：好/ok/继续/短输入不覆盖有意义的名字', () => {
  const t = new NameTracker()
  feed(t, 'kimi', [
    JSON.stringify({ type: 'turn.prompt', time: 1, input: [{ type: 'text', text: '整理麦晓娴案还款流水' }] }),
    JSON.stringify({ type: 'turn.prompt', time: 2, input: [{ type: 'text', text: '好' }] }),
    JSON.stringify({ type: 'turn.prompt', time: 3, input: [{ type: 'text', text: 'ok' }] }),
    JSON.stringify({ type: 'turn.prompt', time: 4, input: [{ type: 'text', text: '继续' }] }),
    JSON.stringify({ type: 'turn.prompt', time: 5, input: [{ type: 'text', text: '嗯嗯' }] }),
    JSON.stringify({ type: 'turn.prompt', time: 6, input: [{ type: 'text', text: '！！！' }] }),
    JSON.stringify({ type: 'turn.prompt', time: 7, input: [{ type: 'text', text: '看' }] }),
  ])
  assert.equal(nameCandidateOf(t, 'kimi'), '整理麦晓娴案还款流水')
  // 新主题（够格）照常演化
  feed(t, 'kimi', [JSON.stringify({ type: 'turn.prompt', time: 8, input: [{ type: 'text', text: '接下来起草起诉状' }] })])
  assert.equal(nameCandidateOf(t, 'kimi'), '接下来起草起诉状')
})

test('isNameWorthy：≥4 有效字符且非停用词才够格；大小写/标点不干扰判定', () => {
  assert.equal(isNameWorthy('好'), false)
  assert.equal(isNameWorthy('好的'), false)
  assert.equal(isNameWorthy('OK'), false)
  assert.equal(isNameWorthy('ok。'), false) // 标点剥掉后还是 ok
  assert.equal(isNameWorthy('继续'), false)
  assert.equal(isNameWorthy('收到'), false)
  assert.equal(isNameWorthy('👍👍👍👍'), false) // 无有效字符
  assert.equal(isNameWorthy('看下账'), false) // 3 字不够
  assert.equal(isNameWorthy('看看台账'), true)
  assert.equal(isNameWorthy('整理麦晓娴案还款流水'), true)
})

test('isTopicContinuation：子串相含或高度重合 → 延续不换名；新话题 → 换', () => {
  // 子串：当前名是候选的截断版
  assert.equal(isTopicContinuation('整理麦晓娴案还款流水PDF', '整理麦晓娴案还款流水'), true)
  // 高重合：同话题换说法
  assert.equal(isTopicContinuation('还款流水整理', '整理还款流水'), true)
  // 新话题
  assert.equal(isTopicContinuation('整理麦晓娴案还款流水', '接下来起草起诉状'), false)
  // 占位名 vs 首个真实标题：不重合，放行
  assert.equal(isTopicContinuation('Kimi K3 #7', '整理麦晓娴案还款流水'), false)
  // 空串/纯标点不误判
  assert.equal(isTopicContinuation('！！！', '整理麦晓娴案还款流水'), false)
})
