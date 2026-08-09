// onceQuiet 死代码修复 A/B 实测（2026-07-30 P0-1，跑完即删）
// 新码 = ./session（已修）；旧码 = ./session-old-ab（改前备份副本）。
// 三场景真 PTY 冷 spawn，量 spawn→onceQuiet fire 耗时：
//   S1 零输出会话（qclaw-stand 空闲形态）——旧码死等 maxWaitMs=30s，新码应 ≈MIN_BOOT 8s
//   S2 OSC-only spinner（codex 空转形态）——旧码首 chunk 缴械后 30s，新码应 ≈8s
//   S3 真输出 10s 后静默——验证 quiet 重置无回归，应 ≈11.2s（10+1.2），既非 8 也非 30
import { createRequire } from 'node:module'
// session.ts 经 ESM 加载会撞上 @xterm/headless（UMD 包）无具名导出的限制，走 CJS require 绕过（同 session.test.ts）
const req = createRequire(import.meta.url)
const { Session: NewSession } = req('./session.ts') as typeof import('./session')
const { Session: OldSession } = req('./session-old-ab.ts') as typeof import('./session')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function measure(Sess: typeof NewSession, label: string, args: string[]): Promise<number> {
  const s = new Sess({
    id: `ab-${label}-${Math.random().toString(36).slice(2, 8)}`,
    name: `ab-${label}`,
    templateId: 'ab-test',
    command: '/bin/bash',
    args,
    cwd: '/tmp',
    color: '#888888',
    claudeSessionId: null,
  })
  const t0 = Date.now()
  s.spawnProcess({ file: '/bin/bash', args, cwd: '/tmp', env: process.env })
  await sleep(1000) // 模拟 relay tick：spawn 后 ~1s 才注册 onceQuiet（与生产时序一致）
  const fired = new Promise<number>((resolve) => s.onceQuiet(() => resolve(Date.now() - t0)))
  const ms = await Promise.race([fired, sleep(45_000).then(() => -1)])
  s.kill()
  return ms as number
}

const SILENT = ['-c', 'sleep 300']
const OSC_SPIN = ['-c', 'while true; do printf "\\033]0;spin\\007"; sleep 0.1; done']
const REAL_OUT = ['-c', 'for i in $(seq 1 33); do echo line$i; sleep 0.3; done; sleep 300']

const [n1, n2, n3, o1, o2] = await Promise.all([
  measure(NewSession, 'new-silent', SILENT),
  measure(NewSession, 'new-osc', OSC_SPIN),
  measure(NewSession, 'new-realout', REAL_OUT),
  measure(OldSession, 'old-silent', SILENT),
  measure(OldSession, 'old-osc', OSC_SPIN),
])

console.log('\n===== A/B 结果（spawn→注入 fire，ms）=====')
console.log(`S1 零输出:      旧 ${o1}  →  新 ${n1}   （旧≈30s 死等，新≈8s MIN_BOOT 下限）`)
console.log(`S2 OSC spinner: 旧 ${o2}  →  新 ${n2}   （同上）`)
console.log(`S3 真输出10s:            新 ${n3}   （≈11.2s = 输出停+1.2s quiet，重置逻辑无回归）`)

const ok =
  o1 >= 29_000 && o2 >= 29_000 && // 旧码确实死等 30s
  n1 >= 7_500 && n1 <= 10_500 && // 新码贴着 8s MIN_BOOT
  n2 >= 7_500 && n2 <= 10_500 &&
  n3 >= 10_500 && n3 <= 14_000 // 真输出仍重置 quiet，不早火
console.log(ok ? '\nP0-1 A/B 实测全过 ✓' : '\n✗ 有场景不达预期，看上面数字')
process.exit(ok ? 0 : 1)
