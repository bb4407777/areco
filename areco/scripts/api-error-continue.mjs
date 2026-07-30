#!/usr/bin/env node
// api-error-continue.mjs — 一键识别 API Error 卡住的 claude 系会话并自动注入 continue
// （2026-07-26 高律师点名建设：微信里对 Hermes 说「续跑」即触发本脚本，Hermes 白名单直干。）
//
// 两类停摆，两种固定载荷（2026-07-26 高律师定）：
// 1. 尾屏停在错误上（API Error/Connection error/超时/Please run \/login/限流/网络
//    错误码等，见 RE_ERROR）且已回到空闲输入框（非 Retrying、非工作中、输入框无
//    未发送文字）→ 注入字面量 "continue" + 回车。
// 2. 停在权限/信任确认框 → 只注入回车（Enter 选默认项，通常是 Yes；不发任何文字，
//    高律师 2026-07-26「权限确认栏也帮我 enter」）。连环框靠逐分钟一跳清完；
//    Enter 清不掉的框才走 8 分钟 dialog-stuck 告警。
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
//   node scripts/api-error-continue.mjs --patrol      巡检模式（cc-connect cron 每 30 秒跑，2026-07-27 高律师定）：
//                                                     报错停摆即注 continue（冷却 25s）；确认框自动
//                                                     Enter 选默认项（静默，Enter 清不掉超 8 分钟才告警）；
//                                                     ✻ Cogitated/Worked/Waiting 秒数不变 ≥90s 视同卡死；
//                                                     同一报错片段持续 ≥1 分钟 → `freemodel-key next
//                                                     --probe` 切 key×节点组合（探活选通 + 余额>0，运行中
//                                                     会话吃得到新配置），切完立刻再注 continue；仍不救 →
//                                                     每 1 分钟再跳一个组合，全局每小时最多 6 跳；
//                                                     所有 key 余额为 0 → 停切换，查最早刷新时间后再轮换
//                                                     （等待期 continue 也停，省 give-up 预算）；
//                                                     片段注满 15 次 give-up 通知人工。
//                                                     微信只报「切换/救不活/卡确认框/余额耗尽/进程 error」。
//   node scripts/api-error-continue.mjs --dry-run     只识别不注入
//   node scripts/api-error-continue.mjs --session <id前缀> [--force]
//                                                     只处理指定会话；--force 跳过 API Error
//                                                     匹配要求（仍拒绝工作中/权限框/未发送文字）
//   node scripts/api-error-continue.mjs --json        机器可读输出
//   node scripts/api-error-continue.mjs --self-test   识别状态机+片段跟踪纯函数自测（不联网）
//   --no-send（配 --patrol 调试：通知只打印不发微信） --test-notify（发一条通道测试消息）
//   --no-switch（配 --patrol 调试：升级判定照走但不真切 key）
// 冷却：手动模式同一会话 10 分钟内不重复注入（--cooldown-min 调，--force 忽略）。

import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
const PATROL = has('--patrol')
const NO_SEND = has('--no-send')
const NO_SWITCH = has('--no-switch')
const ONLY = opt('--session', null)
// 巡检 30 秒一跑（cron 每分钟两趟）：冷却 25s 保证每 tick 仍卡就再注；手动模式维持 10 分钟防连点
const COOLDOWN_MS = Number(opt('--cooldown-min', PATROL ? '0.42' : '10')) * 60_000
// 卡在权限/信任框连续可见超此时长才告警（瞬时确认框不打扰）
const DIALOG_PERSIST_MS = 8 * 60_000
// 故障片段（episode）参数：同一会话连续 API Error 的一段
export const ESCALATE_AFTER_MS = Number(opt('--escalate-min', '1')) * 60_000 // 卡满 1 分钟即升级切 key/节点（2026-07-27 高律师定）
const SWITCH_MIN_GAP_MS = 60_000 // 两次切换全局最小间隔（高律师定「切完至少等 1 分钟」再切下一个，防连环空转）
const SWITCH_MAX_PER_HOUR = 6 // 组合环才 6 个组合，1 小时兜一圈还没好就该人上了
export const EP_MAX_INJECTIONS = 15 // 单片段 continue 上限，超过 give-up（防给死会话灌一夜 continue）
export const EP_STALE_MS = 10 * 60_000 // 10 分钟没再看到错误 = 片段结束（人已救活/在忙别的）
const FREEMODEL_KEY_BIN = '/Users/gao/skills/freemodel/scripts/freemodel-key'
// 微信通知走 cc-connect 出站（与 deadline-patrol 同口径：显式会话键，裸 -m 会依赖活跃指针静默失败）
const CC_SEND = '/Users/gao/scripts/cc-send.sh'
const WEIXIN_SESSION = 'weixin:dm:o9cq802pfYrkgul79flJor4d7uQs@im.wechat'
const LOCK_FILE = path.join(ROOT, 'data', 'api-error-continue.lock')

// ---- 识别状态机（纯函数，--self-test 可测）----------------------------------

// 卡死错误不止「API Error」一种字样（2026-07-26 高律师定：类型很多，统一按同一套处理）：
// 连接错/超时/登录失效/限流/网络错误码等都算。误报防线不在词表在形态学——必须是
// 「错误行之后直到空闲输入框再无实质内容」才判 stalled，聊天内容里出现这些词不会中招。
const RE_ERROR =
  /API Error|Connection error|Request timed out|fetch failed|Please run \/login|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|overloaded|rate.?limit|usage limit|Internal server error|Bad Gateway|Service Unavailable|Gateway Timeout|Server Error|HTTP 5\d\d/i
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
// claude 界面尾注：「✻ Cogitated for 24m」「✻ Worked for …」「※ recap: …」（busy 分支已先行排除转轮态）；
// ◯/○ 是后台任务/workflow 状态栏（「◯ skills-bug-sweep 21/88 agents done」），也是家具——
// 2026-07-27 实战漏判：该行被当实质内容致 Connection closed 停摆误判 stale
const RE_CHROME_TRAILER = /^\s*[✻✽✶✳※·◯○◎]\s?/
// 冻结尾注检测（2026-07-27 高律师截图定）：✻ Cogitated/Worked for X 秒数不变 = 卡死。
// 只认过去时已完成计时（Cogitated/Worked for Xm Ys）——秒数不动说明已完成在那干等；
// 「Waiting for N dynamic workflow」是等后台 workflow（属 busy，进度在 ◯ 行），不算卡死，
// 否则会往正在跑的 workflow 会话里误注 continue 打断它（2026-07-27 实战 80527f8e/4f0dda53）。
const FROZEN_TRAILER_MS = 90_000
const RE_TRAILER_TIME = /[✻✽✶✳]\s?(Cogitated|Worked)\s+for\s+\d+/
// 后台任务状态栏：「◯ skills-bug-sweep 27/88 agents done」——有此线说明 workflow 在跑=忙，不判冻死
const RE_BACKGROUND_TASK = /^\s*◯\s+.*agents?\s+/i
function extractTrailer(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RE_TRAILER_TIME.test(lines[i])) return lines[i].trim()
  }
  return null
}

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
  // Retrying 必须先于 clean：502 Bad Gateway 等网关错 Claude 会自动重试，尾屏「Retrying in Xs /
  // attempt N/10」本身就是卡错信号——不能因错误词表没覆盖到（如"502 Bad G…"被截断）就判 clean 漏掉
  // （2026-07-27 全 Fable5 卡 502 实战，fb2832c5 attempt 7/10 被漏判 clean）。
  if (RE_RETRYING.test(text)) return { verdict: 'retrying' }
  if (!RE_ERROR.test(text)) return { verdict: 'clean' }
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

// ---- 故障片段跟踪（纯函数，--self-test 可测）---------------------------------
//
// episode = 同一会话一段连续的 API Error 故障：
//   { firstTs, lastErrTs, injections, lastEscalateTs?, gaveUp? }
// stalled/retrying 都算「错误还在」；clean/stale 立即收段；其余（busy/dialog/
// pending-input）保持现段——busy 多半是我们注入的 continue 在重试，未必已痊愈。

export function updateEpisode(st, verdict, now, staleMs = EP_STALE_MS) {
  if (verdict === 'stalled' || verdict === 'retrying') {
    if (!st.ep || now - st.ep.lastErrTs > staleMs) st.ep = { firstTs: now, lastErrTs: now, injections: 0 }
    else st.ep.lastErrTs = now
  } else if (verdict === 'clean' || verdict === 'stale') {
    delete st.ep
  } else if (st.ep && now - st.ep.lastErrTs > staleMs) {
    delete st.ep
  }
  return st.ep
}

/** 该片段现在是否轮到升级切 key/节点（不含全局闸，全局闸在主流程里统一算） */
export function episodeWantsSwitch(ep, now, afterMs = ESCALATE_AFTER_MS) {
  if (!ep || ep.gaveUp) return false
  if (now - ep.firstTs < afterMs) return false
  if (ep.lastEscalateTs && now - ep.lastEscalateTs < afterMs) return false
  return true
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
    // 卡死类型不止 API Error 字样（2026-07-26 高律师定统一处理）
    ['stalled', ['  ⎿  Connection error.', '', box, '❯ ', box, status]],
    ['stalled', ['  ⎿  Request timed out.', box, '❯ ', box, status]],
    ['stalled', ['  ⎿  fetch failed', '', box, '❯ ', box, status]],
    ['stalled', ['⏺ Please run /login', '', box, '❯ ', box, status]],
    ['stalled', ['  ⎿  rate_limit_error: requests per minute exceeded', '', box, '❯ ', box, status]],
    ['stalled', ['  ⎿  TypeError: fetch failed · cause: connect ECONNREFUSED 127.0.0.1:443', '', box, '❯ ', box, status]],
    // 这些词出现在聊天内容里、后面已有实质输出 = 不是卡死
    ['stale', ['⏺ 日志里有一行 Connection error 需要排查', '⏺ 我先看下网络配置', box, '❯ ', box, status]],
    ['busy', ['  ⎿  Connection error.', '✻ Reconnecting… (esc to interrupt)']],
    // 真实现场（2026-07-27 80527f8e）：Connection closed 折行 + ✻ Waiting 尾注 +
    // ◯ 后台任务状态栏——◯ 行是家具不是新内容，曾因此误判 stale 漏救
    ['stalled', [
      '',
      '⏺ API Error: Connection closed',
      '  mid-response. The response above may',
      '  be incomplete.',
      '',
      '✻ Waiting for 1 dynamic workflow to finish',
      '',
      box, '❯ ', box,
      '  ⏵⏵ bypass permissions on (shift+tab to  ·',
      '                            100% context used',
      '',
      '  ◯ skills-bug-sweep 21/88 agents done · 1',
    ]],
    // 502/网关错实战（2026-07-27 全 Fable5 卡）：Claude 自动重试 UI，必须判 retrying 不能 clean
    ['retrying', ['✻ 502 Bad G… · Retrying in 15s · attempt 7/10', box, '❯ ', box, status]],
    ['retrying', ['✻ 503 Service Unavailable · Retrying in 0s · attempt 5/10', box, '❯ ', box]],
    // 网关错已不重试、停在空闲框 = stalled（RE_ERROR 补了 Bad Gateway / Gateway Timeout 等）
    ['stalled', ['  ⎿  502 Bad Gateway', '', box, '❯ ', box, status]],
    ['stalled', ['  ⎿  504 Gateway Timeout', '', box, '❯ ', box, status]],
  ]
  let fail = 0
  for (const [want, lines] of cases) {
    const got = classifyScreen(lines).verdict
    if (got !== want) {
      fail++
      console.error(`FAIL want=${want} got=${got} :: ${lines[0]}`)
    }
  }

  // 片段跟踪：时间轴推演（分钟 → 毫秒）
  const M = 60_000
  const epCases = []
  const check = (name, cond) => epCases.push([name, cond])
  {
    const st = {}
    updateEpisode(st, 'stalled', 0)
    check('开段', st.ep && st.ep.firstTs === 0)
    check('未满1分钟不切', !episodeWantsSwitch(st.ep, 30_000))
    updateEpisode(st, 'busy', 60_000)
    check('busy 保段', Boolean(st.ep))
    updateEpisode(st, 'stalled', 2 * M)
    check('续段不重开', st.ep.firstTs === 0)
    check('满1分钟该切', episodeWantsSwitch(st.ep, 2 * M))
    st.ep.lastEscalateTs = 2 * M
    check('刚切过1分钟内不再切', !episodeWantsSwitch(st.ep, 2 * M + 30_000))
    check('切后又满1分钟再切', episodeWantsSwitch(st.ep, 3 * M + 30_000))
    updateEpisode(st, 'stale', 4 * M)
    check('stale 收段', !st.ep)
  }
  {
    const st = {}
    updateEpisode(st, 'retrying', 0)
    check('retrying 也开段', Boolean(st.ep))
    updateEpisode(st, 'busy', 5 * M)
    check('busy 中未过期保段', Boolean(st.ep))
    updateEpisode(st, 'busy', 11 * M)
    check('10分钟无错自动收段', !st.ep)
    updateEpisode(st, 'stalled', 12 * M)
    check('新故障重新开段', st.ep && st.ep.firstTs === 12 * M)
    st.ep.gaveUp = true
    check('give-up 后不再切', !episodeWantsSwitch(st.ep, 30 * M))
  }
  // 冻结尾注提取：Cogitated/Worked 已完成计时算卡死信号；Waiting-for-workflow 不算（busy 不打断）
  const trCases = []
  const trCheck = (name, cond) => trCases.push([name, cond])
  trCheck('Cogitated 计时尾注被提取', extractTrailer(['✻ Cogitated for 2m 38s']) !== null)
  trCheck('Worked 计时尾注被提取', extractTrailer(['✻ Worked for 20m 10s']) !== null)
  trCheck('Waiting-for-workflow 不被提取(避免误判busy)', extractTrailer(['✻ Waiting for 1 dynamic workflow to finish']) === null)
  for (const [name, cond] of trCases) {
    if (!cond) {
      fail++
      console.error(`FAIL trailer :: ${name}`)
    }
  }
  console.log(fail === 0 ? `self-test PASS (${cases.length + epCases.length + trCases.length} cases)` : `self-test ${fail} FAIL`)
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

function sendKeys(sessionId, data) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`)
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* noop */ }
      reject(new Error('ws timeout'))
    }, 8000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'input', sessionId, data }))
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

// 载荷白名单只有这两个：错误停摆 → "continue"+回车；确认框 → 裸回车（选默认项）
const sendContinue = (sessionId) => sendKeys(sessionId, 'continue\r')
const sendEnter = (sessionId) => sendKeys(sessionId, '\r')

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

/** 单实例锁：巡检 1 分钟一跑，运行重叠/与手动并发时防对同一会话双发 continue。陈锁（>2min）视为死进程接管 */
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
      process.on('exit', () => {
        try { fs.unlinkSync(LOCK_FILE) } catch { /* noop */ }
      })
      return true
    } catch {
      try {
        const prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'))
        if (Date.now() - prev.ts < 120_000) return false
        fs.unlinkSync(LOCK_FILE)
      } catch {
        try { fs.unlinkSync(LOCK_FILE) } catch { return false }
      }
    }
  }
  return false
}

/** 升级动作：freemodel-key next --probe 切到第一个探活成功且有余额的 key×节点组合。
 *  exit 0=已切；3=全组合探活失败；4=所有 key 余额为0（停切换等刷新，输出含 wait-until-unix）；其余=脚本故障。 */
function runKeySwitch() {
  if (NO_SWITCH) return { code: 0, out: '[no-switch] 调试模式，未真切', dry: true }
  const r = spawnSync(FREEMODEL_KEY_BIN, ['next', '--probe'], {
    env: { ...process.env, HOME: '/Users/gao' },
    timeout: 180_000,
    encoding: 'utf-8',
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  return { code: r.status, out }
}

/** 解析 freemodel-key 的 all-depleted 行：`wait-until-unix <s> wait-until-local <label>` */
function parseWaitUntil(out) {
  const m = out.match(/wait-until-unix\s+(\d+)\s+wait-until-local\s+(.+)/)
  return m ? { unix: Number(m[1]), local: m[2].trim() } : { unix: null, local: null }
}

/** 从 freemodel-key 输出提炼一句话（切到哪个组合 / 探活情况） */
function summarizeSwitch(out) {
  const wrote = out.split('\n').find((l) => l.startsWith('wrote config for'))
  const probes = out.split('\n').filter((l) => l.startsWith('probe ')).map((l) => l.replace(/^probe /, ''))
  if (wrote) {
    const m = wrote.match(/wrote config for (\S+).*node=(\S+)/)
    const combo = m ? `${m[1]}×${m[2].replace(/^https?:\/\//, '')}` : wrote
    return `已切到 ${combo}${probes.length ? `（探活：${probes.join('；')}）` : ''}`
  }
  return probes.length ? `未切换（探活：${probes.join('；')}）` : out.slice(0, 200)
}

/** 推微信（返回是否成功）。--no-send 时只打印，便于调试巡检文案 */
function notifyWeixin(text) {
  if (NO_SEND) {
    console.log(`[no-send] ${text}`)
    return true
  }
  const r = spawnSync(CC_SEND, ['-s', WEIXIN_SESSION, '-m', text], {
    env: { ...process.env, HOME: '/Users/gao' },
    timeout: 120_000,
    encoding: 'utf-8',
  })
  const ok = r.status === 0
  audit({ action: 'notify', ok, text: text.slice(0, 300), err: ok ? undefined : String(r.stderr || r.stdout || r.error || '').slice(0, 200) })
  return ok
}

// ---- 主流程 -----------------------------------------------------------------

async function main() {
  if (has('--self-test')) selfTest()
  if (has('--test-notify')) {
    notifyWeixin('🩺 areco 会话巡检通道测试：每 30 秒体检 claude 系会话，报错卡死/冻结尾注自动 continue、确认框自动 Enter；持续 1 分钟自动切 FreeModel key×节点（探活选通）再续，异常才提醒。')
    return
  }
  if (PATROL && (DRY || FORCE || ONLY)) {
    console.error('--patrol 不与 --dry-run/--force/--session 组合')
    process.exit(2)
  }
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
  if (!DRY && !acquireLock()) {
    console.log('另一实例运行中（锁未过期），本次跳过')
    return
  }

  const results = []
  if (PATROL) {
    // 状态剪枝：会话已从看板删除的条目不再保留（_g 是全局切换台账，豁免）
    for (const key of Object.keys(state)) if (key !== '_g' && !all.some((s) => s.id === key)) delete state[key]
    // 进程 error 态（pty 级异常，非 API Error）：只通报不动手——生命周期操作归人
    for (const s of all) {
      if (!isClaudeFamily(s) || s.archived) continue
      const st = state[s.id]
      if (s.status === 'error') {
        if (!st?.errNotified) {
          ;(state[s.id] = st || { times: [] }).errNotified = true
          results.push({ id: s.id.slice(0, 8), name: s.name.slice(0, 24), action: 'crashed', why: '进程 error 态，需到看板处理' })
          audit({ sessionId: s.id, name: s.name, action: 'crashed' })
        }
      } else if (st?.errNotified) {
        delete st.errNotified
      }
    }
  }

  // ---- 第一遍：全量读屏普查（喂片段跟踪 + 定升级）----
  const scans = []
  for (const s of targets) {
    const short = s.id.slice(0, 8)
    const name = s.name.slice(0, 24)
    const st = state[s.id] || (state[s.id] = { times: [] })
    st.times = (st.times || []).filter((t) => now - t < 86_400_000)
    let cls
    let screenLines
    try {
      screenLines = await screenOf(s.id)
      cls = classifyScreen(screenLines)
    } catch (err) {
      results.push({ id: short, name, action: 'skip', why: `读屏失败 ${err.message}` })
      continue
    }
    // 冻结尾注检测：verdict=clean 但 ✻ Cogitated/Worked/Waiting for Xs 秒数不变 ≥90s = 卡死
    if (cls.verdict === 'clean') {
      const trailer = extractTrailer(screenLines)
      if (trailer) {
        if (!st.trailer || st.trailer.text !== trailer) {
          st.trailer = { text: trailer, firstTs: now }
        } else if (now - st.trailer.firstTs >= FROZEN_TRAILER_MS) {
          const hasEmptyPrompt = screenLines.some((l) => RE_PROMPT_EMPTY.test(l))
          const hasTypedPrompt = screenLines.some((l) => RE_PROMPT_TYPED.test(l))
          const hasBackgroundTask = screenLines.some((l) => RE_BACKGROUND_TASK.test(l))
          // 空输入框 + 无未发文字 + 无后台 workflow 在跑 → 才判冻死（有 ◯ 任务=在忙，别打断）
          if (hasEmptyPrompt && !hasTypedPrompt && !hasBackgroundTask) {
            cls = { verdict: 'stalled', errorLine: trailer + '（秒数不变，判定卡死）' }
          }
        }
      } else {
        delete st.trailer
      }
    } else {
      delete st.trailer
    }
    updateEpisode(st, cls.verdict, now)
    scans.push({ s, short, name, st, cls })
    // 巡检：确认框滞留跟踪——pass2 会自动 Enter，这里只记时长；连续可见超 DIALOG_PERSIST_MS
    // 说明 Enter 也清不掉（真需要人选的框），告警一次，消失即复位
    if (PATROL) {
      if (cls.verdict === 'dialog') {
        if (!st.dialog) {
          st.dialog = { firstTs: now, notified: false }
        } else if (!st.dialog.notified && now - st.dialog.firstTs >= DIALOG_PERSIST_MS) {
          st.dialog.notified = true
          results.push({ id: short, name, action: 'dialog-stuck', why: `卡在确认框 ${Math.round((now - st.dialog.firstTs) / 60000)} 分钟（自动 Enter ${st.dialog.enters || 0} 次未清）` })
          audit({ sessionId: s.id, name: s.name, action: 'dialog-stuck', enters: st.dialog.enters || 0 })
        }
      } else if (st.dialog) {
        delete st.dialog
      }
    }
  }

  // ---- 升级：故障片段卡满 1 分钟 → 切 key×节点组合（探活选通 + 余额>0），切完再注 continue ----
  if (PATROL && !DRY) {
    const g = state._g || (state._g = {})
    g.switchTimes = (g.switchTimes || []).filter((t) => now - t < 3600_000)

    // 余额耗尽等刷新（2026-07-27 高律师定：余额为0就停切换，查刷新时间后再轮换）
    if (g.waitUntil && now >= g.waitUntil) {
      delete g.waitUntil
      // 刷新后给活跃片段重置升级基线，避免拿旧 firstTs 立刻又触发
      for (const { st } of scans) if (st.ep) st.ep.lastEscalateTs = now
      results.push({ action: 'key-switch', why: 'FreeModel 余额已到刷新时间，恢复自动轮换' })
    }

    if (!g.waitUntil) {
      const wanting = scans.filter(
        ({ st, cls }) => (cls.verdict === 'stalled' || cls.verdict === 'retrying') && episodeWantsSwitch(st.ep, now)
      )
      if (wanting.length) {
        const gapOk = !g.lastSwitchTs || now - g.lastSwitchTs >= SWITCH_MIN_GAP_MS
        const capOk = g.switchTimes.length < SWITCH_MAX_PER_HOUR
        if (gapOk && capOk) {
          const names = wanting.map((w) => w.name)
          const sw = runKeySwitch()
          const summary = summarizeSwitch(sw.out)
          if (sw.code === 0) {
            g.lastSwitchTs = now
            g.switchTimes.push(now)
            // 一次切换是全局补救：所有活跃片段一并盖时间戳，别让多个卡死会话连环触发
            for (const { st } of scans) if (st.ep) st.ep.lastEscalateTs = now
            results.push({ action: 'key-switch', why: `报错持续≥${Math.round(ESCALATE_AFTER_MS / 60000)} 分钟（${names.join('、')}），${summary}，随即重注 continue` })
          } else if (sw.code === 4) {
            // 全部 key 余额为 0：解析刷新时间，设 waitUntil 停切换，到点自动恢复轮换
            const w = parseWaitUntil(sw.out)
            if (w.unix) {
              g.waitUntil = w.unix * 1000
              results.push({ action: 'switch-failed', why: `所有 FreeModel key 余额为 0，停自动切换，${w.local} 后恢复轮换` })
            } else {
              g.lastSwitchTs = now
              results.push({ action: 'switch-failed', why: `所有 key 余额为 0 但未解析出刷新时间：${sw.out.slice(0, 150)}` })
            }
          } else if (sw.code === 3) {
            g.lastSwitchTs = now
            results.push({ action: 'switch-failed', why: `报错持续但全部 key×节点组合探活失败，配置未动（疑似全面断网/上游故障）：${summary}` })
          } else {
            g.lastSwitchTs = now
            results.push({ action: 'switch-failed', why: `freemodel-key 执行失败(code=${sw.code})：${sw.out.slice(0, 200)}` })
          }
          audit({ action: 'key-switch', code: sw.code, sessions: names, out: sw.out.slice(0, 500) })
        } else if (!capOk && !g.capNotified) {
          g.capNotified = true
          results.push({ action: 'switch-failed', why: `1 小时内已切换 ${g.switchTimes.length} 次仍反复故障，停止自动切换，需人工` })
          audit({ action: 'switch-cap', switches: g.switchTimes.length })
        }
      } else {
        if (g.capNotified && g.switchTimes.length < SWITCH_MAX_PER_HOUR) delete g.capNotified
      }
    }
  }

  // ---- 第二遍：注入（巡检模式切换耗时较长，注前重新读屏防误注）----
  for (const scan of scans) {
    const { s, short, name, st } = scan
    let cls = scan.cls
    // 确认框：自动 Enter 选默认项（2026-07-26 高律师「权限确认栏也帮我 enter」）。
    // 连环框每 30 秒清一层；Enter 无效的框由普查段的 dialog-stuck 8 分钟告警兜底。
    if (cls.verdict === 'dialog') {
      if (DRY) {
        results.push({ id: short, name, action: 'would-enter' })
        continue
      }
      if (!FORCE && st.times.length && now - st.times[st.times.length - 1] < COOLDOWN_MS) {
        continue
      }
      if (PATROL) {
        // 普查到现在隔了一段，框可能已被人点掉，注前复核
        try {
          cls = classifyScreen(await screenOf(s.id))
        } catch {
          continue
        }
        if (cls.verdict !== 'dialog') continue
      }
      try {
        await sendEnter(s.id)
        st.times.push(now)
        if (st.dialog) st.dialog.enters = (st.dialog.enters || 0) + 1
        await sleep(1500)
        let after = 'verify-failed'
        try { after = classifyScreen(await screenOf(s.id)).verdict } catch { /* noop */ }
        results.push({ id: short, name, action: 'dialog-enter', verify: after })
        audit({ sessionId: s.id, name: s.name, action: 'dialog-enter', after })
      } catch (err) {
        results.push({ id: short, name, action: 'send-failed', why: `确认框 Enter 失败 ${err.message}` })
        audit({ sessionId: s.id, name: s.name, action: 'send-failed', error: err.message, kind: 'dialog-enter' })
      }
      continue
    }
    if (cls.verdict !== 'stalled' && !FORCE) {
      if (cls.verdict !== 'clean' && cls.verdict !== 'busy') {
        results.push({ id: short, name, action: 'skip', why: cls.verdict, errorLine: cls.errorLine })
      }
      continue
    }
    if (FORCE && (cls.verdict === 'busy' || cls.verdict === 'pending-input')) {
      results.push({ id: short, name, action: 'skip', why: `${cls.verdict}（--force 也不注入）` })
      continue
    }
    if (!FORCE && st.times.length && now - st.times[st.times.length - 1] < COOLDOWN_MS) {
      results.push({ id: short, name, action: 'skip', why: `冷却期内（${Math.round(COOLDOWN_MS / 1000)}s）` })
      continue
    }
    // 余额耗尽等待窗口：key 没钱，continue 也是失败——跳过省着 give-up 预算，等刷新后再用（dialog Enter 是 UI 操作仍照常）
    if (PATROL && state._g?.waitUntil && now < state._g.waitUntil) {
      continue
    }
    if (PATROL && st.ep && st.ep.injections >= EP_MAX_INJECTIONS) {
      if (!st.ep.gaveUp) {
        st.ep.gaveUp = true
        results.push({ id: short, name, action: 'give-up', why: `本轮故障已注入 ${st.ep.injections} 次仍卡死${st.ep.lastEscalateTs ? '（已切过 key/节点）' : ''}，停手待人工` })
        audit({ sessionId: s.id, name: s.name, action: 'give-up', injections: st.ep.injections, errorLine: cls.errorLine })
      }
      continue
    }
    if (DRY) {
      results.push({ id: short, name, action: 'would-send', errorLine: cls.errorLine })
      continue
    }
    if (PATROL) {
      // 普查到现在隔了读屏+可能的切换探活，屏幕可能已自行恢复，注前复核一次
      try {
        cls = classifyScreen(await screenOf(s.id))
      } catch {
        continue
      }
      if (cls.verdict !== 'stalled') continue
    }
    try {
      await sendContinue(s.id)
      st.times.push(now)
      if (st.ep) st.ep.injections += 1
      const verdict = await verifyResumed(s.id)
      results.push({ id: short, name, action: 'sent', verify: verdict, errorLine: cls.errorLine })
      audit({ sessionId: s.id, name: s.name, action: 'sent', verify: verdict, errorLine: cls.errorLine, forced: FORCE })
    } catch (err) {
      results.push({ id: short, name, action: 'send-failed', why: err.message })
      audit({ sessionId: s.id, name: s.name, action: 'send-failed', error: err.message })
    }
  }
  if (!DRY) saveState(state)

  if (PATROL) {
    const vmapW = { resumed: '已恢复运行', 'screen-changed': '已响应，观察中', 'still-stalled': '注入后仍卡着', 'verify-failed': '验证读屏失败' }
    const dmapW = { dialog: '仍有确认框（可能连环，下轮再清）', busy: '已继续工作', clean: '已清', stale: '已清' }
    const line = (r) =>
      r.action === 'sent' ? `✅ ${r.name}：报错停摆已注入 continue → ${vmapW[r.verify] || r.verify}`
      : r.action === 'dialog-enter' ? `⏎ ${r.name}：确认框已自动 Enter → ${dmapW[r.verify] || r.verify}`
      : r.action === 'send-failed' ? `❌ ${r.name}：注入失败（${r.why}）`
      : r.action === 'key-switch' ? `🔑 ${r.why}`
      : r.action === 'switch-failed' ? `🆘 ${r.why}`
      : r.action === 'give-up' ? `🆘 ${r.name}：${r.why}`
      : r.action === 'dialog-stuck' ? `⚠️ ${r.name}：${r.why}，请到看板处理`
      : `💥 ${r.name}：${r.why}`
    const logworthy = results.filter((r) => ['sent', 'dialog-enter', 'send-failed', 'key-switch', 'switch-failed', 'give-up', 'dialog-stuck', 'crashed'].includes(r.action))
    const stamp = new Date().toISOString()
    if (!logworthy.length) {
      console.log(`${stamp} 巡检 clean（${targets.length} 个 claude 系会话）`)
      return
    }
    console.log(`${stamp}\n${logworthy.map(line).join('\n')}`)
    // 成功续跑/自动 Enter 静默不报（高律师 2026-07-26「continue 其实不用汇报」，确认框同理）；
    // 注入后仍卡的也不单独吵，反复失败会走 give-up/dialog-stuck 聚合。只有需要人出手的才推微信。
    const alerts = logworthy.filter((r) => r.action !== 'sent' && r.action !== 'dialog-enter')
    if (alerts.length) {
      const text = ['🩺 areco 会话巡检', ...alerts.map(line)].join('\n')
      if (!notifyWeixin(text)) console.log('（微信通知发送失败，见审计日志）')
    }
    return
  }

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
    console.log('未发现卡住的会话（报错停摆/确认框）')
    return
  }
  const vmap = { resumed: '已恢复运行', 'screen-changed': '屏幕已变化', 'still-stalled': '⚠️ 注入后仍卡着', 'verify-failed': '验证读屏失败' }
  const dmap = { dialog: '仍有确认框（可能连环）', busy: '已继续工作', clean: '已清', stale: '已清' }
  for (const r of sent)
    console.log(`${DRY ? '🔎 识别到' : '✅ 已注入 continue'} ${r.id} ${r.name}${r.verify ? ` → ${vmap[r.verify] || r.verify}` : ''}\n   ${r.errorLine || ''}`)
  for (const r of results.filter((x) => x.action === 'dialog-enter' || x.action === 'would-enter'))
    console.log(`${r.action === 'would-enter' ? '🔎 识别到确认框' : '⏎ 确认框已自动 Enter'} ${r.id} ${r.name}${r.verify ? ` → ${dmap[r.verify] || r.verify}` : ''}`)
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
