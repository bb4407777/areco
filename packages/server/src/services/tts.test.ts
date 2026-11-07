import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { TtsService } from './tts'

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port }
}

function fakeBrowserResponse(): ServerResponse {
  return Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse
}

test('TtsService 流式代理固定 PCM', async () => {
  const expected = Buffer.from([0, 0, 1, 0, 255, 127])
  const { server, port } = await listen(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    assert.equal(JSON.parse(body).text, '正文')
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.write(expected.subarray(0, 3))
    res.end(expected.subarray(3))
  })
  try {
    const service = new TtsService({ port, startSidecar: false })
    const stream = await service.synthesize('正文', new EventEmitter() as IncomingMessage, fakeBrowserResponse())
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), expected)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('浏览器中止会取消上游合成请求', { timeout: 3000 }, async () => {
  let upstreamClosed!: Promise<void>
  let markClosed!: () => void
  let markStarted!: () => void
  const upstreamStarted = new Promise<void>((resolve) => { markStarted = resolve })
  upstreamClosed = new Promise<void>((resolve) => { markClosed = resolve })
  const { server, port } = await listen((req, res) => {
    markStarted()
    req.resume()
    req.on('aborted', markClosed)
    res.on('close', markClosed)
  })
  try {
    const service = new TtsService({ port, startSidecar: false })
    const browserRequest = new EventEmitter() as IncomingMessage
    const pending = service.synthesize('正文', browserRequest, fakeBrowserResponse())
    await upstreamStarted
    browserRequest.emit('aborted')
    const stream = await pending
    assert.equal((await stream.toArray()).length, 0)
    await Promise.race([
      upstreamClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('上游请求未取消')), 1000)),
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
