// 复现「agent 正在跑时手机打字被吞」：spawn kimi → 提交一个最小任务 → 处理期间键入 marker →
// 任务结束后读 screen，看 marker 是否还在输入框。用法: node scripts/test-kimi-busy-input.mjs [baseUrl]
import WebSocket from 'ws'

const base = process.argv[2] || 'http://127.0.0.1:8790'
const wsBase = base.replace(/^http/, 'ws')
const marker = 'BUSYMARK'

const spawn = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'kimi', name: `e2e-kimi-busy` }),
}).then((r) => r.json())
const sessionId = (spawn.data ?? spawn).id
console.log('spawned kimi session', sessionId)

const ws = new WebSocket(`${wsBase}/ws`)
let screenText = ''
ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 80, rows: 24 })))
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw))
    if (msg.type === 'output' && msg.sessionId === sessionId) screenText += msg.data
  } catch {}
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const screen = async () => {
  const r = await fetch(`${base}/api/sessions/${sessionId}/screen`).then((x) => x.json())
  return ((r.data ?? r).lines ?? []).join('\n')
}

const cleanup = async (code) => {
  try {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: '' })) // ctrl-u
  } catch {}
  await sleep(400)
  await fetch(`${base}/api/sessions/${sessionId}/kill`, { method: 'POST' }).catch(() => {})
  process.exit(code)
}

await sleep(20000) // 等 TUI 首屏

// 用「终端逐键输入」的方式提交一个最小任务（非 sendline，模拟手机打字）
ws.send(JSON.stringify({ type: 'input', sessionId, data: '只回复两个字:收到' }))
await sleep(800)
ws.send(JSON.stringify({ type: 'input', sessionId, data: '\r' }))

// 处理期间键入 marker（分多次，模拟连续打字）
await sleep(2500)
for (const ch of marker) {
  ws.send(JSON.stringify({ type: 'input', sessionId, data: ch }))
  await sleep(120)
}

// 等任务跑完（轮询 screen 出现「收到」或超时 90s）
let done = false
for (let i = 0; i < 30; i++) {
  await sleep(3000)
  const t = await screen()
  if (t.includes('收到')) {
    done = true
    break
  }
}
console.log('任务完成:', done)
await sleep(5000) // 给 TUI 时间把缓冲的输入画出来

const tail = await screen()
const hit = tail.includes(marker)
console.log('--- 屏幕尾部 ---')
console.log(tail.split('\n').slice(-8).join('\n'))
console.log('---------------')
console.log(hit ? 'PASS: 处理期间键入的字符保留在输入框' : 'FAIL: 处理期间键入的字符被吞')
await cleanup(hit ? 0 : 1)
