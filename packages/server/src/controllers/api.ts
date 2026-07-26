// /api/* 控制器：参数校验 + service 调用 + 统一 {ok,data|error} 响应
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Context } from 'koa'
import type { ScreenTailPayload, StandCodeConfig, StatsSummary, Template, TranscriptMessage, TranscriptPage } from '../../../shared/protocol'
import type { SessionManager } from '../services/session-manager'
import type { TemplateStore } from '../services/templates'
import type { AppConfig } from '../config'
import { DATA_DIR, saveConfig } from '../config'
import { readTranscriptFile, transcriptPath } from '../services/transcript'
import { agentKindOf, locateClaudeLayoutTranscript, locateClaudeTranscript, parseQclaw, readAgentAllMessages, readAgentTranscript } from '../services/agent-transcript'
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

const execFileAsync = promisify(execFile)

// StandCode caller.py 集成（任务管理 API）：
//   - 任务状态目录与 caller.py 的 STANDCODE_TASKS_DIR 同口径（默认 ~/.standcode/tasks）
//   - caller 脚本默认绝对路径 /Users/gao/Code/StandCode/caller/caller.py，可用 STANDCODE_CALLER 覆盖
const STANDCODE_TASKS_DIR = process.env.STANDCODE_TASKS_DIR || path.join(os.homedir(), '.standcode', 'tasks')
const STANDCODE_CALLER = process.env.STANDCODE_CALLER || '/Users/gao/Code/StandCode/caller/caller.py'

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
    })
  }

  /** GET /api/config/whitelist：返回模型白名单，供 agent 客户端发现允许的模型。
   *  只回 modelWhitelist——绝不回 apiKeys（那等于公开可用凭证）。 */
  whitelist = (ctx: Context) => ok(ctx, { modelWhitelist: this.config.modelWhitelist ?? [] })

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

  /** 更新运行参数（会话上限）：写回 config.json；同一 config 对象引用，SessionManager 即时生效，无需重启 */
  updateSettings = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as {
        maxSessions?: unknown
      }
      const out: Record<string, unknown> = {}
      if (body.maxSessions !== undefined) {
        const n = Number(body.maxSessions)
        if (!Number.isInteger(n) || n < 0) throw new Error('会话上限须为 ≥0 的整数（0 = 无上限）')
        this.config.server.maxSessions = n
        out.maxSessions = n
      }
      if (Object.keys(out).length === 0) throw new Error('未提供可更新字段（maxSessions）')
      saveConfig(this.config)
      ok(ctx, out)
    })

  /** GET /api/standcode/defaults：StandCode 角色默认模板（设置页编辑面；
   *  StandCode caller.py 启动时读它覆盖 registry.json 默认）。 */
  getStandcodeDefaults = (ctx: Context) => ok(ctx, this.config.standcode ?? {})

  /** PUT /api/standcode/defaults：逐角色设置/清除默认模板 id。写回 config.json 即时生效。
   *  空串 = 清除该角色（消费方回落 registry.json）；非空必须是已存在的模板 id
   *  （防写了不存在的 id，派发时才炸）。 */
  updateStandcodeDefaults = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as Partial<StandCodeConfig>
      const keys = ['caller', 'thinker', 'worker', 'fastWorker'] as const
      const provided = keys.filter((k) => body[k] !== undefined)
      if (!provided.length) throw new Error(`未提供可更新字段（${keys.join('/')}）`)
      const sc: StandCodeConfig = { ...(this.config.standcode ?? {}) }
      for (const k of provided) {
        const v = String(body[k] ?? '').trim()
        if (!v) delete sc[k]
        else {
          if (!this.templates.get(v)) throw new Error(`模板不存在: ${v}（角色 ${k}）`)
          sc[k] = v
        }
      }
      if (Object.keys(sc).length) this.config.standcode = sc
      else delete this.config.standcode
      saveConfig(this.config)
      ok(ctx, this.config.standcode ?? {})
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

  // 独立会话程序化注入（2026-07-26 #2wlt 高律师批）：给 roomId=None 的会话一个带审计的
  // REST 写入口。WS 直写仍是浏览器键盘专属（审计红线不动）——agent 侧注入一律走这里，
  // 每次落 data/session-input-audit.jsonl 一行（署名 + 文本前 120 字），比临时建房挂
  // relay 干净：不搅房间台账/自动归档/mention 语义，审计还是显式的。
  // body: { from: 必填署名, text, submit=true（sendline 安静窗补回车，过 permission
  // prompt 用 {text:"continue"} 或裸回车 {text:""}）, quiet=false（true 时 onceQuiet
  // 等输出安静 1.2s 再注入，busy 会话防插花） }
  sessionInput = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as {
        from?: string
        text?: string
        submit?: boolean
        quiet?: boolean
      }
      const from = String(body.from ?? '').trim()
      if (!from) throw new Error('from 不能为空（审计要求：注入必须署名）')
      const session = this.manager.get(ctx.params.id)
      if (session.status !== 'running' && session.status !== 'spawning') {
        throw new Error(`会话未在运行（status=${session.status}），拒绝注入`)
      }
      const text = String(body.text ?? '')
      const submit = body.submit !== false
      const quiet = Boolean(body.quiet)
      const doWrite = () => {
        try {
          if (submit) session.sendline(text, { autoName: false })
          else if (text) session.write(text)
        } catch {
          /* 会话可能在 quiet 等待期间退出；审计行已落，注入自然失效 */
        }
      }
      if (quiet) session.onceQuiet(doWrite)
      else doWrite()
      try {
        fs.appendFileSync(
          path.join(DATA_DIR, 'session-input-audit.jsonl'),
          JSON.stringify({
            ts: new Date().toISOString(),
            sessionId: session.id,
            sessionName: session.name,
            from,
            submit,
            quiet,
            text: text.slice(0, 120),
          }) + '\n',
        )
      } catch {
        /* 审计写失败不阻塞注入结果返回，但绝不静默：落服务日志 */
        console.error('[session-input] 审计行写入失败', session.id)
      }
      ok(ctx, {
        injected: true,
        sessionId: session.id,
        from,
        submit,
        quiet,
        textPreview: text.slice(0, 80),
      })
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
      } else if (session.transcriptDir) {
        // claude 布局衍生 CLI（qoder 等，模板 transcriptDir 声明/自动探测）：时间窗定位 + claude 解析
        filePath = locateClaudeLayoutTranscript(session, session.transcriptDir)
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

  /**
   * 拖入散文件 → 定位源路径（与 locate-dir 同一思路）：浏览器拿不到拖放文件的磁盘路径，
   * 前端报 文件名+字节数；这里用 Spotlight 按名找候选、核验字节数完全一致，命中即回源文件
   * 绝对路径——零上传零复制，agent 直读源文件。定位不到的前端退回上传副本（见 useFileDrop）。
   * 与 locate-dir 的差异：核验用 size 精确匹配（File.size 是精确字节数），散文件没有子项可采样。
   */
  fileLocateFiles = async (ctx: Context) => {
    const body = (ctx.request.body ?? {}) as { files?: unknown }
    const items = (Array.isArray(body.files) ? body.files : [])
      .map((f) => {
        const it = (f ?? {}) as { name?: unknown; size?: unknown }
        return {
          name: typeof it.name === 'string' ? it.name.trim() : '',
          size: typeof it.size === 'number' && Number.isFinite(it.size) && it.size >= 0 ? it.size : null,
        }
      })
      .filter((it) => it.name && !/[/\\]/.test(it.name) && it.name.length <= 255)
      .slice(0, 20)
    if (!items.length) return fail(ctx, 400, 'bad_request', 'files 须为 [{name,size}] 数组')

    const uploadsRoot = path.join(DATA_DIR, 'uploads') + path.sep
    const hidden = (p: string) => (p.split('/').some((seg) => seg.startsWith('.')) ? 1 : 0)
    const results: Array<{ name: string; size: number | null; paths: string[] }> = []
    for (const it of items) {
      const nfcName = it.name.normalize('NFC')
      const queries: string[][] = [
        ['-name', it.name],
        [`kMDItemFSName == "${it.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`],
      ]
      let found: string[] = []
      for (const args of queries) {
        let lines: string[] = []
        try {
          const { stdout } = await execFileAsync('mdfind', args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
          lines = stdout.split('\n').filter(Boolean)
        } catch {
          // Spotlight 不可用/超时：按未命中处理，前端退回上传
        }
        found = lines
          .filter((p) => path.basename(p).normalize('NFC') === nfcName)
          .filter((p) => {
            try {
              const st = fs.statSync(p)
              return st.isFile() && (it.size === null || st.size === it.size)
            } catch {
              return false
            }
          })
        if (found.length) break
      }
      // 同 locate-dir：有真源文件就剔除 data/uploads 里的历史副本；全是副本才保留兜底
      const nonCopies = found.filter((p) => !p.startsWith(uploadsRoot))
      if (nonCopies.length) found = nonCopies
      found.sort((a, b) => hidden(a) - hidden(b) || a.length - b.length)
      results.push({ name: it.name, size: it.size, paths: found.slice(0, 8) })
    }
    ok(ctx, { results })
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

  // ---- StandCode 任务管理（caller.py 后台任务）----

  /** 取 task state 的 created_at 为排序键（缺失/非法 → NaN，排末尾） */
  private static createdAtOf(t: Record<string, unknown>): number {
    const v = t.created_at
    return typeof v === 'string' ? Date.parse(v) : Number.NaN
  }

  /** GET /api/tasks：列出所有后台任务状态（读 caller.py 的 ~/.standcode/tasks/*.json，最新在前） */
  listTasks = (ctx: Context) => {
    const dir = STANDCODE_TASKS_DIR
    let names: string[]
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      // 目录不存在 = 还没有任务
      ok(ctx, { tasks: [], dir })
      return
    }
    const tasks: Record<string, unknown>[] = []
    for (const name of names) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        if (parsed && typeof parsed === 'object') tasks.push(parsed as Record<string, unknown>)
      } catch {
        // 损坏的 state 文件跳过（与 caller.py _cmd_list 同口径）
      }
    }
    tasks.sort((a, b) => {
      const ta = ApiControllers.createdAtOf(a)
      const tb = ApiControllers.createdAtOf(b)
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
      if (Number.isNaN(ta)) return 1
      if (Number.isNaN(tb)) return -1
      return tb - ta // created_at 倒序：最新在前
    })
    ok(ctx, { tasks, dir })
  }

  /** POST /api/tasks/submit：{request, role?, template?} → subprocess 调 caller.py run --bg，返回 task_id */
  submitTask = async (ctx: Context) => {
    const body = (ctx.request.body ?? {}) as { request?: unknown; role?: unknown; template?: unknown }
    const request = typeof body.request === 'string' ? body.request.trim() : ''
    if (!request) return fail(ctx, 400, 'bad_request', 'request 不能为空')
    const role = typeof body.role === 'string' ? body.role.trim() : ''
    if (role && role !== 'thinker' && role !== 'worker') {
      return fail(ctx, 400, 'bad_request', 'role 只能是 thinker 或 worker')
    }
    const template = typeof body.template === 'string' ? body.template.trim() : ''

    const callerPy = STANDCODE_CALLER
    if (!fs.existsSync(callerPy)) {
      return fail(ctx, 500, 'caller_missing', `caller.py 不存在：${callerPy}`)
    }
    // cwd = StandCode 根（caller/ 的父目录），命令即 python3 caller/caller.py run --bg
    const standRoot = path.dirname(path.dirname(callerPy))
    const args = ['caller/caller.py', 'run', '--bg', request]
    if (role) args.push('--role', role)
    if (template) args.push('--template', template)

    try {
      const { stdout } = await execFileAsync('python3', args, {
        cwd: standRoot,
        env: { ...process.env, HOME: os.homedir() },
        timeout: 30_000,
        maxBuffer: 1 * 1024 * 1024,
      })
      // caller.py --bg 首行 stdout = task_id（形如 bg-1784970123-bd5416）；取首个 ^bg- 行兜底首行
      const taskId =
        stdout
          .split('\n')
          .map((l) => l.trim())
          .find((l) => /^bg-/.test(l)) || stdout.trim().split('\n')[0] || ''
      ok(ctx, { task_id: taskId, submitted: true, stdout: stdout.trim() })
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string }
      const detail = (e.stderr || e.stdout || e.message || '').toString().slice(-800)
      fail(ctx, 500, 'caller_failed', `caller.py 调用失败：${detail}`)
    }
  }
}
