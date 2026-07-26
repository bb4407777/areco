// TemplateStore 增改的字段往返测试。
//
// 为什么单独一个文件：必须在 import config.ts 之前把 ARECO_ROOT 指到临时目录，否则
// TemplateStore.create/update 里的 saveConfig 会写**真的** config.json。
// templates.test.ts 顶部是静态 import，来不及设环境变量，故另起一个文件用动态 import。
//
// 守的是什么（2026-07-26 修）：create() 与 update() 原先只拷 id/name/command/args/cwd/
// color/autoStart/enabled/claudeHome，把 harness/model/preset/transcriptDir **静默丢掉**。
// 后果：create() 上面刚用 `!command && !harness` 放行了 harness 模板，转头丢掉 harness，
// 落库成 command:"" 且无 harness → buildSpawnSpec 拼出 `exec ''`，会话起来即死且日志无线索；
// 设置页刚补的模板表单（a95b40d）也因此存不上这三个字段，改了等于没改。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-tpl-crud-'))
process.env.ARECO_ROOT = tmpRoot

const { TemplateStore } = await import('./templates')
const { CONFIG_PATH } = await import('../config')

// 兜底断言：确认我们确实写在临时目录，而不是仓库里的 config.json
assert.ok(CONFIG_PATH.startsWith(tmpRoot), `CONFIG_PATH 没被 ARECO_ROOT 改到临时目录: ${CONFIG_PATH}`)

function newStore() {
  // AppConfig 只有 templates 被这几个方法用到，其余字段给最小值即可
  return new TemplateStore({ templates: [] } as never)
}

test('create 保留 harness/model/preset/transcriptDir', () => {
  const store = newStore()
  const created = store.create({
    id: 'stand-thinker',
    name: 'Thinker',
    command: '',
    args: [],
    harness: 'workbuddy',
    model: 'deepseek-v4-pro',
    preset: 'thinker',
    transcriptDir: '/tmp/tr',
  } as never)
  assert.equal(created.harness, 'workbuddy')
  assert.equal(created.model, 'deepseek-v4-pro')
  assert.equal(created.preset, 'thinker')
  assert.equal(created.transcriptDir, '/tmp/tr')
  // 落库的也得有（不能只是返回值对）
  assert.equal(store.get('stand-thinker')?.harness, 'workbuddy')
})

test('create 的 harness 模板不会退化成空 command 且无 harness', () => {
  const store = newStore()
  const t = store.create({ id: 'h1', name: 'H', command: '', args: [], harness: 'reasonix' } as never)
  // 这正是 `exec ''` 死会话的成因：command 空是允许的，但 harness 必须在
  assert.equal(t.command, '')
  assert.ok(t.harness, 'harness 被丢了 → buildSpawnSpec 会拼出 exec 空串')
})

test('update 能改这四个字段', () => {
  const store = newStore()
  store.create({ id: 't', name: 'T', command: '', args: [], harness: 'workbuddy', model: 'a' } as never)
  const updated = store.update('t', { harness: 'reasonix', model: 'b', preset: 'worker' } as never)
  assert.equal(updated.harness, 'reasonix')
  assert.equal(updated.model, 'b')
  assert.equal(updated.preset, 'worker')
})

test('update 传空串 = 清除该字段（与 claudeHome 同语义）', () => {
  const store = newStore()
  store.create({ id: 't2', name: 'T2', command: 'claude', args: [], model: 'a', preset: 'worker' } as never)
  const updated = store.update('t2', { model: '', preset: '' } as never)
  assert.equal(updated.model, undefined)
  assert.equal(updated.preset, undefined)
})

test('update 不传则保持原值', () => {
  const store = newStore()
  store.create({ id: 't3', name: 'T3', command: '', args: [], harness: 'workbuddy', preset: 'thinker' } as never)
  const updated = store.update('t3', { name: '改个名' } as never)
  assert.equal(updated.harness, 'workbuddy')
  assert.equal(updated.preset, 'thinker')
  assert.equal(updated.name, '改个名')
})
