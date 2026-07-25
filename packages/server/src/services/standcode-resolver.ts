import type { Template } from '../../../shared/protocol'
import fs from 'node:fs'
import path from 'node:path'

const STANDCODE_CONFIG_DIR = '/Users/gao/Code/StandCode/config'

export interface StandCodeResolved {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

function loadJson(name: string): any {
  try {
    const file = path.join(STANDCODE_CONFIG_DIR, `${name}.json`)
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

export function resolveStandCode(template: Template): StandCodeResolved | null {
  if (!template.harness) return null

  const harnesses = loadJson('harnesses')
  const models = loadJson('models')
  const presets = loadJson('presets')

  const harness = harnesses?.harnesses?.[template.harness]
  const model = models?.models?.[template.model ?? '']
  const preset = presets?.presets?.[template.preset ?? '']

  if (!harness) return null

  const args = [...(harness.args ?? [])]
  const env: NodeJS.ProcessEnv = { ...(harness.env ?? {}) }

  if (template.harness === 'openclaw') {
    if (model?.model_id) args.push('--model', model.model_id)
    if (preset?.timeout) args.push('--timeout', String(preset.timeout))
  } else if (template.harness === 'workbuddy') {
    if (model?.model_id) args.push('--model', model.model_id)
  } else if (template.harness === 'reasonix') {
    if (template.model) args.push('--model', template.model)
  }

  return {
    command: harness.command,
    args,
    env,
    cwd: harness.cwd,
  }
}

export function expandStandCodeEnv(): NodeJS.ProcessEnv {
  // 继承用户登录 shell 环境变量，但由 buildCleanEnv 控制白名单
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  return env
}
