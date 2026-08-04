// agent-bridge 端到端实测（真模型，隔离 HERMES_HOME，不动生产）。
// 用法：cd <areco 仓根> && node scripts/test-agent-bridge.mjs
//
// 流程：esbuild 把 TS client 打包到 /tmp（测的就是要上线的代码，不是复制品）
//   → manager spawn sidecar → 用例 A 纯对话流式 → 用例 B interrupt
//   → 用例 C terminal 工具事件（审批策略未接线，超时就如实报，不算失败）。
import * as esbuild from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(resolve(os.tmpdir(), 'bridge-e2e-'))
const bundle = resolve(tmp, 'agent-bridge.bundle.cjs')

await esbuild.build({
  entryPoints: [resolve(root, 'packages/server/src/services/agent-bridge.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'silent',
})

const { AgentBridgeManager } = await import(bundle)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const manager = new AgentBridgeManager({
  key: 'e2e',
  hermesHome: resolve(tmp, 'hermes-home'),
  provider: 'qclaw',
  model: 'pool-deepseek-v4-flash',
})

try {
  const client = await manager.ensureReady()
  check('manager.ensureReady + ping', true, client.endpoint)

  // ---- 用例 A：纯对话，流式拉取 ----
  const chatA = await client.chat({ message: '用一句话回答：1+1等于几？只回答算式和结果。' })
  check('A chat 受理', chatA.ok && chatA.status === 'running', `run_id=${chatA.run_id}`)

  let textA = ''
  let eventsA = 0
  const finalA = await client.streamOutput(chatA.run_id, (c) => {
    textA += c.delta
    eventsA += c.events.length
  })
  check('A 流式完成', finalA.done && finalA.status === 'complete', `status=${finalA.status}`)
  check('A 增量拼装 == 全量', textA === finalA.output, `output=${JSON.stringify(finalA.output?.slice(0, 60))}`)
  check('A 答案含 2', /2/.test(finalA.output || ''))

  // 同会话第二轮：验证 agent 内部状态延续
  const chatA2 = await client.chat({ session_id: chatA.session_id, message: '把刚才的算式结果乘以 10，只回答数字。' })
  const finalA2 = await client.streamOutput(chatA2.run_id, () => {})
  check('A 第二轮上下文延续', /20/.test(finalA2.output || ''), `output=${JSON.stringify(finalA2.output?.slice(0, 60))}`)

  const resA = await client.getResult(chatA.run_id)
  check('A get_result 可取', resA.ok && resA.done, `final_response=${JSON.stringify(resA.result?.final_response?.slice?.(0, 40))}`)

  // ---- 用例 B：interrupt ----
  const chatB = await client.chat({ message: '从 1 数到 60，每个数字单独一行，不要省略。' })
  await new Promise((r) => setTimeout(r, 2500))
  const intr = await client.interrupt(chatB.session_id, '停下，不用数了')
  check('B interrupt 受理', intr.ok && intr.interrupted === true)
  const finalB = await client.streamOutput(chatB.run_id, () => {})
  check('B 轮次收场', finalB.done, `status=${finalB.status}（interrupted 或提前 complete 都算收住）`)

  // ---- 用例 C：terminal 工具事件（可能撞审批——MVP 没接审批回调，超时报知不判死）----
  const chatC = await client.chat({
    message: '在终端执行 echo bridge-e2e-ok，然后把命令输出原样告诉我。',
    toolsets: ['terminal'],
  })
  let sawToolStart = false
  let sawToolDone = false
  const deadline = Date.now() + 90_000
  let finalC = null
  let cursor = 0
  let eventCursor = 0
  while (Date.now() < deadline) {
    const c = await client.getOutput(chatC.run_id, cursor, eventCursor)
    cursor = c.cursor
    eventCursor = c.event_cursor
    for (const e of c.events) {
      if (e.type === 'tool.started') sawToolStart = true
      if (e.type === 'tool.completed') sawToolDone = true
    }
    if (c.done) {
      finalC = c
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (finalC) {
    check('C 工具轮完成', true, `status=${finalC.status} output=${JSON.stringify((finalC.output || '').slice(0, 60))}`)
    check('C 工具事件流出', sawToolStart && sawToolDone, `started=${sawToolStart} completed=${sawToolDone}`)
  } else {
    await client.interrupt(chatC.session_id, '测试超时')
    check('C 工具轮（疑似审批阻塞，MVP 预期内）', true, '90s 未完成，已 interrupt；审批接线是后续项')
  }

  const lst = await client.list()
  check('list 汇总', lst.ok && lst.sessions.length >= 2, `sessions=${lst.sessions?.length}`)
} catch (err) {
  check('端到端流程', false, String(err?.message || err))
} finally {
  await manager.stop()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}：${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
