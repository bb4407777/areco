// StandCode 角色 → 模板解析单测：设置页 → registry.json 回落 → 第一个启用模板兜底 → 全空抛错。
// 注意：resolver 在模块加载时固化 STANDCODE_REGISTRY_PATH，必须先设 env 再动态 import
// （同 standcode-resolver.test.ts 的 STANDCODE_CONFIG_DIR 口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Template } from '../../../shared/protocol'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standcode-roles-'))
const REGISTRY_PATH = path.join(dir, 'registry.json')
process.env.STANDCODE_REGISTRY_PATH = REGISTRY_PATH

function writeRegistry(registry: unknown) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry))
}

const { resolveRoleTemplate } = await import('./standcode-resolver')

function tpl(id: string, patch: Partial<Template> = {}): Template {
  return {
    id, name: `模板 ${id}`, command: 'zsh', args: [], cwd: '/tmp', color: '#000',
    autoStart: false, enabled: true, ...patch,
  } as Template
}

test('设置页命中：config.standcode[role] 优先，source=settings', () => {
  writeRegistry({ default_worker: 'reg-worker', default_thinker: 'reg-thinker' })
  const templates = [tpl('settings-worker'), tpl('reg-worker')]
  const r = resolveRoleTemplate('worker', { worker: 'settings-worker' }, templates)
  assert.deepEqual(r, {
    role: 'worker', templateId: 'settings-worker', templateName: '模板 settings-worker', source: 'settings',
  })
})

test('设置页留空：回落 registry.json 的 default_worker/default_thinker，source=registry', () => {
  writeRegistry({ default_worker: 'reg-worker', default_thinker: 'reg-thinker' })
  const templates = [tpl('reg-worker'), tpl('reg-thinker')]
  const worker = resolveRoleTemplate('worker', {}, templates)
  assert.equal(worker.templateId, 'reg-worker')
  assert.equal(worker.source, 'registry')
  const thinker = resolveRoleTemplate('thinker', undefined, templates)
  assert.equal(thinker.templateId, 'reg-thinker')
  assert.equal(thinker.source, 'registry')
})

test('registry 指向的模板被停用/不存在：继续下落到第一个启用模板，source=fallback', () => {
  writeRegistry({ default_worker: 'disabled-one', default_thinker: 'ghost' })
  const templates = [tpl('disabled-one', { enabled: false }), tpl('first-enabled')]
  const worker = resolveRoleTemplate('worker', {}, templates)
  assert.equal(worker.templateId, 'first-enabled')
  assert.equal(worker.source, 'fallback')
  const thinker = resolveRoleTemplate('thinker', {}, templates)
  assert.equal(thinker.templateId, 'first-enabled')
  assert.equal(thinker.source, 'fallback')
})

test('全空（registry 无有效映射且没有任何启用模板）→ 抛错不静默', () => {
  writeRegistry({ default_worker: 'ghost', default_thinker: 'ghost' })
  assert.throws(
    () => resolveRoleTemplate('worker', {}, [tpl('off', { enabled: false })]),
    /解析不到可用模板/,
  )
  // registry 文件本身读不到也同口径
  fs.rmSync(REGISTRY_PATH)
  assert.throws(() => resolveRoleTemplate('thinker', undefined, []), /解析不到可用模板/)
})
