// 端到端自检（二值闸门）：对运行中的服务跑完整协议链路。
// 用法: node scripts/selftest.mjs [base] [password]
//   base 默认 http://127.0.0.1:8790；有密码的服务必须传 password。
import { WebSocket } from 'ws'

const BASE = process.argv[2] || 'http://127.0.0.1:8790'
const PASSWORD = process.argv[3] || ''
const WS_BASE = BASE.replace(/^http/, 'ws')

let cookie = ''
let passCount = 0
let failCount = 0

function report(name, ok, detail = '') {
  if (ok) {
    passCount++
    console.log(`  ✔ ${name}`)
  } else {
    failCount++
    console.log(`  ✘ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

async function req(method, path, { body, headers = {}, form, redirect = 'manual' } = {}) {
  const init = { method, redirect, headers: { ...headers } }
  if (cookie) init.headers.cookie = cookie
  if (form) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded'
    init.body = new URLSearchParams(form).toString()
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return fetch(BASE + path, init)
}

function wsConnect(headers = {}) {
  return new WebSocket(`${WS_BASE}/ws`, { headers: { ...(cookie ? { cookie } : {}), ...headers } })
}

/** 收集 ws 消息直到谓词满足或超时 */
function waitFor(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error('等待超时'))
    }, timeoutMs)
    const onMsg = (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

async function main() {
  console.log(`自检目标: ${BASE}`)

  // 1. healthz
  {
    const res = await req('GET', '/healthz')
    report('healthz 200', res.status === 200)
  }

  // 2. 登录（若配置了密码）
  if (PASSWORD) {
    const bad = await req('POST', '/login', { form: { password: PASSWORD + '-wrong', next: '/' } })
    report('错误密码 401', bad.status === 401)
    const good = await req('POST', '/login', { form: { password: PASSWORD, next: '/' } })
    const setCookie = good.headers.get('set-cookie') || ''
    cookie = setCookie.split(';')[0]
    report('正确密码 303 + cookie', good.status === 303 && cookie.includes('areco_session='))
    const unauth = await fetch(BASE + '/api/sessions')
    report('无 cookie 访问 API 401', unauth.status === 401)
  }

  // 3. Host 伪造必须被拒（DNS rebinding 防线）。fetch/undici 禁改 host 头，用原始 http 请求
  {
    const { request } = await import('node:http')
    const url = new URL(BASE)
    const status = await new Promise((resolve) => {
      const r = request(
        { host: url.hostname, port: url.port, path: '/api/sessions', headers: { host: 'evil.example', ...(cookie ? { cookie } : {}) } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        }
      )
      r.on('error', () => resolve(0))
      r.end()
    })
    report('Host: evil.example → 403', status === 403, `实际 ${status}`)
  }

  // 4. 伪 Origin 的 WS 升级必须被拒
  {
    const ws = wsConnect({ origin: 'http://evil.example' })
    const rejected = await new Promise((resolve) => {
      ws.on('open', () => resolve(false))
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => resolve(true))
      setTimeout(() => resolve(true), 3000)
    })
    report('伪 Origin WS 拒绝', rejected)
    try {
      ws.terminate()
    } catch {}
  }

  // 5. REST：模板列表
  {
    const res = await req('GET', '/api/templates')
    const json = await res.json()
    report('GET /api/templates', res.status === 200 && json.ok && Array.isArray(json.data))
  }

  // 6. spawn shell 会话
  let sessionId = ''
  {
    const res = await req('POST', '/api/sessions', { body: { templateId: 'shell', name: 'selftest-shell' } })
    const json = await res.json()
    sessionId = json?.data?.id || ''
    report('spawn shell 会话', res.status === 200 && json.ok && json.data.status === 'running' && !!json.data.pid, JSON.stringify(json))
  }
  if (!sessionId) throw new Error('无会话可测，中止')

  // 6.5 transcript 端点：shell 会话无结构化 transcript，尾页路径必须干净返回 exists:false
  {
    const t = await req('GET', `/api/sessions/${sessionId}/transcript`)
    const tj = await t.json()
    report('shell 会话 transcript → exists:false', t.status === 200 && tj.ok && tj.data.exists === false, JSON.stringify(tj).slice(0, 120))
  }

  // 7. WS 主链路：init → attach → snapshot → input → output（含 offset 单调）→ ack → 二次 attach 快照含历史
  {
    const ws = wsConnect()
    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    const init = await waitFor(ws, (m) => m.type === 'init')
    report('init（协议版本/会话表）', init.protocolVersion === 1 && Array.isArray(init.sessions))

    ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 100, rows: 30 }))
    const snap = await waitFor(ws, (m) => m.type === 'snapshot' && m.sessionId === sessionId)
    report('attach → snapshot（带 offset）', typeof snap.offset === 'number' && snap.live === true)

    // 输出 offset 单调 + 内容回显
    let lastOffset = snap.offset
    let monotonic = true
    let buffer = ''
    ws.on('message', (raw) => {
      let m
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.type === 'output' && m.sessionId === sessionId) {
        if (m.offset <= lastOffset) monotonic = false
        lastOffset = m.offset
        buffer += m.data
        ws.send(JSON.stringify({ type: 'ack', sessionId, offset: m.offset }))
      }
    })
    const MARKER = 'AR_SELFTEST_7391'
    ws.send(JSON.stringify({ type: 'input', sessionId, data: `echo ${MARKER}\r` }))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    report('input → output 回显', buffer.includes(MARKER))
    report('output offset 单调递增', monotonic)

    // resize 不报错（无 error 帧）
    ws.send(JSON.stringify({ type: 'resize', sessionId, cols: 90, rows: 28 }))

    // 二次 attach：快照应包含 marker（影子终端状态）
    ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 90, rows: 28 }))
    const snap2 = await waitFor(ws, (m) => m.type === 'snapshot' && m.sessionId === sessionId)
    report('重连快照含历史输出（影子终端）', snap2.data.includes(MARKER))

    // sendline exit → 会话退出事件
    ws.send(JSON.stringify({ type: 'sendline', sessionId, text: 'exit' }))
    const exited = await waitFor(ws, (m) => m.type === 'sessionUpdate' && m.session.id === sessionId && m.session.status === 'exited', 8000)
    report('sendline exit → exited（reason=exit）', exited.session.exitReason === 'exit')

    // exited 会话 attach → 落盘/影子快照可回看
    ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 90, rows: 28 }))
    const snap3 = await waitFor(ws, (m) => m.type === 'snapshot' && m.sessionId === sessionId)
    report('exited 会话可回看快照', snap3.live === false && snap3.data.includes(MARKER))

    ws.close()
  }

  // 8. REST 收尾：归档/恢复 + 删除；运行中会话删除/归档必须 409
  {
    const res = await req('DELETE', `/api/sessions/${sessionId}`)
    const json = await res.json()
    report('删除 exited 会话', res.status === 200 && json.ok)

    const res2 = await req('POST', '/api/sessions', { body: { templateId: 'shell', name: 'selftest-del-guard' } })
    const json2 = await res2.json()
    const id2 = json2?.data?.id
    const res3 = await req('DELETE', `/api/sessions/${id2}`)
    report('运行中会话删除 → 409', res3.status === 409)
    const resArcLive = await req('POST', `/api/sessions/${id2}/archive`)
    report('运行中会话归档 → 409', resArcLive.status === 409)
    await req('POST', `/api/sessions/${id2}/kill`)
    await new Promise((resolve) => setTimeout(resolve, 800))

    const resArc = await req('POST', `/api/sessions/${id2}/archive`)
    const arcJson = await resArc.json()
    report('归档 exited 会话（archived=true）', resArc.status === 200 && arcJson.ok && arcJson.data.archived === true)
    const listJson = await (await req('GET', '/api/sessions')).json()
    const inList = (listJson?.data ?? []).find((s) => s.id === id2)
    report('归档后仍在会话表（元数据保留）', Boolean(inList) && inList.archived === true)
    const resUnarc = await req('POST', `/api/sessions/${id2}/unarchive`)
    const unarcJson = await resUnarc.json()
    report('取消归档（archived=false）', resUnarc.status === 200 && unarcJson.ok && unarcJson.data.archived === false)

    const res4 = await req('DELETE', `/api/sessions/${id2}`)
    report('kill 后删除成功', res4.status === 200)
  }

  // 9. 历史对话浏览
  {
    const res = await req('GET', '/api/history?limit=5')
    const json = await res.json()
    const okShape = res.status === 200 && json.ok && Array.isArray(json.data.entries) && typeof json.data.total === 'number'
    report('GET /api/history 列表', okShape, JSON.stringify(json).slice(0, 200))

    const first = json?.data?.entries?.[0]
    if (first) {
      const t = await req('GET', `/api/history/${first.source}/${first.project}/${first.id}/transcript`)
      const tj = await t.json()
      report(
        '历史正文（尾页）',
        t.status === 200 && tj.ok && Array.isArray(tj.data.messages) && typeof tj.data.start === 'number',
        JSON.stringify(tj).slice(0, 200)
      )
      if (tj?.ok && tj.data.hasMore) {
        const t2 = await req('GET', `/api/history/${first.source}/${first.project}/${first.id}/transcript?before=${tj.data.start}`)
        const tj2 = await t2.json()
        report('历史正文向前翻页', t2.status === 200 && tj2.ok && tj2.data.end <= tj.data.start)
      } else {
        report('历史正文向前翻页（单页会话，视为通过）', true)
      }
    } else {
      report('历史正文（本机无历史数据，跳过）', true)
      report('历史正文向前翻页（跳过）', true)
    }

    const evil = await req('GET', '/api/history/claude/..%2F..%2Fetc/passwd/transcript')
    report('历史路径穿越 → 4xx', evil.status >= 400 && evil.status < 500, `实际 ${evil.status}`)

    // chatlog 统一层（codex/reasonix/…）：本机有 chatlog 数据时应能列出并读正文
    let chatlogEntry = null
    for (let offset = 0; offset <= 800 && !chatlogEntry; offset += 100) {
      const p = await (await req('GET', `/api/history?limit=100&offset=${offset}`)).json()
      if (!p.ok) break
      chatlogEntry = p.data.entries.find((e) => ['codex', 'reasonix', 'cc-connect', 'workbuddy'].includes(e.source)) ?? null
      if (!p.data.hasMore) break
    }
    if (chatlogEntry) {
      const t = await req('GET', `/api/history/${chatlogEntry.source}/${chatlogEntry.project}/${chatlogEntry.id}/transcript`)
      const tj = await t.json()
      report(
        `chatlog 源正文（${chatlogEntry.source}）`,
        t.status === 200 && tj.ok && Array.isArray(tj.data.messages) && tj.data.messages.length > 0,
        JSON.stringify(tj).slice(0, 160)
      )
    } else {
      report('chatlog 源正文（本机无 chatlog 数据，跳过）', true)
    }
  }

  console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main().catch((err) => {
  console.error('自检异常中止:', err.message)
  process.exit(1)
})
