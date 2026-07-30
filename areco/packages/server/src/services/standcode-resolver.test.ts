// StandCode 分层解析单测：harness → provider（通道 env 包）→ model → preset
// 注意：resolver 在模块加载时固化 STANDCODE_CONFIG_DIR，必须先设 env 再动态 import。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Template } from '../../../shared/protocol'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standcode-config-'))
process.env.STANDCODE_CONFIG_DIR = dir

fs.writeFileSync(
  path.join(dir, 'harnesses.json'),
  JSON.stringify({
    harnesses: {
      claude: {
        command: 'claude',
        args: ['--setting-sources', 'user', '--dangerously-skip-permissions'],
        env: {},
        cwd: '/Users/gao',
      },
      workbuddy: { command: '/apps/codebuddy', args: ['--dangerously-skip-permissions'], env: {} },
      codex: { command: 'codex', args: ['--sandbox', 'danger-full-access'], env: {} },
      qoder: { command: 'qoderclicn', args: ['--dangerously-skip-permissions'], env: {} },
      hermes: {
        command: '/opt/hermes',
        args: ['chat', '--cli', '--yolo'],
        env: { HERMES_HOME: '/Users/gao/.qclaw-hermes', NO_COLOR: '1' },
      },
      reasonix: {
        command: 'reasonix',
        args: ['--yolo'],
        env: {},
        pre: ['reasonix config auto-plan on >/dev/null 2>&1 || true'],
      },
    },
  }),
)
fs.writeFileSync(
  path.join(dir, 'models.json'),
  JSON.stringify({
    models: {
      'workbuddy-deepseek-pro': {
        provider: 'workbuddy',
        model_id: 'deepseek-v4-pro',
        reasoning_efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
      'gpt-5.6-sol': {
        provider: 'freemodel',
        model_id: 'gpt-5.6-sol',
        reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      'claude-fable-5': {
        provider: 'freemodel-cc',
        model_id: 'claude-fable-5',
        reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      'gateway-no-path': { provider: 'broken-gateway', model_id: 'x-1' },
      'orphan-provider': { provider: 'nowhere', model_id: 'orphan-1' },
    },
  }),
)
fs.writeFileSync(
  path.join(dir, 'providers.json'),
  JSON.stringify({
    providers: {
      'freemodel-cc': {
        clean_env: true,
        env: {
          HOME: '/Users/gao/.homes/claude-freemodel',
          PATH: '/usr/local/bin:/usr/bin:/bin',
          ANTHROPIC_BASE_URL: 'https://api-cc.freemodel.dev',
        },
        model_env_keys: ['ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'],
      },
      'broken-gateway': { clean_env: true, env: { ANTHROPIC_BASE_URL: 'https://x' } },
      workbuddy: { description: '无 env 包' },
    },
  }),
)
fs.writeFileSync(path.join(dir, 'presets.json'), JSON.stringify({ presets: { thinker: { timeout: 600 } } }))

const { resolveStandCode } = await import('./standcode-resolver')
const { standCodeCatalog } = await import('./standcode-resolver')
const { buildSpawnSpec } = await import('./templates')

function tpl(patch: Partial<Template>): Template {
  return {
    id: 't', name: 't', command: '', args: [], cwd: '', color: '#000',
    autoStart: false, enabled: true, ...patch,
  } as Template
}

test('未声明 harness → null（走原 command/args 路径）', () => {
  assert.equal(resolveStandCode(tpl({ command: 'zsh' })), null)
})

test('harness+model 基本解析：--model 用 models.json 的 model_id', () => {
  const r = resolveStandCode(tpl({ harness: 'workbuddy', model: 'workbuddy-deepseek-pro' }))
  assert.ok(r)
  assert.equal(r.command, '/apps/codebuddy')
  assert.deepEqual(r.args, ['--dangerously-skip-permissions', '--model', 'deepseek-v4-pro'])
})

test('buildSpawnSpec：官方 WorkBuddy harness 新建/恢复均注入确定性原生 ID', () => {
  const template = tpl({ harness: 'workbuddy', model: 'workbuddy-deepseek-pro', cwd: '/tmp' })
  const fresh = buildSpawnSpec(template, {
    cwd: '/tmp',
    agentSessionId: '11111111-1111-4111-8111-111111111111',
  })
  assert.match(fresh.args[1] ?? '', /--session-id/)
  assert.match(fresh.args[1] ?? '', /11111111-1111-4111-8111-111111111111/)

  const resumed = buildSpawnSpec(template, {
    cwd: '/tmp',
    agentSessionId: '22222222-2222-4222-8222-222222222222',
    resumeAgent: true,
  })
  assert.match(resumed.args[1] ?? '', /--resume/)
  assert.match(resumed.args[1] ?? '', /22222222-2222-4222-8222-222222222222/)
  assert.doesNotMatch(resumed.args[1] ?? '', /--session-id/)
})

test('buildSpawnSpec：未声明 workbuddy harness 的 bridge 不注入官方 --session-id', () => {
  const template = tpl({
    id: 'wb-bridge',
    command: '/tmp/codebuddy',
    args: ['--bridge', 'http://127.0.0.1:8780'],
    cwd: '/tmp',
  })
  const spec = buildSpawnSpec(template, {
    cwd: '/tmp',
    agentSessionId: '11111111-1111-4111-8111-111111111111',
  })
  assert.doesNotMatch(spec.args[1] ?? '', /--session-id/)
})

test('推理档位按 harness 翻译：Codex 用 -c，Claude/WorkBuddy 用 --effort', () => {
  const codex = resolveStandCode(tpl({ harness: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }))
  assert.ok(codex)
  assert.deepEqual(codex.args, [
    '--sandbox', 'danger-full-access', '--model', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort="xhigh"',
  ])

  const claude = resolveStandCode(tpl({ harness: 'claude', model: 'claude-fable-5', reasoningEffort: 'max' }))
  assert.ok(claude)
  const claudeAt = claude.args.indexOf('claude')
  assert.deepEqual(claude.args.slice(claudeAt), [
    'claude', '--setting-sources', 'user', '--dangerously-skip-permissions',
    '--model', 'claude-fable-5', '--effort', 'max',
  ])

  const workbuddy = resolveStandCode(
    tpl({ harness: 'workbuddy', model: 'workbuddy-deepseek-pro', reasoningEffort: 'minimal' }),
  )
  assert.ok(workbuddy)
  assert.deepEqual(workbuddy.args, [
    '--dangerously-skip-permissions', '--model', 'deepseek-v4-pro', '--effort', 'minimal',
  ])
})

test('推理档位按 model 缩窄；无可靠 flag 的 harness 明确拒绝', () => {
  assert.throws(
    () => resolveStandCode(tpl({ harness: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'minimal' })),
    /可用：low, medium, high, xhigh, max, ultra/,
  )
  assert.throws(
    () => resolveStandCode(tpl({ harness: 'reasonix', reasoningEffort: 'high' })),
    /没有已验证的推理档位参数/,
  )
})

test('设置目录只暴露能力元数据，并按 harness/model 分别列档位', () => {
  const catalog = standCodeCatalog()
  assert.deepEqual(catalog.harnesses.codex.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.deepEqual(catalog.harnesses.reasonix.reasoningEfforts, [])
  assert.deepEqual(catalog.models['gpt-5.6-sol'].reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.equal(JSON.stringify(catalog).includes('ANTHROPIC_BASE_URL'), false)
})

test('未知 harness / 未知 model → 抛错不静默', () => {
  assert.throws(() => resolveStandCode(tpl({ harness: 'nope' })), /不存在/)
  assert.throws(() => resolveStandCode(tpl({ harness: 'workbuddy', model: 'ghost' })), /models\.json 中不存在/)
})

test('provider 通道层：clean_env 渲染 env -i + model_env_keys 全部钉成 model_id', () => {
  const r = resolveStandCode(tpl({ harness: 'claude', model: 'claude-fable-5' }))
  assert.ok(r)
  assert.equal(r.command, 'env')
  assert.equal(r.args[0], '-i')
  assert.ok(r.args.includes('ANTHROPIC_MODEL=claude-fable-5'))
  assert.ok(r.args.includes('CLAUDE_CODE_SUBAGENT_MODEL=claude-fable-5'))
  assert.ok(r.args.includes('ANTHROPIC_BASE_URL=https://api-cc.freemodel.dev'))
  // env 对之后必须是真命令与其 args（--model 在包内，session-id 由 buildSpawnSpec 追加在末尾也能到达真命令）
  const at = r.args.indexOf('claude')
  assert.ok(at > 0)
  assert.deepEqual(r.args.slice(at), [
    'claude', '--setting-sources', 'user', '--dangerously-skip-permissions', '--model', 'claude-fable-5',
  ])
  assert.deepEqual(r.env, {})
})

test('clean_env 但 env 包缺 PATH → 抛错', () => {
  assert.throws(() => resolveStandCode(tpl({ harness: 'claude', model: 'gateway-no-path' })), /PATH/)
})

test('provider 在 providers.json 查无此键 = 常态跳过，不抛错', () => {
  const r = resolveStandCode(tpl({ harness: 'workbuddy', model: 'orphan-provider' }))
  assert.ok(r)
  assert.equal(r.command, '/apps/codebuddy')
  assert.ok(r.args.includes('orphan-1'))
})

test('harness 自带 env（无 provider）→ env 前缀但不带 -i', () => {
  const r = resolveStandCode(tpl({ harness: 'hermes' }))
  assert.ok(r)
  assert.equal(r.command, 'env')
  assert.notEqual(r.args[0], '-i')
  assert.deepEqual(r.args, [
    'HERMES_HOME=/Users/gao/.qclaw-hermes', 'NO_COLOR=1', '/opt/hermes', 'chat', '--cli', '--yolo',
  ])
})

test('reasonix：model 字面量直传 + pre 前置命令透出', () => {
  const r = resolveStandCode(tpl({ harness: 'reasonix', model: 'qclaw-deepseek-flash' }))
  assert.ok(r)
  assert.deepEqual(r.args, ['--yolo', '--model', 'qclaw-deepseek-flash'])
  assert.deepEqual(r.pre, ['reasonix config auto-plan on >/dev/null 2>&1 || true'])
})

test('buildSpawnSpec 集成：pre 拼在 exec 之前，同一登录 shell 内顺序执行', () => {
  const spec = buildSpawnSpec(tpl({ harness: 'reasonix', model: 'qclaw-deepseek-flash', cwd: '/tmp' }), {})
  assert.equal(spec.file, '/bin/zsh')
  assert.equal(spec.args[0], '-ilc')
  assert.ok(spec.args[1].startsWith('reasonix config auto-plan on >/dev/null 2>&1 || true; exec '))
  assert.ok(spec.args[1].includes(`'--model' 'qclaw-deepseek-flash'`))
})

test('buildSpawnSpec 集成：claudeHome 模板的 session-id 追加在 env 包末尾，仍归真命令', () => {
  const spec = buildSpawnSpec(
    tpl({ harness: 'claude', model: 'claude-fable-5', cwd: '/tmp', claudeHome: '/Users/gao/.homes/claude-freemodel' }),
    { claudeSessionId: 'abc-123' },
  )
  const script = spec.args[1]
  assert.ok(script.startsWith(`exec 'env' '-i' `))
  assert.ok(script.endsWith(`'--session-id' 'abc-123'`))
})
