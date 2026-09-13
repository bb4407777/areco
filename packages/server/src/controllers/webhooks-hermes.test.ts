// webhooks-hermes 单测（F2·台账#12 A2 验收三例）：验签通过落库（含关键事件升格）/
// 验签失败 401 不落库 / 同 delivery_id 幂等去重。临时 ARECO_ROOT，先于 import 设置（同 project-db.test.ts 口径）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import Koa from 'koa'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-hermes-wh-'))
process.env.ARECO_ROOT = root

const { createHermesWebhookMiddleware, HERMES_WEBHOOK_PATH } = await import('./webhooks-hermes')
const events = await import('../services/hermes-events')

const SECRET = 'test-secret-f2'
const escalated: Array<{ roomId: string; from: string; body: string }> = []

const app = new Koa()
app.use(
  createHermesWebhookMiddleware({
    getSecret: () => SECRET,
    relay: {
      postMessage: (roomId: string, from: string, body: string) => {
        escalated.push({ roomId, from, body })
      },
    },
    getObserverRoomId: () => 'room-test',
  })
)
const server = http.createServer(app.callback())
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const addr = server.address()
if (addr === null || typeof addr === 'string') throw new Error('测试服务未拿到端口')
const url = `http://127.0.0.1:${addr.port}${HERMES_WEBHOOK_PATH}`
after(() => server.close())

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// wire format 按 Hermes agent/outbound_webhooks.py:45-56（03-设计说明 §1.4）
function payload(deliveryId: string, event = 'on_session_end', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: event,
    tool_name: null,
    tool_input: null,
    session_id: 'sess_t1',
    cwd: '/tmp',
    extra,
    delivery_id: deliveryId,
    timestamp: '2026-08-08T05:00:00Z',
  })
}

async function post(body: string, sig?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Hermes-Agent-Outbound-Webhook',
      'x-hermes-event': 'on_session_end',
      'x-hermes-delivery': 'header-ignored-when-body-has-id',
      ...(sig ? { 'x-hermes-signature-256': sig } : {}),
    },
    body,
  })
}

test('验签通过：200 落库 1 行；api_request_error 属关键事件应升格一次', async () => {
  const body = payload('d-ok-1', 'api_request_error', { model: 'k3', status_code: 429, retryable: true, reason: 'rate_limit' })
  const res = await post(body, sign(body))
  assert.equal(res.status, 200)
  const j = (await res.json()) as { ok: boolean; stored: boolean }
  assert.equal(j.ok, true)
  assert.equal(j.stored, true)
  assert.equal(events.countEvents(), 1)
  assert.equal(escalated.length, 1)
  assert.equal(escalated[0].roomId, 'room-test')
  assert.equal(escalated[0].from, 'hermes-observer')
  assert.match(escalated[0].body, /api_request_error/)
  assert.match(escalated[0].body, /429/)
})

test('验签失败：401 且不落库（错 secret 与缺签名头两路）', async () => {
  const before = events.countEvents()
  const body = payload('d-bad-1')
  const wrong = await post(body, sign(body, 'wrong-secret'))
  assert.equal(wrong.status, 401)
  const missing = await post(body)
  assert.equal(missing.status, 401)
  assert.equal(events.countEvents(), before)
})

test('幂等去重：同 delivery_id 重发回 200 但库仍 1 行', async () => {
  const body = payload('d-dup-1')
  const first = await post(body, sign(body))
  assert.equal(first.status, 200)
  const n = events.countEvents()
  const again = await post(body, sign(body))
  assert.equal(again.status, 200)
  const j = (await again.json()) as { ok: boolean; stored: boolean; duplicate?: boolean }
  assert.equal(j.stored, false)
  assert.equal(j.duplicate, true)
  assert.equal(events.countEvents(), n, '重发不得产生第二行')
})
