#!/usr/bin/env node
// api-error-continue.mjs — 一键识别 API Error 卡住的 claude 系会话并自动注入 continue
// （2026-07-26 高律师点名建设：微信里对 Hermes 说「续跑」即触发本脚本，Hermes 白名单直干。）
//
// 只做一件事：running 的 claude 系会话，尾屏停在「API Error…」且已回到空闲输入框
// （非 Retrying、非工作中、非权限框、输入框无未发送文字）→ 注入字面量 "continue" + 回车。
//
// 通道说明（为什么走 WS input 而不是 room / sendline）：
// - room 投递只覆盖项目内成员，卡住的多是游离会话；
// - WS sendline 会走首句命名（"continue" 过 isNameWorthy 门槛，占位名会话会被改名）并虚增
//   promptCount，故用底层 input（"continue\r"，服务端 write() 自动拆帧 300ms 延迟回车）；
// - 不 attach：gateway 只对 attached 连接做控制者 resize，不 attach = 不碰任何人的终端尺寸。
// 本脚本是「agent 不得绕道 WS 直写终端」硬闸的**特许例外**（areco SKILL.md 同步注记）：
// 载荷固定为 "continue"，目标由屏幕状态机判定，每次动作追加审计 JSONL——可审计，非自由注入。
//
// 用法：
//   node scripts/api-error-continue.mjs               扫描全部 → 注入 → 验证 → 紧凑报告
//   node scripts/api-error-continue.mjs --dry-run     只识别不注入
//   node scripts/api-error-continue.mjs --session <id前缀> [--force]
//                                                     只处理指定会话；--force 跳过 API Error
//                                                     匹配要求（仍拒绝工作中/权限框/未发送文字）
//   node scripts/api-error-continue.mjs --json        机器可读输出
//   node scripts/api-error-continue.mjs --self-test   识别状态机纯函数自测（不联网）
// 冷却：同一会话 10 分钟内不重复注入（--cooldown-min 调，--force 忽略）；24h 超 6 次标记需人工。

import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ARECO_BASE || 'http://127.0.0.1:8790'
// 路径自锚定（同 lens：expanduser/HOME 在隔离 HOME agent 下会漂移，一律从脚本位置推导）
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const STATE_FILE = path.join(ROOT, 'data', 'api-error-continue.state.json')
const AUDIT_LOG = path.join(ROOT, 'data', 'logs', 'api-error-continue.jsonl')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (f, dflt) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const DRY = has('--dry-run')
const JSON_OUT = has('--json')
const FORCE = has('--force')
const ONLY = opt('--session', null)
const COOLDOWN_MS = Number(opt('--cooldown-min', '10')) * 60_000
const MAX_PER_DAY = 6

// ---- 识别状态机（纯函数，--self-test 可测）----------------------------------

const RE_ERROR = /API Error/
const RE_BUSY = /esc to interrupt/i
const RE_RETRYING = /Retrying in \d+|attempt \d+\/\d+/i
// 与 shared/traffic.ts PENDING_CHOICE_RE 同口径：权限框/信任页永不注入
const RE_DIALOG = /do you want to|don'?t ask again|do you trust the files/i
// 错误行之后只允许出现的「界面家具」：空行/框线/空输入符/状态栏
const RE_CHROME_BOX = /^[\s─│╭╮╰╯┌┐└┘├┤═║]*$/
const RE_CHROME_STATUS =
  /bypass permissions|shift\+tab|context (used|left)|\? for shortcuts|ctrl\+|for agents|auto-accept|plan mode/i
const RE_PROMPT_EMPTY = /^\s*│?\s*❯\s*│?\s*$/
const RE_PROMPT_TYPED = /^\s*│?\s*❯\s+\S/
// claude 界面尾注：「✻ Cogitated for 24m」「✻ Worked for …」「※ recap: …」（busy 分支已先行排除转轮态）
const RE_CHROME_TRAILER = /^\s*[✻✽✶✳※·]\s?/

/**
 * 尾屏 16 行 → 判定。verdict:
 *  stalled       API Error 且已停在空闲输入框 → 该注入
 *  busy          正在工作（esc to interrupt 可见）
 *  retrying      claude 自动重试倒计时中，等它自愈
 *  dialog        停在权限/信任框，注入会误触选项
 *  pending-input 输入框里有人打了字没发，不覆盖
 *  stale         错误行之后已有新的实质内容 = 已被处理过
 *  clean         无 API Error
 */
export function classifyScreen(lines) {
  const text = lines.join('\n')
  if (RE_BUSY.test(text)) return { verdict: 'busy' }
  if (RE_DIALOG.test(text)) return { verdict: 'dialog' }
  if (!RE_ERROR.test(text)) return { verdict: 'clean' }
  if (RE_RETRYING.test(text)) return { verdict: 'retrying' }
  let errIdx = -1
  for (let i = 0; i < lines.length; i++) if (RE_ERROR.test(lines[i])) errIdx = i
  const errorLine = lines[errIdx].trim().slice(0, 120)
  // 错误正文（长 JSON）会折行渲染：错误行之后、首个空行之前的缩进续行都算错误块本体
  let inErrBlock = true
  for (let i = errIdx + 1; i < lines.length; i++) {
    const ln = lines[i]
    if (!ln.trim()) {
      inErrBlock = false
      continue
    }
    // 顺序要紧：边框式空输入框「│ ❯   │」尾部的 │ 会被 \S 误认成打了字，先认空再认有字
    if (RE_PROMPT_EMPTY.test(ln) || RE_CHROME_BOX.test(ln) || RE_CHROME_STATUS.test(ln) || RE_CHROME_TRAILER.test(ln)) {
      inErrBlock = false
      continue
    }
    if (RE_PROMPT_TYPED.test(ln)) return { verdict: 'pending-input', errorLine }
    if (inErrBlock && /^\s+\S/.test(ln) && !/^\s*⏺/.test(ln)) continue
    return { verdict: 'stale', errorLine }
  }
  return { verdict: 'stalled', errorLine }
}

// ---- 自测 ------------------------------------------------------------------

function selfTest() {
  const box = '──────────────'
  const status = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
  const cases = [
    ['stalled', ['⏺ doing stuff', '  ⎿  API Error: 500 {"type":"error"}', '', box, '❯ ', box, status]],
    ['stalled', ['  API Error (Request timed out.)', '', box, '│ ❯          │', box, status]],
    ['busy', ['  ⎿  API Error: 529 overloaded', '✻ Cogitating… (esc to interrupt)']],
    ['retrying', ['  ⎿  API Error (500) · Retrying in 8 seconds… (attempt 3/10)', box, '❯ ', box]],
    ['dialog', ['  API Error: x', 'Do you want to proceed?', '❯ 1. Yes']],
    ['pending-input', ['  API Error: 500', box, '❯ 帮我看看这个', box, status]],
    ['stale', ['  API Error: 500', '⏺ 已恢复，继续处理下一项', box, '❯ ', box]],
    ['clean', ['⏺ 一切正常', box, '❯ ', box, status]],
    // 状态栏含 "100% context used" 尾巴不挡识别
    ['stalled', ['  ⎿  API Error: Connection error.', box, '❯ ', box, status + '   100% context used']],
    // 真实现场（2026-07-26 freemodel 403）：长 JSON 折行 + ✻ 计时尾注 + ※ recap
    ['stalled', [
      '⏺ Please run /login · API Error: 403 {"type":"https://…/error-1000/","title":"Err',
      '  IP","status":403,"detail":"The domain\'s DNS records point to a prohibited IP address, creating a conflict within Cloudflare\'s ',
      '  system.","instance":"a21238863e27dbc0","error_code":1000,"error_name":"dns_loop"}',
      '',
      '✻ Worked for 20m 10s',
      '',
      '※ recap: 时间轴拖动功能已上线… (disable recaps in /config)',
      '',
      box, '❯ ', box, status,
    ]],
    // 错误后已有新的 ⏺ 消息 = 已恢复过，别再注入
    ['stale', [
      '⏺ API Error: 403 {"type":"x"}',
      '  wrapped tail"}',
      '',
      '⏺ 已重连成功，继续执行任务',
      '',
      box, '❯ ', box, status,
    ]],
  ]
  let fail = 0
  for (const [want, lines] of cases) {
    const got = classifyScreen(lines).verdict
    if (got !== want) {
      fail++
      console.error(`FAIL want=${want} got=${got} :: ${lines[0]}`)
    }
  }
  console.log(fail === 0 ? `self-test PASS (${cases.length} cases)` : `self-test ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

// ---- areco API -------------------------------------------------------------

async function api(p) {
  const r = await fetch(`${BASE}/api${p}`)
  const j = await r.json()
  if (!j.ok) throw new Error(`${p}: ${j.error?.message || 'api error'}`)
  return j.data
}

const isClaudeFamily = (s) => Boolean(s.claudeSessionId) || /^(claude|c5)$/.test(s.templateId)

async function screenOf(id) {
  return (await api(`/sessions/${id}/screen`)).lines
}

// ---- 注入（WS input，不 attach）---------------------------------------------

function sendContinue(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`)
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* noop */ }
      reject(new Error('ws timeout'))
    }, 8000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'input', sessionId, data: 'continue\r' }))
      // write() 服务端拆帧：文本即写、\r 延迟 300ms。等 700ms 保证两段都已写入 pty 再断开。
      setTimeout(() => {
        clearTimeout(timer)
        try { ws.close() } catch { /* noop */ }
        resolve()
      }, 700)
    })
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.type === 'error' && (!m.sessionId || m.sessionId === sessionId)) {
          clearTimeout(timer)
          try { ws.close() } catch { /* noop */ }
          reject(new Error(`${m.code}: ${m.message}`))
        }
      } catch { /* 非 JSON 帧忽略 */ }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 注入后回看：busy 出现 = 已恢复运行；屏幕仍原样 stalled = 未生效 */
async function verifyResumed(id) {
  for (const wait of [1500, 3000, 4000]) {
    await sleep(wait)
    try {
      const v = classifyScreen(await screenOf(id)).verdict
      if (v === 'busy') return 'resumed'
      if (v !== 'stalled') return 'screen-changed'
    } catch {
      return 'verify-failed'
    }
  }
  return 'still-stalled'
}

// ---- 冷却与审计 -------------------------------------------------------------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch { return {} }
}
function saveState(st) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1))
}
function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true })
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* 审计失败不阻断主流程 */ }
}

// ---- 主流程 -----------------------------------------------------------------

async function main() {
  if (has('--self-test')) selfTest()
  const state = loadState()
  const now = Date.now()
  const all = await api('/sessions')
  let targets = all.filter((s) => s.status === 'running' && !s.archived && isClaudeFamily(s))
  if (ONLY) {
    targets = targets.filter((s) => s.id.startsWith(ONLY))
    if (targets.length !== 1) {
      console.error(`--session ${ONLY} 匹配到 ${targets.length} 个运行中 claude 系会话，须唯一`)
      process.exit(2)
    }
  } else if (FORCE) {
    console.error('--force 必须配合 --session 使用（拒绝全量强注）')
    process.exit(2)
  }

  const results = []
  for (const s of targets) {
    const short = s.id.slice(0, 8)
    const name = s.name.slice(0, 24)
    let cls
    try {
      cls = classifyScreen(await screenOf(s.id))
    } catch (err) {
      results.push({ id: short, name, action: 'skip', why: `读屏失败 ${err.message}` })
      continue
    }
    if (cls.verdict !== 'stalled' && !FORCE) {
      if (cls.verdict !== 'clean' && cls.verdict !== 'busy') {
        results.push({ id: short, name, action: 'skip', why: cls.verdict, errorLine: cls.errorLine })
      }
      continue
    }
    if (FORCE && (cls.verdict === 'busy' || cls.verdict === 'dialog' || cls.verdict === 'pending-input')) {
      results.push({ id: short, name, action: 'skip', why: `${cls.verdict}（--force 也不注入）` })
      continue
    }
    const st = state[s.id] || { times: [] }
    st.times = (st.times || []).filter((t) => now - t < 86_400_000)
    if (!FORCE && st.times.length && now - st.times[st.times.length - 1] < COOLDOWN_MS) {
      results.push({ id: short, name, action: 'skip', why: '冷却期内（10 分钟）' })
      continue
    }
    if (!FORCE && st.times.length >= MAX_PER_DAY) {
      results.push({ id: short, name, action: 'skip', why: `24h 已注入 ${st.times.length} 次，反复报错需人工` })
      audit({ sessionId: s.id, name: s.name, action: 'give-up', errorLine: cls.errorLine })
      continue
    }
    if (DRY) {
      results.push({ id: short, name, action: 'would-send', errorLine: cls.errorLine })
      continue
    }
    try {
      await sendContinue(s.id)
      st.times.push(now)
      state[s.id] = st
      const verdict = await verifyResumed(s.id)
      results.push({ id: short, name, action: 'sent', verify: verdict, errorLine: cls.errorLine })
      audit({ sessionId: s.id, name: s.name, action: 'sent', verify: verdict, errorLine: cls.errorLine, forced: FORCE })
    } catch (err) {
      results.push({ id: short, name, action: 'send-failed', why: err.message })
      audit({ sessionId: s.id, name: s.name, action: 'send-failed', error: err.message })
    }
  }
  if (!DRY) saveState(state)

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned: targets.length, results }, null, 1))
    return
  }
  // 紧凑报告（微信可直接转述；Hermes 历史会反复回放，克制输出）
  const sent = results.filter((r) => r.action === 'sent' || r.action === 'would-send')
  const skipped = results.filter((r) => r.action === 'skip')
  const failed = results.filter((r) => r.action === 'send-failed')
  console.log(`扫描 ${targets.length} 个运行中 claude 系会话${DRY ? '（dry-run）' : ''}`)
  if (!results.length) {
    console.log('未发现 API Error 卡住的会话')
    return
  }
  const vmap = { resumed: '已恢复运行', 'screen-changed': '屏幕已变化', 'still-stalled': '⚠️ 注入后仍卡着', 'verify-failed': '验证读屏失败' }
  for (const r of sent)
    console.log(`${DRY ? '🔎 识别到' : '✅ 已注入 continue'} ${r.id} ${r.name}${r.verify ? ` → ${vmap[r.verify] || r.verify}` : ''}\n   ${r.errorLine || ''}`)
  for (const r of skipped) console.log(`⏭️ 跳过 ${r.id} ${r.name}：${r.why}`)
  for (const r of failed) console.log(`❌ 注入失败 ${r.id} ${r.name}：${r.why}`)
}

// 仅直接执行时才跑主流程：被 import（复用 classifyScreen / 未来测试）不得触发注入
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(`api-error-continue 执行失败: ${err.message}`)
    process.exit(1)
  })
}
