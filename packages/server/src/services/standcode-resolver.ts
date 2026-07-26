import type { Template } from '../../../shared/protocol'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT_DIR } from '../config'

// 配置目录可覆盖：2026-07-26 StandCode 已 subtree 并入本仓 standcode/，默认直接读
// 仓内 standcode/config（ROOT_DIR 与 config.json 同源：env ARECO_ROOT > cwd），
// 不再依赖仓外物理路径——那正是此前「换台机器整层静默失效」的根源。
const STANDCODE_CONFIG_DIR =
  process.env.STANDCODE_CONFIG_DIR || path.join(ROOT_DIR, 'standcode', 'config')

interface HarnessSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  description?: string
}

export interface StandCodeResolved {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

function loadJson<T>(name: string): T | null {
  try {
    const file = path.join(STANDCODE_CONFIG_DIR, `${name}.json`)
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

/**
 * 把 template 的 harness/model/preset 声明解析成可 spawn 的 command/args/env。
 *
 * 失败语义（2026-07-26 改）：**抛错，不再静默返回 null**。
 * 原先读不到配置或 harness 名字打错都返回 null，调用方 buildSpawnSpec 于是回落到
 * template.command —— 而 harness-first 的模板 command 恰恰是空串，最终 spawn 出
 * `zsh -ilc "exec ''"`，会话起来就死、日志里一个字都没有，排查起来毫无线索。
 * 声明了 harness 却解析不出来，是配置错误，就该当场炸。
 *
 * 返回 null 只保留一种含义：**这个模板没声明 harness**（走原有 command/args 路径）。
 */
export function resolveStandCode(template: Template): StandCodeResolved | null {
  if (!template.harness) return null

  const harnesses = loadJson<{ harnesses?: Record<string, HarnessSpec> }>('harnesses')
  const models = loadJson<{ models?: Record<string, { model_id?: string }> }>('models')
  const presets = loadJson<{ presets?: Record<string, { timeout?: number }> }>('presets')

  if (!harnesses) {
    throw new Error(
      `模板 ${template.id} 声明了 harness="${template.harness}"，但读不到 ` +
        `${STANDCODE_CONFIG_DIR}/harnesses.json（可用 STANDCODE_CONFIG_DIR 指定）`,
    )
  }

  const harness = harnesses.harnesses?.[template.harness]
  if (!harness?.command) {
    const known = Object.keys(harnesses.harnesses ?? {}).join(', ') || '(空)'
    throw new Error(
      `模板 ${template.id} 的 harness="${template.harness}" 在 harnesses.json 中不存在或没有 command。已知：${known}`,
    )
  }

  const model = models?.models?.[template.model ?? '']
  const preset = presets?.presets?.[template.preset ?? '']

  const args = [...(harness.args ?? [])]
  const env: NodeJS.ProcessEnv = { ...(harness.env ?? {}) }

  // 模型：openclaw/workbuddy 走 models.json 的 model_id；reasonix 直接用字面量。
  if (template.harness === 'reasonix') {
    if (template.model) args.push('--model', template.model)
  } else if (model?.model_id) {
    args.push('--model', model.model_id)
  } else if (template.model) {
    // 声明了 model 但字典里查不到 —— 静默忽略会让人以为换了模型其实没换
    throw new Error(
      `模板 ${template.id} 的 model="${template.model}" 在 models.json 中不存在`,
    )
  }

  // preset.timeout 原先只对 openclaw 生效，其余 harness 声明了 preset 也毫无效果。
  // 改为凡是支持 --timeout 的都带上（目前 openclaw；其余 harness 的 flag 面未验证，
  // 保持白名单而不是无脑加，免得给不认识该 flag 的 CLI 塞参数导致起不来）。
  if (preset?.timeout && template.harness === 'openclaw') {
    args.push('--timeout', String(preset.timeout))
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
