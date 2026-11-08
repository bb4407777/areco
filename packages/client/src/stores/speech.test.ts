import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioBlockedError, EmptyAudioError, PcmCancelledError, type SpeechPlayer } from '../audio/pcmPlayer'
import { SpeechQueue } from './speech'

class FakePlayer implements SpeechPlayer {
  playCalls = 0
  stopCalls = 0
  blocked = false
  autoFinish = true
  private finish: (() => void) | null = null
  private fail: ((err: Error) => void) | null = null

  async unlock() {
    if (this.blocked) throw new AudioBlockedError()
  }

  async play(_stream: ReadableStream<Uint8Array>) {
    this.playCalls++
    if (this.autoFinish) return
    await new Promise<void>((resolve, reject) => {
      this.finish = resolve
      this.fail = reject
    })
  }

  stop() {
    this.stopCalls++
    const fail = this.fail
    this.finish = null
    this.fail = null
    fail?.(new PcmCancelledError())
  }

  complete() {
    this.finish?.()
    this.finish = null
    this.fail = null
  }
}

function fakeFetch(texts: string[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    texts.push(JSON.parse(String(init?.body)).text)
    return new Response(new Uint8Array([0, 0]))
  }) as typeof fetch
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('条件超时')
}

test('自动播报默认关闭，最终 messageId 只播一次，手动可重播', async () => {
  const player = new FakePlayer()
  const texts: string[] = []
  const queue = new SpeechQueue(player, fakeFetch(texts))
  const item = { messageId: 'm1', text: '最终正文' }
  assert.equal(queue.enqueueAuto(item), false)
  queue.setAutoEnabled(true)
  assert.equal(queue.enqueueAuto(item), true)
  assert.equal(queue.enqueueAuto(item), false)
  await waitFor(() => queue.hasPlayedAuto('m1'))
  assert.equal(queue.enqueueAuto(item), false)
  assert.deepEqual(texts, ['最终正文'])
  queue.playManual(item)
  await waitFor(() => texts.length === 2)
  assert.deepEqual(texts, ['最终正文', '最终正文'])
})

test('手动播放抢占当前自动项并清空自动队列', async () => {
  const player = new FakePlayer()
  player.autoFinish = false
  const texts: string[] = []
  const queue = new SpeechQueue(player, fakeFetch(texts))
  queue.setAutoEnabled(true)
  queue.enqueueAuto({ messageId: 'a1', text: '自动一' })
  await waitFor(() => texts.length === 1)
  queue.enqueueAuto({ messageId: 'a2', text: '自动二' })
  queue.playManual({ messageId: 'manual', text: '手动优先' })
  await waitFor(() => texts.length === 2)
  assert.deepEqual(texts, ['自动一', '手动优先'])
  player.complete()
  await waitFor(() => player.playCalls === 2)
  assert.equal(texts.includes('自动二'), false)
})

test('停止后迟到旧事件不推进已清队列', async () => {
  const player = new FakePlayer()
  player.autoFinish = false
  const texts: string[] = []
  const playing: (string | null)[] = []
  const queue = new SpeechQueue(player, fakeFetch(texts), { onPlaying: (id) => playing.push(id) })
  queue.setAutoEnabled(true)
  queue.enqueueAuto({ messageId: 'a1', text: '自动一' })
  await waitFor(() => texts.length === 1)
  queue.enqueueAuto({ messageId: 'a2', text: '自动二' })
  queue.stop()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(texts, ['自动一'])
  assert.equal(playing.at(-1), null)
  assert.equal(queue.hasPlayedAuto('a1'), false)
  assert.equal(queue.hasPlayedAuto('a2'), false)
})

test('浏览器阻止自动播放时不记为已播', async () => {
  const player = new FakePlayer()
  player.blocked = true
  const texts: string[] = []
  let blocked = false
  const queue = new SpeechQueue(player, fakeFetch(texts), { onBlocked: (value) => { blocked = value } })
  queue.setAutoEnabled(true)
  queue.enqueueAuto({ messageId: 'a1', text: '自动一' })
  await waitFor(() => blocked)
  assert.equal(queue.hasPlayedAuto('a1'), false)
  assert.deepEqual(texts, [])
  assert.equal(queue.enqueueAuto({ messageId: 'a1', text: '自动一' }), true)
})

test('默认 fetch 绑定 globalThis，避免浏览器 Illegal invocation', async () => {
  const originalFetch = globalThis.fetch
  const player = new FakePlayer()
  const texts: string[] = []
  let receiver: unknown
  globalThis.fetch = (async function (this: unknown, _input: string | URL | Request, init?: RequestInit) {
    receiver = this
    texts.push(JSON.parse(String(init?.body)).text)
    return new Response(new Uint8Array([0, 0]))
  }) as typeof fetch
  try {
    const queue = new SpeechQueue(player)
    queue.playManual({ messageId: 'manual', text: '绑定正文' })
    await waitFor(() => texts.length === 1)
    assert.equal(receiver, globalThis)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('长文本按句拆成多次请求，首句合成完即播', async () => {
  const player = new FakePlayer()
  const texts: string[] = []
  const queue = new SpeechQueue(player, fakeFetch(texts))
  queue.playManual({
    messageId: 'm1',
    text: '第一句很短。第二句也很短！第三句同样很短？',
  })
  await waitFor(() => player.playCalls === 3)
  assert.deepEqual(texts, ['第一句很短。', '第二句也很短！', '第三句同样很短？'])
})

test('播第一句时已预取后续句子（播放与合成并行）', async () => {
  const player = new FakePlayer()
  player.autoFinish = false
  const texts: string[] = []
  const queue = new SpeechQueue(player, fakeFetch(texts))
  queue.playManual({
    messageId: 'm1',
    text: '第一句很短。第二句也很短！第三句同样很短？',
  })
  // 第一句还在播，后面两句已经发出去合成了
  await waitFor(() => texts.length === 3)
  assert.equal(player.playCalls, 1)
  player.complete()
  await waitFor(() => player.playCalls === 2)
  player.complete()
  await waitFor(() => player.playCalls === 3)
})

test('播报中途停止时未消费的预取请求不产生未处理异常', async () => {
  const player = new FakePlayer()
  player.autoFinish = false
  const texts: string[] = []
  const failing: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    texts.push(JSON.parse(String(init?.body)).text)
    throw new Error('网络断开')
  }) as typeof fetch
  const queue = new SpeechQueue(player, failing)
  queue.playManual({ messageId: 'm1', text: '第一句很短。第二句也很短！' })
  await waitFor(() => texts.length === 2)
  queue.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(player.playCalls, 0)
  assert.equal(queue.hasPlayedAuto('m1'), false)
})

test('某一句没有音频时跳过，不算播报失败', async () => {
  const texts: string[] = []
  let errors: (string | null)[] = []
  let plays = 0
  const player = {
    async unlock() {},
    async play() {
      plays++
      if (plays === 2) throw new EmptyAudioError()
    },
    stop() {},
  }
  const queue = new SpeechQueue(player, fakeFetch(texts), { onError: (e) => errors.push(e) })
  queue.playManual({ messageId: 'm1', text: '第一句很短。第二句也很短！第三句同样很短？' })
  await waitFor(() => plays === 3)
  assert.equal(errors.filter((e) => e).length, 0)
  assert.equal(queue.hasPlayedAuto('m1'), false)
})
