// 复现手机端场景：spawn kimi 会话 → WS attach → 发几个字符(不回车) → 读 screen 断言字符进了输入框。
// 用法: node scripts/test-kimi-input.mjs [baseUrl]
import WebSocket from 'ws'

const base = process.argv[2] || 'http://127.0.0.1:8790'
const wsBase = base.replace(/^http/, 'ws')
const marker = 'E2EMARK'

const spawn = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'kimi', name: `e2e-kimi-input` }),
}).then((r) => r.json())
const sessionId = (spawn.data ?? spawn).id
console.log('spawned kimi session', sessionId)

const cleanup = async (code) => {
  // 清掉输入框残留再杀会话
  try {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: '' })) // ctrl-u 清行
  } catch {}
  await new Promise((r) => setTimeout(r, 500))
  await fetch(`${base}/api/sessions/${sessionId}/kill`, { method: 'POST' }).catch(() => {})
  process.exit(code)
}

const ws = new WebSocket(`${wsBase}/ws`)
ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 80, rows: 24 })))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等 TUI 就绪（首屏出现输入框），粗暴等 20s
await sleep(20000)

ws.send(JSON.stringify({ type: 'input', sessionId, data: marker }))
await sleep(3000)

const screen = await fetch(`${base}/api/sessions/${sessionId}/screen`).then((r) => r.json())
const lines = (screen.data ?? screen).lines ?? []
const hit = lines.some((l) => l.includes(marker))
console.log('screen tail:', JSON.stringify(lines.slice(-6), null, 1))
console.log(hit ? 'PASS: 字符到达 kimi 输入框' : 'FAIL: 字符未出现在屏幕尾部')
await cleanup(hit ? 0 : 1)
