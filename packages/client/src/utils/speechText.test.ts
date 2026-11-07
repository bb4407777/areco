import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoomMessage, TranscriptMessage } from '../../../shared/protocol'
import { roomSpeechText, TranscriptSpeechTracker, transcriptSpeechId, transcriptSpeechText } from './speechText'

const assistant = (timestamp: string, text: string): TranscriptMessage => ({
  role: 'assistant',
  timestamp,
  parts: [
    { kind: 'thinking', text: '不读思考' },
    { kind: 'text', text },
    { kind: 'tool_result', text: '不读工具', isError: false },
    { kind: 'notice', text: '不读通知' },
  ],
})

test('只提取 Assistant 正式 text 段', () => {
  assert.equal(transcriptSpeechText(assistant('2026-11-07', '正式正文')), '正式正文')
  assert.equal(transcriptSpeechText({ role: 'user', timestamp: null, parts: [{ kind: 'text', text: '本人' }] }), '')
})

test('房间排除本人与 humanRelay', () => {
  const base: RoomMessage = { id: 1, roomId: 'r', from: 'Agent', to: 'all', body: '正文', createdAt: '2026-11-07' }
  assert.equal(roomSpeechText(base, 'Owner'), '正文')
  assert.equal(roomSpeechText({ ...base, from: 'Owner' }, 'Owner'), '')
  assert.equal(roomSpeechText({ ...base, humanRelay: true }, 'Owner'), '')
})

test('Transcript 首载不回放，完成后只交新增消息并去重', () => {
  const tracker = new TranscriptSpeechTracker()
  const old = assistant('2026-11-07T00:00:00Z', '旧消息')
  tracker.reset('s', [old])
  assert.deepEqual(tracker.complete('s', [old]), [])

  tracker.begin('s', [old])
  const final = assistant('2026-11-07T00:00:01Z', '新完成')
  assert.deepEqual(tracker.complete('s', [old, final]), [
    { messageId: transcriptSpeechId('s', final), text: '新完成' },
  ])
  assert.deepEqual(tracker.complete('s', [old, final]), [])
})

test('历史翻页只建立基线', () => {
  const tracker = new TranscriptSpeechTracker()
  tracker.reset('s', [])
  const historical = assistant('2026-11-06', '历史')
  tracker.addBaseline('s', [historical])
  assert.deepEqual(tracker.complete('s', [historical]), [])
})
