// /api/* 控制器：参数校验 + service 调用 + 统一 {ok,data|error} 响应
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Context } from 'koa'
import type { ScreenTailPayload, StatsSummary, Template, TranscriptMessage, TranscriptPage } from '../../../shared/protocol'
import type { SessionManager } from '../services/session-manager'
import type { TemplateStore } from '../services/templates'
import type { AppConfig, VoiceConfig } from '../config'
import { DATA_DIR, saveConfig } from '../config'
import { readTranscriptFile, transcriptPath } from '../services/transcript'
import { agentKindOf, locateClaudeTranscript, parseQclaw, readAgentAllMessages, readAgentTranscript } from '../services/agent-transcript'
import {
  defaultHistoryRoots,
  historyCwd,
  kimiParseLine,
  kimiWorkDirOf,
  listHistory,
  readHistoryAllMessages,
  readHistoryPage,
  resolveHistoryFile,
  resolveKimiWire,
} from '../services/history'
import { chatlogCwd, isChatlogSource, readChatlogTranscript } from '../services/chatlog'

// 与 history.ts 的 SAFE_SEGMENT 同规则：单段路径只允许安全字符（本地副本，history.ts 未导出该常量）
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$|^-[A-Za-z0-9._-]+$/
import { handoffPrompt, writeHandoffFile } from '../services/handoff'
import { effectiveClaudeHome } from '../services/templates'
import { FileService } from '../services/files'
import { transcribe } from '../services/voice-asr'

const execFileAsync = promisify(execFile)

function ok(ctx: Context, data: unknown) {
  ctx.body = { ok: true, data }
}

function fail(ctx: Context, status: number, code: string, message: string) {
  ctx.status = status
  ctx.body = { ok: false, error: { code, message } }
}

function statusFor(message: string): { status: number; code: string } {
  if (message.includes('不存在')) return { status: 404, code: 'not_found' }
  if (
    message.includes('上限') ||
    message.includes('仍在运行') ||
    message.includes('不可删除') ||
    message.includes('不可归档') ||
    message.includes('已在运行')
  )
    return { status: 409, code: 'conflict' }
  return { status: 400, code: 'bad_request' }
}

function guard(ctx: Context, fn: () => void) {
  try {
    fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const { status, code } = statusFor(message)
    fail(ctx, status, code, message)
  }
}

export function getAccessUrls(port: number): { lan: string[]; tailscale: string[] } {
  const lan: string[] = []
  const tailscale: string[] = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const url = `http://${info.address}:${port}`
      const second = Number(info.address.split('.')[1])
      if (info.address.startsWith('100.') && second >= 64 && second <= 127) tailscale.push(url)
      else lan.push(url)
    }
  }
  return { lan, tailscale }
}

export class ApiControllers {
  private startedAt = Date.now()
  private files: FileService

  constructor(
    private manager: SessionManager,
    private templates: TemplateStore,
    private config: AppConfig,
    private version: string,
    files?: FileService
  ) {
    this.files = files ?? new FileService(
      () => this.config.server.fileRoots,
      () => this.config.server.fileRootsUnrestricted
    )
  }

  system = (ctx: Context) => {
    ok(ctx, {
      title: this.config.server.title,
      version: this.version,
      uptimeMs: Date.now() - this.startedAt,
      authEnabled: Boolean(this.config.server.passwordHash.trim()),
      host: this.config.server.host,
      port: this.config.server.port,
      maxSessions: this.config.server.maxSessions,
      urls: getAccessUrls(this.config.server.port),
      // 语音输入：只回 key 是否已配置，绝不回传明文（密钥只在服务端 config.json）
      voice: {
        engine: this.config.voice?.engine ?? 'funasr',
        aliyunApiKeyConfigured: Boolean(this.config.voice?.aliyunApiKey?.trim()),
        python: this.config.voice?.python ?? 'python3',
      },
    })
  }

  /** 一键重启（维护者 2026-07-22）：等价命令行 `cd 仓根 && ./start.sh restart`。
   *  脚本会杀掉本进程——先回响应，延时 500ms 再派 detached 子进程执行，避免响应被掐断。
   *  ARECO_RESTART_VIA_API=1 告知脚本调用方是服务自己的子进程：launchd 下只走 kickstart -k，
   *  禁 bootout（bootout 的整组 teardown 会把本调用方一起带走，bootstrap 永远跑不到——2026-07-23 实测躺尸）。
   *  输出落 data/logs/restart.log，出事可查（原 stdio ignore 两眼一抹黑） */
  restartServer = (ctx: Context) => {
    ok(ctx, { restarting: true })
    setTimeout(() => {
      const logFd = fs.openSync(path.join(process.cwd(), 'data/logs/restart.log'), 'a')
      const child = spawn('./start.sh', ['restart'], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ARECO_RESTART_VIA_API: '1' },
      })
      child.unref()
    }, 500)
  }

  /** 更新运行参数（会话上限 / 语音设置）：写回 config.json；同一 config 对象引用，SessionManager 即时生效，无需重启 */
  updateSettings = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as {
        maxSessions?: unknown
        voice?: { engine?: unknown; aliyunApiKey?: unknown; python?: unknown } | null
      }
      const out: Record<string, unknown> = {}
      if (body.maxSessions !== undefined) {
        const n = Number(body.maxSessions)
        if (!Number.isInteger(n) || n < 0) throw new Error('会话上限须为 ≥0 的整数（0 = 无上限）')
        this.config.server.maxSessions = n
        out.maxSessions = n
      }
      if (body.voice != null) {
        const v = body.voice
        const voice: VoiceConfig = this.config.voice ?? { engine: 'funasr', python: 'python3' }
        if (v.engine !== undefined) {
          const eng = String(v.engine)
          if (!['funasr', 'sensevoice', 'aliyun', 'whisper'].includes(eng)) throw new Error('voice.engine 须为 funasr/sensevoice/aliyun/whisper')
          voice.engine = eng as VoiceConfig['engine']
        }
        if (v.aliyunApiKey !== undefined) {
          const key = String(v.aliyunApiKey ?? '').trim()
          if (key && !/^sk-[A-Za-z0-9_\-.]{20,}$/.test(key)) throw new Error('阿里云 Key 须 sk- 开头')
          if (key) voice.aliyunApiKey = key
          else delete voice.aliyunApiKey // 空串 = 清空
        }
        if (v.python !== undefined) {
          const py = String(v.python).trim()
          if (py) voice.python = py
        }
        this.config.voice = voice
        out.voice = {
          engine: voice.engine,
          aliyunApiKeyConfigured: Boolean(voice.aliyunApiKey?.trim()),
          python: voice.python ?? 'python3',
        }
      }
      if (Object.keys(out).length === 0) throw new Error('未提供可更新字段（maxSessions / voice）')
      saveConfig(this.config)
      ok(ctx, out)
    })

  // ---- templates ----

  listTemplates = (ctx: Context) => ok(ctx, this.templates.list())

  createTemplate = (ctx: Context) =>
    guard(ctx, () => ok(ctx, this.templates.create((ctx.request.body ?? {}) as Template)))

  updateTemplate = (ctx: Context) =>
    guard(ctx, () => ok(ctx, this.templates.update(ctx.params.id, (ctx.request.body ?? {}) as Partial<Template>)))

  removeTemplate = (ctx: Context) =>
    guard(ctx, () => {
      this.templates.remove(ctx.params.id)
      ok(ctx, { removed: ctx.params.id })
    })

  reorderTemplates = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { ids?: string[] }
      ok(ctx, this.templates.reorder(Array.isArray(body.ids) ? body.ids.map(String) : []))
    })

  // ---- sessions ----

  listSessions = (ctx: Context) => ok(ctx, this.manager.list())

  getSession = (ctx: Context) => guard(ctx, () => ok(ctx, this.manager.get(ctx.params.id).toSummary()))

  spawnSession = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { templateId?: string; cwd?: string; name?: string }
      if (!body.templateId) throw new Error('templateId 不能为空')
      ok(ctx, this.manager.spawn(body.templateId, { cwd: body.cwd, name: body.name }))
    })

  stopSession = (ctx: Context) =>
    guard(ctx, () => {
      this.manager.stop(ctx.params.id)
      ok(ctx, this.manager.get(ctx.params.id).toSummary())
    })

  killSession = (ctx: Context) =>
    guard(ctx, () => {
      this.manager.kill(ctx.params.id)
      ok(ctx, this.manager.get(ctx.params.id).toSummary())
    })

  restartSession = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { resume?: boolean }
      ok(ctx, this.manager.restart(ctx.params.id, Boolean(body.resume)))
    })

  renameSession = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { name?: string }
      ok(ctx, this.manager.rename(ctx.params.id, String(body.name ?? '')))
    })

  archiveSession = (ctx: Context) =>
    guard(ctx, () => ok(ctx, this.manager.setArchived(ctx.params.id, true)))

  pinSession = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { pinned?: boolean }
      ok(ctx, this.manager.setPinned(ctx.params.id, Boolean(body.pinned)))
    })

  unarchiveSession = (ctx: Context) =>
    guard(ctx, () => ok(ctx, this.manager.setArchived(ctx.params.id, false)))

  removeSession = (ctx: Context) =>
    guard(ctx, () => {
      this.manager.remove(ctx.params.id)
      ok(ctx, { removed: ctx.params.id })
    })

  // 对话模式「终端尾屏」：直读影子终端 buffer 尾行，供不切页查看 TUI 选项/确认提示
  screen = (ctx: Context) =>
    guard(ctx, () => {
      const session = this.manager.get(ctx.params.id)
      ok(ctx, { lines: session.screenTail(16) } satisfies ScreenTailPayload)
    })

  // ---- Phase 2：transcript + telemetry-lite ----

  transcript = (ctx: Context) =>
    guard(ctx, () => {
      const session = this.manager.get(ctx.params.id)
      const beforeRaw = Number(ctx.query.before)
      const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : undefined
      const cursor = Math.max(0, Number(ctx.query.cursor ?? 0) || 0)
      // 定位 transcript 文件：claude 系按 --session-id 直取；缺 claudeSessionId 的
      // claude 包装器（模板 claudeHome 曾丢失）按时间窗兜底定位；其余走 agent 自家落盘
      let filePath: string | null = null
      if (session.claudeSessionId) {
        filePath = transcriptPath(session)
      } else {
        const kind = agentKindOf(session.command)
        if (kind) {
          // codex/codebuddy/reasonix：直读 agent 自己的会话落盘，消息级游标
          ok(ctx, readAgentTranscript(session, kind, { cursor, before }))
          return
        }
        const template = this.templates.get(session.templateId)
        const home = template ? effectiveClaudeHome(template) : null
        filePath = home ? locateClaudeTranscript(session, home) : null
      }
      if (!filePath || !fs.existsSync(filePath)) {
        ok(ctx, { exists: false, messages: [], cursor: 0 } satisfies TranscriptPage)
        return
      }
      // claude 格式：首载（cursor=0）与「加载更早」（before）走尾部倒序字节分页；
      // cursor>0 是既有的向前增量轮询（实时追新）
      if (before !== undefined || cursor === 0) {
        const page = readHistoryPage(filePath, before)
        ok(ctx, {
          exists: true,
          messages: page.messages,
          cursor: page.end,
          start: page.start,
          hasMore: page.hasMore,
        } satisfies TranscriptPage)
        return
      }
      ok(ctx, readTranscriptFile(filePath, cursor))
    })

  // ---- Phase 3：历史对话浏览 ----

  private historyRoots = defaultHistoryRoots()

  /** 历史源目录 = <home>/.claude/projects，反推出 HOME */
  private historyHomeDir(source: string): string | null {
    const root = this.historyRoots.find((r) => r.source === source)
    return root ? path.resolve(root.dir, '..', '..') : null
  }

  /** 能恢复该源会话的模板：模板生效 claudeHome 与源 HOME 一致（隔离 HOME 分身靠模板配 claudeHome 对上） */
  private resumeTemplateFor(source: string): Template | undefined {
    const home = this.historyHomeDir(source)
    if (!home) return undefined
    return this.templates.list().find((t) => t.enabled && effectiveClaudeHome(t) === home)
  }

  /** reasonix 特例：CLI 无按 id 非交互恢复，只能在真终端里拉 --resume 原生选择器（会话按 cwd 归属） */
  private reasonixTemplate(): Template | undefined {
    return this.templates.list().find((t) => t.enabled && path.basename(t.command) === 'reasonix')
  }

  /** 按命令 basename 找启用模板（kimi / codex / codebuddy 的历史恢复都用这个） */
  private templateByCommand(cmd: string): Template | undefined {
    return this.templates.list().find((t) => t.enabled && path.basename(t.command) === cmd)
  }

  historyList = (ctx: Context) =>
    guard(ctx, () => {
      const limit = Math.min(100, Math.max(1, Number(ctx.query.limit ?? 30) || 30))
      const offset = Math.max(0, Number(ctx.query.offset ?? 0) || 0)
      const q = typeof ctx.query.q === 'string' ? ctx.query.q : undefined
      const page = listHistory(this.historyRoots, { limit, offset, q })
      // 标记哪些历史会话就是看板里的会话：claude 系按 claudeSessionId，kimi/codex 等按 agentSessionId
      const sessions = this.manager.list()
      const live = new Map(sessions.flatMap((s) => (s.claudeSessionId ? [[s.claudeSessionId, s.id] as const] : [])))
      const liveAgent = new Map(sessions.flatMap((s) => (s.agentSessionId ? [[s.agentSessionId, s.id] as const] : [])))
      const resumableSources = new Map(this.historyRoots.map((r) => [r.source, Boolean(this.resumeTemplateFor(r.source))]))
      const reasonixOk = Boolean(this.reasonixTemplate())
      const kimiOk = Boolean(this.templateByCommand('kimi'))
      const codexOk = Boolean(this.templateByCommand('codex'))
      const workbuddyOk = Boolean(this.templateByCommand('codebuddy'))
      for (const entry of page.entries) {
        // chatlog 层条目 id 带源前缀（codex-/workbuddy-），剥掉才是 agentSessionId 的裸 uuid（同 historyResume 的剥法）
        const rawEntryId = entry.id.replace(/^(codex|workbuddy)-/, '')
        entry.liveSessionId = live.get(entry.id) ?? liveAgent.get(rawEntryId) ?? null
        if (entry.source === 'reasonix') entry.resumable = reasonixOk
        else if (entry.source === 'kimi') entry.resumable = kimiOk
        else if (entry.source === 'codex') entry.resumable = codexOk
        // workbuddy 会话按 cwd-slug 归档，缺 cwd（旧数据）恢复会找不到会话，不给恢复
        else if (entry.source === 'workbuddy') entry.resumable = workbuddyOk && Boolean(entry.cwd)
        else entry.resumable = resumableSources.get(entry.source) ?? false
      }
      ok(ctx, page)
    })

  historyTranscript = (ctx: Context) =>
    guard(ctx, () => {
      const { source, project, id } = ctx.params
      // chatlog 统一层的源（codex 等）：从提取数据出正文，不走文件路径
      if (isChatlogSource(source)) {
        ok(ctx, readChatlogTranscript(source, project, id))
        return
      }
      // QClaw 原生源：直接读 ~/.qclaw/agents/main/sessions/{id}.jsonl
      if (source === 'qclaw') {
        // @koa/router 会 decodeURIComponent，"..%2F" 能混进 id——与 resolveHistoryFile 同款校验，非法 id 一律拒
        if (!SAFE_SEGMENT.test(id) || id.includes('..')) throw new Error('会话 id 不合法')
        const qclawDir = path.join(os.homedir(), '.qclaw', 'agents', 'main', 'sessions')
        const filePath = path.join(qclawDir, `${id}.jsonl`)
        if (!fs.existsSync(filePath)) throw new Error('历史会话不存在')
        const raw = fs.readFileSync(filePath, 'utf8')
        const messages = parseQclaw(raw)
        ok(ctx, { messages, start: 0, end: messages.length, hasMore: false })
        return
      }
      // kimi 原生层：wire.jsonl 字节游标分页（kimiParseLine 行解析）
      if (source === 'kimi') {
        const filePath = resolveKimiWire(project, id)
        const beforeRaw = Number(ctx.query.before)
        const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : undefined
        ok(ctx, readHistoryPage(filePath, before, kimiParseLine))
        return
      }
      const filePath = resolveHistoryFile(this.historyRoots, source, project, id)
      const beforeRaw = Number(ctx.query.before)
      const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : undefined
      ok(ctx, readHistoryPage(filePath, before))
    })

  historyResume = (ctx: Context) =>
    guard(ctx, () => {
      const { source, project, id } = ctx.params
      const body0 = (ctx.request.body ?? {}) as { name?: string }
      if (source === 'reasonix') {
        const template = this.reasonixTemplate()
        if (!template) throw new Error('没有可用的 reasonix 模板')
        // 拉起原生 --resume 选择器（TUI），进座舱终端里挑目标会话
        ok(ctx, this.manager.spawn(template.id, { name: body0.name, extraArgs: ['--resume'] }))
        return
      }
      // kimi 原生恢复：-S <session_id> 须放命令行最后（extraArgs 天然在最后），回到原 cwd
      if (source === 'kimi') {
        const cwd = kimiWorkDirOf(resolveKimiWire(project, id))
        if (!cwd) throw new Error('该会话未记录工作目录，无法恢复')
        const body = (ctx.request.body ?? {}) as { templateId?: string; name?: string }
        const template = body.templateId ? this.templates.get(body.templateId) : this.templateByCommand('kimi')
        if (!template) throw new Error('没有可用的 kimi 模板')
        ok(ctx, this.manager.spawn(template.id, { cwd, name: body.name, extraArgs: ['-S', id] }))
        return
      }
      // codex / workbuddy（chatlog 层）：原生 resume——codex `resume <uuid>`，codebuddy `--resume <uuid>`；
      // chatlog id 带源前缀（codex-/workbuddy-），剥掉才是原生会话 id；workbuddy 必须回原 cwd（按 cwd-slug 归档）
      if (source === 'codex' || source === 'workbuddy') {
        const cwd = chatlogCwd(source, project, id)
        if (source === 'workbuddy' && !cwd) throw new Error('该会话未记录工作目录，无法恢复')
        const rawId = id.replace(/^(codex|workbuddy)-/, '')
        if (!rawId || rawId === id) throw new Error('会话 id 不合法')
        const body = (ctx.request.body ?? {}) as { templateId?: string; name?: string }
        const fallback = this.templateByCommand(source === 'codex' ? 'codex' : 'codebuddy')
        const template = body.templateId ? this.templates.get(body.templateId) : fallback
        if (!template) throw new Error(`没有可用的 ${source} 模板`)
        const extraArgs = source === 'codex' ? ['resume', rawId] : ['--resume', rawId]
        ok(ctx, this.manager.spawn(template.id, { cwd: cwd || undefined, name: body.name, extraArgs }))
        return
      }
      if (isChatlogSource(source)) throw new Error('该历史源不支持恢复（cc-connect 是渠道桥接副本，无独立会话可恢复）')
      const filePath = resolveHistoryFile(this.historyRoots, source, project, id)
      const cwd = historyCwd(filePath)
      if (!cwd) throw new Error('该会话未记录工作目录，无法恢复')
      const body = (ctx.request.body ?? {}) as { templateId?: string; name?: string }
      const template = body.templateId ? this.templates.get(body.templateId) : this.resumeTemplateFor(source)
      if (!template) throw new Error(`没有能恢复「${source}」会话的模板（模板需配 claudeHome 指向该源的 HOME）`)
      ok(ctx, this.manager.spawn(template.id, { cwd, name: body.name, resumeClaudeSessionId: id }))
    })

  /** 跨 agent 接续：历史全文写成交接档案，任选模板拉起新会话读档续干（有损但通用，与原生 resume 互补） */
  historyContinue = (ctx: Context) =>
    guard(ctx, () => {
      const { source, project, id } = ctx.params
      const body = (ctx.request.body ?? {}) as { templateId?: string; name?: string }
      if (!body.templateId) throw new Error('templateId 不能为空')
      const template = this.templates.get(body.templateId)
      if (!template || !template.enabled) throw new Error('模板不存在或已停用')
      if (['zsh', 'bash', 'sh', 'fish'].includes(path.basename(template.command))) {
        throw new Error('shell 模板无法接续对话')
      }

      let messages
      let cwd = ''
      if (isChatlogSource(source)) {
        messages = readChatlogTranscript(source, project, id).messages
      } else if (source === 'kimi') {
        const filePath = resolveKimiWire(project, id)
        messages = readHistoryAllMessages(filePath, undefined, kimiParseLine)
        cwd = kimiWorkDirOf(filePath)
      } else {
        const filePath = resolveHistoryFile(this.historyRoots, source, project, id)
        messages = readHistoryAllMessages(filePath)
        cwd = historyCwd(filePath)
      }
      if (!messages.length) throw new Error('该会话没有可交接的内容')

      const file = writeHandoffFile({ source, project, id, title: body.name || id.slice(0, 8) }, messages)
      ok(ctx, this.spawnWithHandoff(template, file, source, { cwd: cwd || undefined, name: body.name }))
    })

  /**
   * 交接档案 + 拉起接手会话（historyContinue 与 sessionHandoff 共用）。
   * claude 系/codex 支持启动参数带首条指令；其余 TUI（reasonix/codebuddy 等）
   * 等输出安静（首屏画完）再注入——固定延时对冷启动 10s+ 的 agent 必丢。
   */
  private spawnWithHandoff(
    template: Template,
    file: string,
    source: string,
    opts: { cwd?: string; name?: string }
  ) {
    const prompt = handoffPrompt(file, source)
    const viaArg = effectiveClaudeHome(template) !== null || path.basename(template.command) === 'codex'
    const summary = this.manager.spawn(template.id, {
      cwd: opts.cwd,
      name: opts.name,
      extraArgs: viaArg ? [prompt] : undefined,
      agentBindingPrompt: viaArg ? prompt : undefined,
    })
    if (!viaArg) {
      try {
        this.manager.get(summary.id).onceQuiet(() => {
          try {
            this.manager.get(summary.id).sendline(prompt, { autoName: false })
          } catch {
            /* 会话可能已退出/被删 */
          }
        }, 5000)
      } catch {
        /* 会话可能已退出/被删 */
      }
    }
    return summary
  }

  /**
   * 看板会话交接：把本会话 transcript 写成交接档案，任选模板拉起新 agent 接手。
   * 活会话先 SIGTERM（transcript 在盘上，停不停都读得到；停是为了避免两个 agent 同时动工作区）。
   */
  sessionHandoff = (ctx: Context) =>
    guard(ctx, () => {
      const session = this.manager.get(ctx.params.id)
      const body = (ctx.request.body ?? {}) as { templateId?: string; name?: string }
      if (!body.templateId) throw new Error('templateId 不能为空')
      const template = this.templates.get(body.templateId)
      if (!template || !template.enabled) throw new Error('模板不存在或已停用')
      if (['zsh', 'bash', 'sh', 'fish'].includes(path.basename(template.command))) {
        throw new Error('shell 模板无法接续对话')
      }

      // 复用 transcript 端点的定位逻辑：claude 系直取 / agent 系自家落盘 / 包装器时间窗兜底
      let messages: TranscriptMessage[] = []
      const kind = agentKindOf(session.command)
      if (session.claudeSessionId) {
        const filePath = transcriptPath(session)
        if (filePath && fs.existsSync(filePath)) messages = readHistoryAllMessages(filePath)
      } else if (kind) {
        // 交接要全量：分页接口 before 分支只回最后一页（PAGE_MESSAGES 条），会丢前文
        messages = readAgentAllMessages(session, kind)
      } else {
        const tpl = this.templates.get(session.templateId)
        const home = tpl ? effectiveClaudeHome(tpl) : null
        const filePath = home ? locateClaudeTranscript(session, home) : null
        if (filePath && fs.existsSync(filePath)) messages = readHistoryAllMessages(filePath)
      }
      if (!messages.length) throw new Error('该会话没有可交接的内容（无对话记录）')

      if (session.isRunning) session.stop()

      const file = writeHandoffFile(
        { source: session.command.split('/').pop() ?? 'agent', project: 'session', id: session.id, title: body.name || session.name },
        messages
      )
      ok(ctx, this.spawnWithHandoff(template, file, session.name, { cwd: session.cwd, name: body.name || session.name }))
    })

  // ---- Phase 4：文件预览 ----

  /**
   * 附件上传：raw body 直收——客户端必须发 application/octet-stream（json/form 会被
   * app 级 bodyparser 先吞掉流，落盘变空文件），文件名在 query。落盘
   * data/uploads/<YYYY-MM-DD>/，返回绝对路径给前端回填输入框——
   * 手机/桌面把文件"递到 Mac 上"，agent 拿路径就能读。
   */
  fileUpload = async (ctx: Context) => {
    try {
      await this.fileUploadInner(ctx)
    } catch (err) {
      fail(ctx, 400, 'bad_request', err instanceof Error ? err.message : String(err))
    }
  }

  private fileUploadInner = async (ctx: Context) => {
    const rawName = typeof ctx.query.name === 'string' ? ctx.query.name : 'file'
    // 只取 basename 并清掉路径分隔符，防目录穿越；保留中文与常规标点
    const base = path.basename(rawName).replace(/[/\\:*?"<>|]/g, '_').slice(-120) || 'file'
    // 拖文件夹：reldir 携带相对目录（根名+子目录），按段 basename 化+清非法字符再 join，防穿越
    const rawRelDir = typeof ctx.query.reldir === 'string' ? ctx.query.reldir : ''
    const day = new Date()
    const dayDir = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    let dir = path.join(DATA_DIR, 'uploads', dayDir)
    if (rawRelDir) {
      // 显式丢弃 ".." 与空段——basename 化拦不住纯 ".." 段，path.join 会逃逸出 uploads/<day>/
      const segs = rawRelDir
        .split(/[/\\]+/)
        .map((s) => s.trim())
        .filter((s) => s !== '' && s !== '..')
        .map((s) => s.replace(/[/\\:*?"<>|]/g, '_').slice(-120))
      if (segs.length) dir = path.join(dir, ...segs)
    }
    fs.mkdirSync(dir, { recursive: true })
    // 重名加序号：报告.pdf → 报告-2.pdf
    let target = path.join(dir, base)
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem}-${i}${ext}`)
    const MAX = 200 * 1024 * 1024
    let size = 0
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(target)
      ctx.req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX) {
          ctx.req.destroy()
          out.destroy()
          fs.rmSync(target, { force: true })
          reject(new Error('文件超过 200MB 上限'))
        }
      })
      ctx.req.pipe(out)
      out.on('finish', resolve)
      out.on('error', reject)
      ctx.req.on('error', reject)
    })
    ok(ctx, { path: target, size })
  }

  /**
   * 语音转写：前端长按说话录的 16kHz 单声道 PCM wav（raw body，同 fileUpload）→
   * 落 data/voice/<日期>/ → 按引擎转写 → {text, engine}。
   * engine 默认 config.voice.engine，前端可在 query 覆盖；funasr/sensevoice/whisper 走本地
   * python（scripts/voice-transcribe.py），aliyun 走云端 dashscope。转写完即删临时录音。
   */
  voiceTranscribe = async (ctx: Context) => {
    let wavPath = ''
    try {
      const engine = (typeof ctx.query.engine === 'string' ? ctx.query.engine : '').trim() || this.config.voice?.engine || 'funasr'
      const hotwords = typeof ctx.query.hotwords === 'string' ? ctx.query.hotwords : ''
      const day = new Date()
      const dayDir = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      const dir = path.join(DATA_DIR, 'voice', dayDir)
      fs.mkdirSync(dir, { recursive: true })
      wavPath = path.join(dir, `${crypto.randomUUID()}.wav`)
      const MAX = 20 * 1024 * 1024 // 20MB ≈ 16k 单声道 10 分钟，足够一段语音指令
      let size = 0
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(wavPath)
        ctx.req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX) {
            ctx.req.destroy()
            out.destroy()
            reject(new Error('录音超过 20MB 上限'))
          }
        })
        ctx.req.pipe(out)
        out.on('finish', resolve)
        out.on('error', reject)
        ctx.req.on('error', reject)
      })
      const result = await transcribe(engine, wavPath, {
        hotwords,
        python: this.config.voice?.python,
        aliyunApiKey: this.config.voice?.aliyunApiKey,
      })
      ok(ctx, result)
    } catch (err) {
      fail(ctx, 400, 'bad_request', err instanceof Error ? err.message : String(err))
    } finally {
      // 第一版不做录音回放/纠错：转写完即清自己生成的临时录音（非用户文件）
      if (wavPath) fs.rm(wavPath, { force: true }, () => {})
    }
  }

  /**
   * 拖入文件夹 → 定位源路径：浏览器安全限制拿不到拖放对象的磁盘路径，前端只报目录名 +
   * 首层若干子项名；这里用 Spotlight（mdfind）按名列候选、核验子项存在，命中即回源目录
   * 绝对路径。零上传零复制（agent 在本机直读源目录），空文件夹、iCloud 未下载占位一样秒回。
   */
  fileLocateDir = async (ctx: Context) => {
    const body = (ctx.request.body ?? {}) as { name?: unknown; samples?: unknown }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || /[/\\]/.test(name) || name.length > 255) {
      return fail(ctx, 400, 'bad_request', 'name 须为不含路径分隔符的目录名')
    }
    const samples = (Array.isArray(body.samples) ? body.samples : [])
      .filter((s): s is string => typeof s === 'string')
      .map((s) => path.basename(s.trim()))
      .filter((s) => s && s !== '.' && s !== '..')
      .slice(0, 5)
    // -name 走显示名分词匹配，CJK/全角括号偶有漏检；零命中再退 kMDItemFSName 精确查询
    const queries: string[][] = [
      ['-name', name],
      [`kMDItemFSName == "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`],
    ]
    const nfcName = name.normalize('NFC') // mdfind 回的是磁盘 NFD 形式，两边归一才可比
    let found: string[] = []
    for (const args of queries) {
      let lines: string[] = []
      try {
        const { stdout } = await execFileAsync('mdfind', args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
        lines = stdout.split('\n').filter(Boolean)
      } catch {
        // Spotlight 不可用/超时：按未命中处理，前端会提示改粘路径
      }
      found = lines
        .filter((p) => path.basename(p).normalize('NFC') === nfcName)
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory()
          } catch {
            return false
          }
        })
        .filter((p) => samples.every((s) => fs.existsSync(path.join(p, s))))
      if (found.length) break
    }
    // data/uploads 里的历史上传副本不是答案（旧版拖文件夹曾整包复制过去，用户要的是源目录）：
    // 有真源目录就整个剔除；全是副本才保留兜底（用户真从 uploads 里拖的场景）
    const uploadsRoot = path.join(DATA_DIR, 'uploads') + path.sep
    const nonCopies = found.filter((p) => !p.startsWith(uploadsRoot))
    if (nonCopies.length) found = nonCopies
    // 同名多处：可见路径优先（藏在 .backups 等点目录里的排后），再短路径优先
    const hidden = (p: string) => (p.split('/').some((seg) => seg.startsWith('.')) ? 1 : 0)
    found.sort((a, b) => hidden(a) - hidden(b) || a.length - b.length)
    ok(ctx, { paths: found.slice(0, 8) })
  }

  fileMeta = (ctx: Context) =>
    guard(ctx, () => {
      const p = typeof ctx.query.path === 'string' ? ctx.query.path : ''
      ok(ctx, this.files.meta(p))
    })

  /** 原始文件流：图片/pdf/html/文本/视频直传（视频支持 Range）；as=pdf 时办公文档现转 */
  fileRaw = async (ctx: Context) => {
    const p = typeof ctx.query.path === 'string' ? ctx.query.path : ''
    const asPdf = ctx.query.as === 'pdf'
    const download = ctx.query.download === '1'
    let real: string
    let mime: string
    let filename: string
    try {
      if (asPdf) {
        real = await this.files.toPdf(p)
        mime = 'application/pdf'
        filename = path.basename(this.files.meta(p).name, path.extname(p)) + '.pdf'
      } else {
        const meta = this.files.meta(p)
        real = meta.path
        mime = meta.mimeType
        filename = meta.name
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const { status, code } = statusFor(message)
      fail(ctx, status, code, message)
      return
    }

    const st = fs.statSync(real)
    if (st.size > this.files.maxRawBytes) {
      fail(ctx, 413, 'too_large', '文件过大')
      return
    }
    ctx.type = mime
    // HTML 走 sandbox iframe 渲染，加 CSP 兜底；非预览类型强制下载
    if (mime === 'text/html') ctx.set('content-security-policy', "sandbox allow-scripts allow-popups; default-src 'self' data: blob:")
    ctx.set('content-disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`)
    ctx.set('accept-ranges', 'bytes')
    ctx.set('cache-control', 'private, max-age=60')

    // Range 支持（iOS Safari 播视频必需）
    const range = ctx.headers.range
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (m) {
        let start = m[1] ? Number(m[1]) : 0
        let end = m[2] ? Number(m[2]) : st.size - 1
        // suffix 形态 bytes=-N：取末尾 N 字节（不是前 N 字节）
        if (!m[1] && m[2]) {
          start = Math.max(0, st.size - Number(m[2]))
          end = st.size - 1
        }
        if (start <= end && start < st.size) {
          const safeEnd = Math.min(end, st.size - 1)
          ctx.status = 206
          ctx.set('content-range', `bytes ${start}-${safeEnd}/${st.size}`)
          ctx.length = safeEnd - start + 1
          ctx.body = fs.createReadStream(real, { start, end: safeEnd })
          return
        }
        // start 越界等无法满足的 Range：回 416 而不是静默 200 全量
        ctx.set('content-range', `bytes */${st.size}`)
        fail(ctx, 416, 'range_not_satisfiable', 'Range 超出文件大小')
        return
      }
    }
    ctx.length = st.size
    ctx.body = fs.createReadStream(real)
  }

  stats = (ctx: Context) => {
    const startOfToday = new Date().setHours(0, 0, 0, 0)
    const sessions = this.manager.list()
    const todays = sessions.filter(
      (s) =>
        s.status === 'running' ||
        s.status === 'spawning' ||
        (s.createdAt ?? 0) >= startOfToday ||
        (s.exitedAt ?? 0) >= startOfToday
    )
    const now = Date.now()
    const summary: StatsSummary = {
      totalSessions: sessions.length,
      runningSessions: sessions.filter((s) => s.status === 'running' || s.status === 'spawning').length,
      todayPromptCount: todays.reduce((sum, s) => sum + (s.promptCount ?? 0), 0),
      todayOutputChars: todays.reduce((sum, s) => sum + (s.outputChars ?? 0), 0),
      todayRuntimeMs: todays.reduce((sum, s) => {
        if (!s.startedAt) return sum
        // 跨天会话只累计与今日相交的部分（昨天启动的会话别把全程时长算进今天）
        const from = Math.max(s.startedAt, startOfToday)
        return sum + Math.max(0, (s.exitedAt ?? now) - from)
      }, 0),
    }
    ok(ctx, summary)
  }
}
