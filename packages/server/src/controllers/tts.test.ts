import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from 'koa'
import { MAX_TTS_TEXT_LENGTH, TtsController } from './tts'
import type { TtsService } from '../services/tts'

function fakeContext(text: unknown): Context {
  return {
    request: { body: { text } },
    req: {},
    res: {},
    set() {},
  } as unknown as Context
}

test('TTS 控制器拒绝空文本与超长文本', async () => {
  const controller = new TtsController({ synthesize: async () => { throw new Error('不应调用') } } as unknown as TtsService)
  const empty = fakeContext('  ')
  await controller.synthesize(empty)
  assert.equal(empty.status, 400)

  const long = fakeContext('x'.repeat(MAX_TTS_TEXT_LENGTH + 1))
  await controller.synthesize(long)
  assert.equal(long.status, 400)
})
