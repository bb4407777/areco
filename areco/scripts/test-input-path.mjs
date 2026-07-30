// 端到端验证输入链路：HTTP spawn shell → WS attach → input 发字符 → 断言 pty 回显。
// 用法: node scripts/test-input-path.mjs [baseUrl]
import WebSocket from 'ws'

const base = process.argv[2] || 'http://127.0.0.1:8790'
const marker = `ARECO_E2E_${Date.now()}`
const wsBase = base.replace(/^http/, 'ws')

const spawn = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'shell', name: `e2e-${marker}` }),
}).then((r) => r.json())
if (!spawn.ok && !spawn.id) {
  console.error('spawn 失败:', JSON.stringify(spawn).slice(0, 300))
  process.exit(1)
}
const session = spawn.data ?? spawn
const sessionId = session.id
console.log('spawned session', sessionId)

let gotSnapshot = false
let echoed = false
let outputLen = 0

const ws = new WebSocket(`${wsBase}/ws`)
const cleanup = async (code) => {
  try {
    ws.close()
  } catch {}
  await fetch(`${base}/api/sessions/${sessionId}/kill`, { method: 'POST' }).catch(() => {})
  process.exit(code)
}

const timer = setTimeout(() => {
  console.error(`超时: snapshot=${gotSnapshot} echoed=${echoed} outputLen=${outputLen}`)
  void cleanup(2)
}, 15000)

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 80, rows: 24 }))
})
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.type === 'snapshot' && msg.sessionId === sessionId) {
    gotSnapshot = true
    // 快照到位后再发输入，模拟真实客户端
    ws.send(JSON.stringify({ type: 'input', sessionId, data: `echo ${marker}\r` }))
  }
  if (msg.type === 'output' && msg.sessionId === sessionId) {
    outputLen += msg.data.length
    if (msg.data.includes(marker)) {
      echoed = true
      clearTimeout(timer)
      console.log(`PASS: input 链路通畅（pty 回显了 marker）snapshot=${gotSnapshot} outputLen=${outputLen}`)
      void cleanup(0)
    }
  }
  if (msg.type === 'error') {
    console.error('server error msg:', msg)
  }
})
ws.on('error', (err) => {
  console.error('ws error:', err.message)
  void cleanup(3)
})
