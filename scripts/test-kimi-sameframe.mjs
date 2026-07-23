// 验证「文本+回车同帧到达」时 kimi 的行为：是否按粘贴处理（回车变换行不提交=用户以为被吞）。
// 用法: node scripts/test-kimi-sameframe.mjs [baseUrl]
import WebSocket from 'ws'

const base = process.argv[2] || 'http://127.0.0.1:8790'
const wsBase = base.replace(/^http/, 'ws')

const spawn = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'kimi', name: `e2e-kimi-frame` }),
}).then((r) => r.json())
const sessionId = (spawn.data ?? spawn).id
console.log('spawned kimi session', sessionId)

const ws = new WebSocket(`${wsBase}/ws`)
ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 80, rows: 24 })))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const screen = async () => {
  const r = await fetch(`${base}/api/sessions/${sessionId}/screen`).then((x) => x.json())
  return ((r.data ?? r).lines ?? []).join('\n')
}
const cleanup = async (code) => {
  try {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: '' })) // ctrl-c
    await sleep(300)
    ws.send(JSON.stringify({ type: 'input', sessionId, data: '' })) // ctrl-u
  } catch {}
  await sleep(400)
  await fetch(`${base}/api/sessions/${sessionId}/kill`, { method: 'POST' }).catch(() => {})
  process.exit(code)
}

await sleep(20000) // TUI 首屏

// 同帧：文本+回车塞在同一条 WS input 消息里（=同一 TCP 帧到达 pty）
ws.send(JSON.stringify({ type: 'input', sessionId, data: '只回复两个字:收到\r' }))

// 观察 30s：提交成功（屏幕出现「收到」回复）vs 被当粘贴/换行（输入框还在）
let submitted = false
for (let i = 0; i < 10; i++) {
  await sleep(3000)
  const t = await screen()
  if (t.includes('● 收到') || t.includes('收到\n')) {
    submitted = true
    break
  }
  // 输入框仍含未提交文本 → 说明回车没生效
  if (i >= 2 && t.includes('只回复两个字')) {
    // 再多等一轮确认不是正在跑
    if (i >= 5) break
  }
}
const tail = await screen()
console.log('--- 屏幕尾部 ---')
console.log(tail.split('\n').slice(-10).join('\n'))
console.log('---------------')
console.log(submitted ? 'PASS: 同帧文本+回车正常提交' : 'FAIL: 同帧文本+回车未提交（按粘贴/换行处理=丢字复现）')
await cleanup(submitted ? 0 : 1)
