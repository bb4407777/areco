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
  /** exec 前的 shell 前置命令（原样拼进登录 shell，如 reasonix 的 config auto-plan on） */
  pre?: string[]
  description?: string
}

/**
 * 通道（供应商）层：一条 API 通道所需的整包 env（网关地址/凭证/隔离 HOME 等）。
 * models.json 每个条目的 provider 字段引用这里；providers.json 里查无此键 = 该通道
 * 不需要 env 包（凭证在 CLI 自己的配置里），静默跳过——这是常态而非错误。
 */
interface ProviderSpec {
  env?: Record<string, string>
  /** 解析时每个键都被填成 model_id：FreeModel 网关要把主/子/快模型全钉在同一模型上防回落 */
  model_env_keys?: string[]
  /** true = 渲染成 `env -i`（完全替换环境，rc 也拦不住）；env 包必须自带 PATH */
  clean_env?: boolean
  description?: string
}

export interface StandCodeResolved {
  command: string
  args: string[]
  /** env 一律渲染成命令行 `env [-i] K=V …` 前缀（登录 shell rc 之后生效，rc 覆盖不了），
   *  不走 spawn env 通道——此字段保留仅为兼容 SpawnSpec 组装方，恒为空对象。 */
  env: NodeJS.ProcessEnv
  cwd?: string
  pre?: string[]
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
 * 把 template 的 harness/model/preset 声明解析成可 spawn 的 command/args/pre。
 *
 * 分层：harness（怎么起 CLI）→ provider（走哪条通道：env 包，经 model 的 provider 字段
 * 间接引用）→ model（哪个模型：--model 旗标 + model_env_keys 钉扎）→ preset（参数旋钮）。
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
  const models = loadJson<{ models?: Record<string, { model_id?: string; provider?: string }> }>('models')
  const presets = loadJson<{ presets?: Record<string, { timeout?: number }> }>('presets')
  const providers = loadJson<{ providers?: Record<string, ProviderSpec> }>('providers')

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
  let modelId: string | undefined

  // 模型：openclaw/workbuddy/claude 等走 models.json 的 model_id；reasonix 直接用字面量。
  if (template.harness === 'reasonix') {
    if (template.model) {
      modelId = template.model
      args.push('--model', modelId)
    }
  } else if (model?.model_id) {
    modelId = model.model_id
    args.push('--model', modelId)
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

  // 通道层 env 包：harness.env 在底、provider.env 叠上、model_env_keys 钉扎最后。
  const provider = model?.provider ? providers?.providers?.[model.provider] : undefined
  const merged: Record<string, string> = { ...(harness.env ?? {}), ...(provider?.env ?? {}) }
  if (provider?.model_env_keys?.length) {
    if (!modelId) {
      throw new Error(
        `模板 ${template.id} 经 provider="${model?.provider}" 要求 model_env_keys 钉扎，但未解析出 model_id（model 字段留空？）`,
      )
    }
    for (const key of provider.model_env_keys) merged[key] = modelId
  }

  const clean = Boolean(provider?.clean_env)
  if (clean && !merged.PATH) {
    throw new Error(
      `provider="${model?.provider}" 声明了 clean_env（env -i 完全替换环境）但 env 包里没有 PATH，子进程将找不到任何命令`,
    )
  }

  // env 渲染成 `env [-i] K=V … <cmd> <args>` 命令行前缀：在登录 shell rc **之后**生效，
  // rc 的 export 覆盖不了（spawn env 通道会被 rc 覆盖，正是 bin/c5 用 env -i 的原因）。
  let command = harness.command
  let finalArgs = args
  const pairs = Object.entries(merged)
  if (pairs.length || clean) {
    finalArgs = [
      ...(clean ? ['-i'] : []),
      ...pairs.map(([k, v]) => `${k}=${v}`),
      command,
      ...args,
    ]
    command = 'env'
  }

  return {
    command,
    args: finalArgs,
    env: {},
    cwd: harness.cwd,
    pre: harness.pre?.length ? [...harness.pre] : undefined,
  }
}
