// 模板 CRUD（写回 config.json）+ spawn 参数构造：zsh -ilc 'exec …' 登录 shell 包裹（继承用户 rc 环境），
// claude 模板注入 --session-id/--resume；resolveCommand 仅作 spawn 前预检。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Template } from '../../../shared/protocol'
import type { AppConfig } from '../config'
import { saveConfig } from '../config'
import { createLogger } from '../logger'

const log = createLogger('templates')

/** POSIX 单引号安全转义：' → '\'' */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

export function buildShellCommand(command: string, args: string[]): string {
  return `exec ${[command, ...args].map(shellQuote).join(' ')}`
}

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export function isClaudeTemplate(template: Template): boolean {
  return path.basename(template.command) === 'claude'
}

/**
 * 该模板拉起的 claude 写 transcript 的 HOME；null = 非 claude 系模板。
 * 显式 claudeHome（bin/c5 这类固定隔离 HOME 的包装器）优先，裸 claude 默认服务进程 HOME。
 */
export function effectiveClaudeHome(template: Template): string | null {
  const explicit = template.claudeHome?.trim()
  if (explicit) return explicit
  return isClaudeTemplate(template) ? os.homedir() : null
}

const EXTRA_PATH_DIRS = [
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
]

/** 预检命令是否可寻址（找不到也照常 spawn——登录 shell 的 PATH 是最终真相，此处只为提前给出友好告警） */
export function resolveCommand(command: string): string | null {
  if (command.includes('/')) {
    return fs.existsSync(command) ? command : null
  }
  const dirs = [...(process.env.PATH || '').split(':'), ...EXTRA_PATH_DIRS].filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* 继续找 */
    }
  }
  return null
}

export function buildSpawnSpec(
  template: Template,
  opts: { cwd?: string; claudeSessionId?: string | null; resume?: boolean; extraArgs?: string[] }
): SpawnSpec {
  const args = [...template.args, ...(opts.extraArgs ?? [])]
  // claude 系（含 c5 这类透传 "$@" 的包装器）注入会话 id；非 claude 系两个 flag 都不认，不注入
  if (effectiveClaudeHome(template) !== null && opts.claudeSessionId) {
    if (opts.resume) args.push('--resume', opts.claudeSessionId)
    else args.push('--session-id', opts.claudeSessionId)
  }
  const cwd = opts.cwd || template.cwd || os.homedir()
  if (!resolveCommand(template.command)) {
    log.warn(`预检未找到命令 ${template.command}，仍尝试经登录 shell 启动`)
  }
  return {
    file: '/bin/zsh',
    args: ['-ilc', buildShellCommand(template.command, args)],
    cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
    env: buildCleanEnv(),
  }
}

/**
 * 最小干净环境：不透传守护进程自身的环境（agent 会话可能带 CLAUDE_CONFIG_DIR / ANTHROPIC_* 等
 * 覆盖变量，漏给子进程会让 claude 写错 transcript 目录、走错 API 配置）。
 * 其余一切交给 zsh -ilc 登录 shell 从用户 rc 文件重建——子进程环境 = 用户新开终端的环境。
 */
export function buildCleanEnv(): NodeJS.ProcessEnv {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'] as const
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.SHELL = env.SHELL || '/bin/zsh'
  env.LANG = env.LANG || 'zh_CN.UTF-8'
  env.PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...EXTRA_PATH_DIRS].join(':')
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

/** 按 ids 重排模板；ids 必须恰好是现有 id 的一个排列（防并发增删时整表覆盖丢模板） */
export function reorderTemplates(list: Template[], ids: string[]): Template[] {
  if (!Array.isArray(ids) || ids.length !== list.length || new Set(ids).size !== ids.length) {
    throw new Error('排序 ids 必须与现有模板一一对应，请刷新后重试')
  }
  const byId = new Map(list.map((t) => [t.id, t]))
  return ids.map((id) => {
    const template = byId.get(id)
    if (!template) throw new Error(`模板不存在: ${id}`)
    return template
  })
}

export class TemplateStore {
  constructor(private config: AppConfig) {}

  list(): Template[] {
    return this.config.templates
  }

  get(id: string): Template | undefined {
    return this.config.templates.find((t) => t.id === id)
  }

  create(input: Template): Template {
    if (!input.id || !/^[a-zA-Z0-9_-]+$/.test(input.id)) throw new Error('模板 id 只能含字母数字-_')
    if (this.get(input.id)) throw new Error(`模板 id 已存在: ${input.id}`)
    if (!input.command) throw new Error('command 不能为空')
    const template: Template = {
      id: input.id,
      name: input.name || input.id,
      command: input.command,
      args: Array.isArray(input.args) ? input.args.map(String) : [],
      cwd: input.cwd || os.homedir(),
      color: input.color || '#7d8590',
      autoStart: Boolean(input.autoStart),
      enabled: input.enabled !== false,
      ...(input.claudeHome?.trim() ? { claudeHome: input.claudeHome.trim() } : {}),
    }
    this.config.templates.push(template)
    saveConfig(this.config)
    return template
  }

  update(id: string, patch: Partial<Template>): Template {
    const template = this.get(id)
    if (!template) throw new Error(`模板不存在: ${id}`)
    if (patch.command !== undefined && !patch.command) throw new Error('command 不能为空')
    Object.assign(template, {
      name: patch.name ?? template.name,
      command: patch.command ?? template.command,
      args: Array.isArray(patch.args) ? patch.args.map(String) : template.args,
      cwd: patch.cwd ?? template.cwd,
      color: patch.color ?? template.color,
      autoStart: patch.autoStart ?? template.autoStart,
      enabled: patch.enabled ?? template.enabled,
      claudeHome: patch.claudeHome !== undefined ? patch.claudeHome.trim() || undefined : template.claudeHome,
    })
    saveConfig(this.config)
    return template
  }

  remove(id: string) {
    const i = this.config.templates.findIndex((t) => t.id === id)
    if (i < 0) throw new Error(`模板不存在: ${id}`)
    this.config.templates.splice(i, 1)
    saveConfig(this.config)
  }

  /** 拖动排序：原地重排（config.templates 数组被多处引用，不能换新数组） */
  reorder(ids: string[]): Template[] {
    const next = reorderTemplates(this.config.templates, ids)
    this.config.templates.splice(0, this.config.templates.length, ...next)
    saveConfig(this.config)
    return this.config.templates
  }
}
