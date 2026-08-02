// GET/PUT /api/ui/prefs（对话模式显示开关，服务端为 SoT）的写入/校验/清除测试，
// 以及 loadConfig 对 ui 段的白名单拷贝测试。
//
// 必须在 import config.ts 之前把 ARECO_ROOT 指到临时目录（同 templates-crud.test.ts 的口径），
// 否则 updateUiPrefs 里的 saveConfig 会写**真的** config.json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-ui-prefs-'))
process.env.ARECO_ROOT = tmpRoot

const { ApiControllers } = await import('./api')
const { CONFIG_PATH, loadConfig } = await import('../config')

// 兜底断言：确认我们确实写在临时目录，而不是仓库里的 config.json
assert.ok(CONFIG_PATH.startsWith(tmpRoot), `CONFIG_PATH 没被 ARECO_ROOT 改到临时目录: ${CONFIG_PATH}`)

function newControllers() {
  // AppConfig 只有 ui/server.fileRoots 被这几个方法用到，其余字段给最小值即可
  const config = { server: { fileRoots: [], fileRootsUnrestricted: false }, templates: [] }
  const c = new ApiControllers(null as never, null as never, config as never, 'test')
  return { c, config: config as { ui?: Record<string, boolean> } }
}

/** 伪 Koa ctx：只实现 guard/ok/fail 触及的字段 */
function fakeCtx(body?: unknown) {
  return { status: 200, body: undefined as unknown, request: { body } } as never
}

test('GET 未配置 ui 时返回 {}', () => {
  const { c } = newControllers()
  const ctx = fakeCtx()
  c.getUiPrefs(ctx)
  assert.deepEqual((ctx as { body: { ok: boolean; data: unknown } }).body, { ok: true, data: {} })
})

test('PUT 合法布尔写回 config 并落盘，GET 能读回', () => {
  const { c, config } = newControllers()
  const ctx = fakeCtx({ showThinking: true, showToolUse: false })
  c.updateUiPrefs(ctx)
  assert.deepEqual((ctx as { body: { data: unknown } }).body.data, { showThinking: true, showToolUse: false })
  assert.deepEqual(config.ui, { showThinking: true, showToolUse: false })
  // 落盘的 config.json 也得有（不能只是内存对象对）
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { ui?: unknown }
  assert.deepEqual(onDisk.ui, { showThinking: true, showToolUse: false })

  const getCtx = fakeCtx()
  c.getUiPrefs(getCtx)
  assert.deepEqual((getCtx as { body: { data: unknown } }).body.data, { showThinking: true, showToolUse: false })
})

test('PUT 空 body / 无可更新字段 → 400', () => {
  const { c } = newControllers()
  const ctx = fakeCtx({ unrelated: true })
  c.updateUiPrefs(ctx)
  const res = ctx as { status: number; body: { ok: boolean; error: { code: string } } }
  assert.equal(res.status, 400)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'bad_request')
})

test('PUT 非布尔值 → 400 且不落盘', () => {
  const { c, config } = newControllers()
  const ctx = fakeCtx({ showThinking: 'yes' })
  c.updateUiPrefs(ctx)
  const res = ctx as { status: number; body: { ok: boolean } }
  assert.equal(res.status, 400)
  assert.equal(res.body.ok, false)
  assert.equal(config.ui, undefined)
})

test('PUT null = 清除该键；全部清除后不留空 ui 对象', () => {
  const { c, config } = newControllers()
  c.updateUiPrefs(fakeCtx({ showThinking: true, showToolResult: true }))
  assert.deepEqual(config.ui, { showThinking: true, showToolResult: true })

  c.updateUiPrefs(fakeCtx({ showThinking: null }))
  assert.deepEqual(config.ui, { showToolResult: true })

  const ctx = fakeCtx({ showToolResult: null })
  c.updateUiPrefs(ctx)
  assert.equal(config.ui, undefined, '全部键清除后不应留空对象')
  assert.deepEqual((ctx as { body: { data: unknown } }).body.data, {})
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
  assert.equal('ui' in onDisk, false, 'config.json 不应留空 ui 段')
})

test('loadConfig 白名单拷贝：只收三个开关、只留布尔值', () => {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      server: { host: '127.0.0.1', passwordHash: 'x' },
      ui: { showThinking: true, showToolUse: 'yes', showToolResult: 1, hacker: true },
    }),
    'utf8'
  )
  const config = loadConfig()
  assert.deepEqual(config.ui, { showThinking: true })
})

test('loadConfig：ui 段全部无效键时不留空对象', () => {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ server: { host: '127.0.0.1', passwordHash: 'x' }, ui: { hacker: true } }),
    'utf8'
  )
  const config = loadConfig()
  assert.equal(config.ui, undefined)
})
