// /api/rooms/* 控制器：项目协作项目 CRUD + 成员管理 + 消息收发。
// 独立文件（不进 controllers/api.ts）：参数校验 + service 调用 + 统一 {ok,data|error} 响应。
import path from 'node:path'
import type { Context } from 'koa'
import type { RoomMessage, RoomInfo } from '../../../shared/protocol'
import type { SessionManager } from '../services/session-manager'
import type { TemplateStore } from '../services/templates'
import type { RoomStore } from '../services/rooms'
import type { RoomRelay } from '../services/room-relay'
import * as projectDb from '../services/project-db'
import { mergeCheck as wtMergeCheck } from '../services/worktree'
import { effectiveClaudeHome } from '../services/templates'
import { MSG_CLI_PATH } from '../config'
import type { ProjectFileService } from '../services/project-files'

/** 回执 CLI 绝对路径（下发给前端「邀请」提示，与 room-relay 注入文案同源） */
const MSG_CLI = MSG_CLI_PATH

function ok(ctx: Context, data: unknown) {
  ctx.body = { ok: true, data }
}

function guard(ctx: Context, fn: () => void) {
  try {
    fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.status = message.includes('不存在') ? 404 : 400
    ctx.body = { ok: false, error: { code: ctx.status === 404 ? 'not_found' : 'bad_request', message } }
  }
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])

export class RoomControllers {
  constructor(
    private rooms: RoomStore,
    private relay: RoomRelay,
    private manager: SessionManager,
    private templates: TemplateStore,
    private projectFiles: ProjectFileService
  ) {}

  list = (ctx: Context) =>
    guard(ctx, () =>
      ok(ctx, { rooms: this.relay.roomsWithActivity(), humanName: this.rooms.humanName, msgCli: MSG_CLI, archiveSupported: true })
    )

  create = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { name?: string }
      const room = this.rooms.create(body.name ?? '')
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  remove = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      // 级联删除房内会话（维护者 2026-07-22）：主边界 = roomId 强归属（项目内 spawn 的专属会话随项目走）。
      // legacy 兜底 = 无归属字段的旧成员会话、且未挂在其它项目 members（多房共享的保留，免误删）。
      // 解冲突会话（resolveConflict spawn、不进 members 也不绑 roomId）与已移出项目的会话不在边界内，属可接受残留。
      const elsewhere = new Set(
        this.rooms
          .list()
          .filter((r) => r.id !== room.id)
          .flatMap((r) => r.members.map((m) => m.sessionId))
      )
      const summaries = this.manager.list()
      const bound = summaries.filter((s) => s.roomId === room.id).map((s) => s.id)
      const existing = new Set(summaries.map((s) => s.id))
      const legacy = room.members
        .map((m) => (m.kind === 'session' ? m.sessionId : null))
        .filter((id): id is string => !!id && !elsewhere.has(id) && existing.has(id) && !bound.includes(id))
        .filter((id) => !summaries.find((s) => s.id === id)?.roomId)
      const cascade = [...bound, ...legacy]
      this.rooms.remove(room.id)
      // 运行中会话 remove 走"先停后删"（exit 事件再清理），此处调用即返回，清理异步完成
      for (const id of cascade) this.manager.remove(id)
      this.relay.broadcastRooms()
      ok(ctx, { removed: room.id, removedSessions: cascade })
    })

  archive = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.archive(ctx.params.id)
      this.setMemberSessionsArchived(room, true)
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  unarchive = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.unarchive(ctx.params.id)
      this.setMemberSessionsArchived(room, false)
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  /** 项目归档/恢复联动成员会话：归档项目时把房内会话一并归档，避免散回看板；
   *  恢复时一并取消归档，项目回来成员也回来。成员快照可能引用已删除会话，按现存会话过滤 */
  private setMemberSessionsArchived(room: RoomInfo, archived: boolean) {
    const existing = new Set(this.manager.list().map((s) => s.id))
    for (const m of room.members) {
      if (m.kind !== 'session' || !m.sessionId || !existing.has(m.sessionId)) continue
      this.manager.setArchived(m.sessionId, archived)
    }
  }

  /** 加成员：{templateId} —— 项目内现场 spawn 专属新会话（roomId 强归属，删项目级联删）并登记进 members。
   *  2026-07-22 收窄（维护者）：不再支持拉已有运行中会话进项目（上下文不统一），统一开新会话 */
  addMember = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      const body = (ctx.request.body ?? {}) as { templateId?: string }
      const template = this.templates.get(body.templateId ?? '')
      if (!template || !template.enabled) throw new Error('模板不存在或已停用')
      if (SHELLS.has(path.basename(template.command))) throw new Error('shell 模板不能进项目（没有 agent 可回话）')
      // 先校验后 spawn：归档项目 addMember 必抛，不能让 spawn 先发生留下孤儿会话
      if (room.archivedAt !== null) throw new Error(`项目「${room.name}」已归档，只能查看或恢复`)
      const summary = this.manager.spawn(template.id, { roomId: room.id })
      const member = this.rooms.addMember(room.id, { name: template.name, kind: 'session', sessionId: summary.id })
      this.relay.broadcastRooms()
      ok(ctx, member)
    })

  removeMember = (ctx: Context) =>
    guard(ctx, () => {
      // @koa/router 已对 path 参数解码一次，再 decodeURIComponent 会在成员名含 % 时
      // 抛 URIError 或解成别的名字 —— 直接用 ctx.params.name
      const room = this.rooms.get(ctx.params.id)
      const member = room.members.find((m) => m.name === ctx.params.name)
      this.rooms.removeMember(room.id, ctx.params.name)
      // 移出项目即解绑：专属会话不再随项目级联删除（会话不存在时 unbindRoom 静默跳过）
      if (member?.kind === 'session' && member.sessionId) this.manager.unbindRoom(member.sessionId, room.id)
      this.relay.broadcastRooms()
      ok(ctx, { removed: ctx.params.name })
    })

  /** 项目消息流：project-db history 映射；limit 默认 100、上限 500（「加载更多」前端翻倍重拉） */
  messages = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      const limit = Math.min(500, Math.max(1, Number(ctx.query.limit ?? 100) || 100))
      const list: RoomMessage[] = projectDb
        .history(room.team, limit)
        .map((m) => ({ id: m.id, roomId: room.id, from: m.from, to: m.to, body: m.body, createdAt: m.createdAt }))
      ok(ctx, list)
    })

  /** 跨项目搜消息正文：?q=关键词 [&limit=50]，命中按 id 倒序，带 roomId/roomName 便于前端跳转 */
  search = (ctx: Context) =>
    guard(ctx, () => {
      const q = String(ctx.query.q ?? '').trim()
      const limit = Math.min(200, Math.max(1, Number(ctx.query.limit ?? 50) || 50))
      if (!q) {
        ok(ctx, [])
        return
      }
      const teamToRoom = new Map(this.rooms.list().map((r) => [r.team, r]))
      const result = projectDb.search(q, limit).map((m) => {
        const room = teamToRoom.get(m.team)
        return {
          id: m.id,
          roomId: room?.id ?? '',
          roomName: room?.name ?? m.team,
          archived: room ? typeof room.archivedAt === 'number' : true,
          from: m.from,
          to: m.to,
          body: m.body,
          createdAt: m.createdAt,
        }
      })
      ok(ctx, result)
    })

  /** 发消息：固定人类身份（面板就是人的嘴）；落库 + 广播 + @mention 投递由 relay 完成 */
  send = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { body?: string }
      ok(ctx, this.relay.postMessage(ctx.params.id, this.rooms.humanName, body.body ?? ''))
    })

  /** 房间调度列表（含各 delivery）：项目页可见当前轮到谁/状态/超时/取消原因 */
  listDispatches = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      ok(ctx, projectDb.listDispatches(room.team))
    })

  /** 切调度模式：{mode: 'parallel'|'serial'|'claim'}——parallel=全员即注；serial=串行轮转；claim=认领制先到先得 */
  setMode = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { mode?: 'parallel' | 'serial' | 'claim' }
      const room = this.rooms.setDispatchMode(ctx.params.id, body.mode as 'parallel' | 'serial' | 'claim')
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  /** 绑定/解绑 git 仓库：{repoPath: string|null}——claim 赢家获批时自动开工作区；绑定时校验真是 git 仓 */
  setRepo = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { repoPath?: string | null }
      const room = this.rooms.setRepoPath(ctx.params.id, body.repoPath ?? null)
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  /** 显式绑定项目/案件根目录，不从任何成员 cwd 推断。 */
  setRoot = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { rootPath?: string | null }
      const requested = body.rootPath?.trim() || null
      const canonical = requested ? this.projectFiles.bindRoot(requested) : null
      const room = this.rooms.setRootPath(ctx.params.id, canonical)
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  /** 项目只读 Files：无 q 时列一个目录；有 q 时在项目根内受限递归搜索。 */
  files = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      if (!room.rootPath) throw new Error('本项目尚未绑定文件根目录')
      const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
      const dir = typeof ctx.query.dir === 'string' ? ctx.query.dir : ''
      ok(ctx, q.trim() ? this.projectFiles.search(room.rootPath, q) : this.projectFiles.list(room.rootPath, dir))
    })

  /** 取消 dispatch：{reason?}——active→cancelled，剩余 queued 全 cancelled */
  cancelDispatch = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { reason?: string }
      const dispatchId = Number(ctx.params.dispatchId)
      this.relay.cancelDispatch(ctx.params.id, dispatchId, body.reason)
      ok(ctx, { cancelled: dispatchId })
    })

  /**
   * 合并干跑预检：git merge-tree --write-tree（不动任何工作区/分支/索引，只写不可达 tree 对象）。
   * 返回 {clean, conflicts, message}；dispatch 无分支（未绑 repo / 工作区创建失败）时 400。
   */
  mergeCheck = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      const d = projectDb.dispatchById(Number(ctx.params.dispatchId))
      if (!d || d.team !== room.team) throw new Error(`调度 ${ctx.params.dispatchId} 不存在`)
      if (!room.repoPath) throw new Error('本项目未绑定 git 仓库')
      if (!d.branch) throw new Error('该调度没有分支（尚未认领或工作区创建失败）')
      ok(ctx, wtMergeCheck(room.repoPath, d.branch))
    })

  /**
   * 派 agent 解冲突：{templateId}——先做 merge-check 拿冲突清单，
   * 在赢家工作区里 spawn 一个新会话并把冲突文件清单作为首条指令注入。
   */
  resolveConflict = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      const d = projectDb.dispatchById(Number(ctx.params.dispatchId))
      if (!d || d.team !== room.team) throw new Error(`调度 ${ctx.params.dispatchId} 不存在`)
      if (!room.repoPath || !d.branch || !d.worktreePath) throw new Error('该调度没有可解冲突的工作区')
      const body = (ctx.request.body ?? {}) as { templateId?: string }
      const template = this.templates.get(body.templateId ?? '')
      if (!template || !template.enabled) throw new Error('模板不存在或已停用')
      if (SHELLS.has(path.basename(template.command))) throw new Error('shell 模板无法解冲突')
      const check = wtMergeCheck(room.repoPath, d.branch)
      if (check.clean) {
        ok(ctx, { clean: true, conflicts: [], message: '已无可合并冲突，无需派单' })
        return
      }
      const prompt =
        `你是合并冲突解决专员。当前目录是分支 ${d.branch} 的工作区，它合并回主分支时与以下文件冲突：\n` +
        check.conflicts.map((f) => `- ${f}`).join('\n') +
        `\n请用 git merge-tree / git diff 分析两边改动，在保持本分支意图的前提下给出冲突解决方案` +
        `（优先直接在本分支上 rework 掉冲突点；不要执行合并进主分支，不要碰主检出 ${room.repoPath}）。`
      // claude 系/codex 支持启动参数带首条指令；其余 TUI 等首屏安静后注入（同 spawnWithHandoff 惯例）
      const viaArg = effectiveClaudeHome(template) !== null || path.basename(template.command) === 'codex'
      const summary = this.manager.spawn(template.id, {
        cwd: d.worktreePath,
        name: `解冲突 #${d.id}`,
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
      ok(ctx, { clean: false, conflicts: check.conflicts, sessionId: summary.id, message: `已派 ${summary.name} 到工作区解冲突` })
    })
}
