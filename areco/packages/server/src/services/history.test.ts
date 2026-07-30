import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { kimiEntries, kimiParseLine, kimiWorkDirOf, readHistoryPage, resolveKimiWire } from './history'

/** 造一个 kimi 落盘 fixture：<tmp>/sessions/<wd>/<sessionId>/{state.json, agents/main/wire.jsonl} */
function kimiFixture(): { root: string; wd: string; sid: string; wire: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-kimi-history-'))
  const wd = 'wd_test_abc123'
  const sid = 'session_0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d'
  const sessionDir = path.join(root, wd, sid)
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      title: 'New Session',
      workDir: '/Users/example/project',
      createdAt: '2026-07-19T14:08:38.288Z',
      lastPrompt: '帮我查一下历史页面的问题',
    })
  )
  const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl')
  const lines = [
    { type: 'turn.prompt', time: 1784472000000, input: [{ type: 'text', text: '你好' }] },
    {
      type: 'context.append_loop_event',
      time: 1784472001000,
      event: { type: 'content.part', part: { type: 'text', text: '你好！有什么可以帮你的？' } },
    },
    { type: 'step.begin', time: 1784472001500 }, // 噪声行：不出消息
    {
      type: 'context.append_loop_event',
      time: 1784472002000,
      event: { type: 'tool.call', name: 'Bash', args: { command: 'ls' } },
    },
    { type: 'turn.prompt', time: 1784472003000, input: [{ type: 'text', text: '第二条问题' }] },
  ]
  fs.writeFileSync(wire, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { root, wd, sid, wire }
}

test('kimiEntries scans sessions root and reads meta from state.json', () => {
  const { root, wd, sid } = kimiFixture()
  try {
    const entries = kimiEntries(root)
    assert.equal(entries.length, 1)
    const e = entries[0]
    assert.equal(e.source, 'kimi')
    assert.equal(e.project, wd)
    assert.equal(e.id, sid)
    // 「New Session」占位标题回退 lastPrompt
    assert.equal(e.title, '帮我查一下历史页面的问题')
    assert.equal(e.cwd, '/Users/example/project')
    assert.equal(e.createdMs, Date.parse('2026-07-19T14:08:38.288Z'))
    assert.ok(e.size > 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('kimiEntries skips sub-agent wires and empty mains', () => {
  const { root, wd, sid } = kimiFixture()
  try {
    // 子代理 wire：不收
    const subDir = path.join(root, wd, sid, 'agents', 'agent-1')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'wire.jsonl'), '{"type":"turn.prompt","time":1,"input":[{"type":"text","text":"x"}]}\n')
    // 空 main wire 的另一个会话：不收
    const emptyDir = path.join(root, wd, 'session_ffffffff-ffff-ffff-ffff-ffffffffffff')
    fs.mkdirSync(path.join(emptyDir, 'agents', 'main'), { recursive: true })
    fs.writeFileSync(path.join(emptyDir, 'agents', 'main', 'wire.jsonl'), '')
    assert.equal(kimiEntries(root).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveKimiWire validates segments and locates the wire file', () => {
  const { root, wd, sid, wire } = kimiFixture()
  try {
    assert.equal(resolveKimiWire(wd, sid, root), wire)
    assert.throws(() => resolveKimiWire('..', sid, root), /项目名不合法/)
    assert.throws(() => resolveKimiWire(wd, 'not-a-session', root), /会话 id 不合法/)
    assert.throws(() => resolveKimiWire(wd, 'session_99999999-9999-9999-9999-999999999999', root), /历史会话不存在/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('kimiWorkDirOf reads workDir from state.json next to the wire', () => {
  const { root, wire } = kimiFixture()
  try {
    assert.equal(kimiWorkDirOf(wire), '/Users/example/project')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readHistoryPage pages kimi wire with kimiParseLine (tail-first, byte cursor)', () => {
  const { root, wire } = kimiFixture()
  try {
    const page = readHistoryPage(wire, undefined, kimiParseLine)
    // 5 行里 4 行出消息（step.begin 噪声被过滤）
    assert.equal(page.messages.length, 4)
    assert.equal(page.messages[0].role, 'user')
    assert.equal(page.messages[1].role, 'assistant')
    assert.equal(page.messages[2].parts[0].kind, 'tool_use')
    // 向前翻页：before=上页 start 之后没有更早内容
    const older = readHistoryPage(wire, page.start, kimiParseLine)
    assert.equal(older.messages.length, 0)
    assert.equal(older.hasMore, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readHistoryPage 半截行 bail 不消费未写完数据（end 退到完整行边界）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-history-half-'))
  try {
    const f = path.join(dir, 's.jsonl')
    const line = JSON.stringify({ type: 'user', message: { content: '第一条' } })
    // 写到一半的半截行（无换行收尾）：首载不得把 end 推到文件 size，
    // 否则客户端增量游标越过它，行补全后也读不回（首条消息永久缺失）
    fs.writeFileSync(f, line)
    const page = readHistoryPage(f)
    assert.equal(page.messages.length, 0)
    assert.equal(page.end, 0)
    assert.equal(page.hasMore, false)
    // 行补全后重新首载能完整读回
    fs.appendFileSync(f, '\n')
    const done = readHistoryPage(f)
    assert.equal(done.messages.length, 1)
    assert.equal(done.end, Buffer.byteLength(line) + 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readHistoryPage 单行超 8MB：游标退到块前、hasMore 诚实，可跳过继续向前翻', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-history-giant-'))
  try {
    const f = path.join(dir, 's.jsonl')
    const first = JSON.stringify({ type: 'user', message: { content: '早' } }) + '\n'
    // 一条 >8MB 无换行的超长行（尾部半截，内容无所谓）
    fs.writeFileSync(f, first + 'x'.repeat(9 * 1024 * 1024))
    const size = fs.statSync(f).size
    const page = readHistoryPage(f)
    assert.equal(page.messages.length, 0)
    // 不消费未对齐数据：end 不得等于文件 size；hasMore 诚实（之前确有内容）
    assert.ok(page.end < size)
    assert.equal(page.end, page.start)
    assert.equal(page.hasMore, true)
    // before=start 跳过超长块后，更早的完整行能翻出来
    const older = readHistoryPage(f, page.start)
    assert.equal(older.messages.length, 1)
    assert.equal(older.start, 0)
    assert.equal(older.hasMore, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
