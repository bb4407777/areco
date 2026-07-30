import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoomMessage } from '../../../shared/protocol'
import { collectProjectArtifactMentions } from './projectArtifacts'

function message(id: number, from: string, body: string, createdAt: string): RoomMessage {
  return { id, roomId: 'room-1', from, to: '维护者', body, createdAt }
}

test('项目成果排除人类上传材料，并记录首位产出 Agent 与后续参与者', () => {
  const messages = [
    message(1, '维护者', '原始材料：/Users/gao/case/合同.pdf', '2026-07-22T01:00:00Z'),
    message(2, 'Kimi K3', '已完成，产物：/Users/gao/case/赔偿明细.docx', '2026-07-22T02:00:00Z'),
    message(3, 'Claude Code', '修改完成，已保存 /Users/gao/case/赔偿明细.docx', '2026-07-22T03:00:00Z'),
  ]

  const result = collectProjectArtifactMentions(messages, '维护者')
  assert.equal(result.length, 1)
  assert.equal(result[0].path, '/Users/gao/case/赔偿明细.docx')
  assert.equal(result[0].producer, 'Kimi K3')
  assert.deepEqual(result[0].contributors, ['Kimi K3', 'Claude Code'])
  assert.equal(result[0].lastMentionAt, '2026-07-22T03:00:00Z')
})

test('普通讨论中的路径不误标为成果，结果按最近回执排序', () => {
  const messages = [
    message(1, 'Agent A', '请查看 /Users/gao/case/证据.pdf', '2026-07-22T01:00:00Z'),
    message(2, 'Agent A', '初稿已生成：/Users/gao/case/初稿.docx', '2026-07-22T02:00:00Z'),
    message(3, 'Agent B', '交付物已完成：/Users/gao/case/清单.xlsx', '2026-07-22T03:00:00Z'),
  ]

  const result = collectProjectArtifactMentions(messages, '维护者')
  assert.deepEqual(result.map((item) => item.name), ['清单.xlsx', '初稿.docx'])
})

test('保留案件目录内的相对成果路径，不把它猜成绝对路径', () => {
  const messages = [
    message(
      1,
      'OpenAI Codex',
      '已完成并生成：`6庭后补充/20260722李金满交通事故赔偿项目明细.docx`',
      '2026-07-22T04:00:00Z',
    ),
    message(
      2,
      'Claude Code',
      '修改完成，已保存 6庭后补充/20260722李金满交通事故赔偿项目明细.docx',
      '2026-07-22T05:00:00Z',
    ),
  ]

  const result = collectProjectArtifactMentions(messages, '维护者')
  assert.equal(result.length, 1)
  assert.equal(result[0].path, '6庭后补充/20260722李金满交通事故赔偿项目明细.docx')
  assert.equal(result[0].producer, 'OpenAI Codex')
  assert.deepEqual(result[0].contributors, ['OpenAI Codex', 'Claude Code'])
})

test('带中文括号的绝对路径不会重复截出相对路径后缀', () => {
  const path = '/Users/gao/data/26咨0611泰和vs今科（建设工程合同纠纷）（咨询）/法律意见书.docx'
  const result = collectProjectArtifactMentions([
    message(1, 'Glm5.2', `初稿已生成：${path}`, '2026-07-22T06:00:00Z'),
  ], '维护者')

  assert.deepEqual(result.map((item) => item.path), [path])
})
