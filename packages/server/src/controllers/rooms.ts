// /api/rooms/* 控制器：项目协作项目 CRUD + 成员管理 + 消息收发。
// 独立文件（不进 controllers/api.ts）：参数校验 + service 调用 + 统一 {ok,data|error} 响应。
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from 'koa'
import type { RoomMessage, RoomInfo, RoomKind } from '../../../shared/protocol'
import type { SessionManager } from '../services/session-manager'
import type { TemplateStore } from '../services/templates'
import type { RoomStore } from '../services/rooms'
import { CHARTER_FILE } from '../services/rooms'
import * as catalog from '../services/project-catalog'
import type { RoomRelay } from '../services/room-relay'
import * as projectDb from '../services/project-db'
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

/** realpath 兜底：目标暂不可达（iCloud dataless 等）时按原路径比较，不炸请求 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** 建项目时在根目录脚手架驻留上下文骨架。只补缺，绝不覆盖已有文件（案件目录等已有 README/资料）。 */
function scaffoldCharter(root: string, name: string) {
  const file = path.join(root, CHARTER_FILE)
  if (fs.existsSync(file)) return
  const skeleton = `# 项目宪章：${name}

> 本文件是项目「${name}」的驻留上下文（SoT）。进驻的每个 agent：动手前先读完本文件；
> 做完实质动作把结论回写「工作纪要」。会话上下文会压缩、会丢，这个文件不会。

## 这个项目是什么

（一句话说清此域的范围与目标——建项目后尽快补上）

## SoT 与关键路径

- 项目根：${root}

## 行为约定

- 重要结论/进展回写本文件「工作纪要」节，新条目在最上面、带日期。
- 其余照全局章程执行。

## 工作纪要

（暂无）
`
  fs.writeFileSync(file, skeleton, 'utf8')
}

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
      const body = (ctx.request.body ?? {}) as { name?: string; kind?: string; rootPath?: string }
      const kind: RoomKind = body.kind === 'project' ? 'project' : 'task'
      // 项目必须绑根目录（驻留上下文的落点）；用与 setRoot 同一条校验路（realpath + 存在性）
      const requested = body.rootPath?.trim() || null
      const canonical = requested ? this.projectFiles.bindRoot(requested) : null
      const room = this.rooms.create(body.name ?? '', kind, canonical)
      if (room.kind === 'project' && room.rootPath) scaffoldCharter(room.rootPath, room.name)
      this.relay.broadcastRooms()
      ok(ctx, room)
    })

  remove = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      // 级联删除房内会话（维护者 2026-07-22）：主边界 = roomId 强归属（项目内 spawn 的专属会话随项目走）。
      // legacy 兜底 = 无归属字段的旧成员会话、且未挂在其它项目 members（多房共享的保留，免误删）。
      // 已移出项目的会话不在边界内，属可接受残留。
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

  /** 加成员：{templateId, cwd?} —— 项目内现场 spawn 专属新会话（roomId 强归属，删项目级联删）并登记进 members。
   *  2026-07-22 收窄（维护者）：不再支持拉已有运行中会话进项目（上下文不统一），统一开新会话
   *
   *  cwd（2026-07-26 加）：本次会话的工作目录，覆盖模板的固定 cwd。
   *  加它是为了解开编排层的死结——StandCode 要给并行 agent 各分一个 git worktree 做文件隔离，
   *  而此前这条路只收 templateId，cwd 只能来自模板（所有会话共用一个目录），
   *  于是「隔离」在编排层是空壳（StandCode 的 prepare_workspace 一直硬编码 applied:false）。
   *  下游早就支持了：SessionManager.spawn 有 cwd 参数、buildSpawnSpec 也优先用它，
   *  POST /api/sessions 也一直在传 —— 只有房间成员这条路把它丢了。
   *  目录不存在时 buildSpawnSpec 会抛（不静默回落 $HOME），否则隔离就是假的。 */
  addMember = (ctx: Context) =>
    guard(ctx, () => {
      const room = this.rooms.get(ctx.params.id)
      const body = (ctx.request.body ?? {}) as { templateId?: string; cwd?: string }
      const template = this.templates.get(body.templateId ?? '')
      if (!template || !template.enabled) throw new Error('模板不存在或已停用')
      if (SHELLS.has(path.basename(template.command))) throw new Error('shell 模板不能进项目（没有 agent 可回话）')
      // 先校验后 spawn：归档项目 addMember 必抛，不能让 spawn 先发生留下孤儿会话
      if (room.archivedAt !== null) throw new Error(`项目「${room.name}」已归档，只能查看或恢复`)
      // 项目房间成员默认驻进项目根：claude 系 CLI 会原生自动加载该目录的 CLAUDE.md 链，
      // 文件工具也天然落在域内；显式传 cwd（如 StandCode worktree 隔离）仍优先。
      const cwd = body.cwd?.trim() || (room.kind === 'project' ? (room.rootPath ?? undefined) : undefined)
      const summary = this.manager.spawn(template.id, { roomId: room.id, cwd })
      const member = this.rooms.addMember(room.id, {
        name: template.name,
        kind: 'session',
        sessionId: summary.id,
        templateId: template.id, // 落绑定模板 id：后续会话被别的模板接手时 relay 据此校正回执署名（2026-07-29）
      })
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

  /** 项目目录册：分组标题 → 组内每文件夹一栏（2026-07-27 维护者定：房间不按大类建，按具体文件夹按需开） */
  catalog = (ctx: Context) =>
    guard(ctx, () => {
      ok(ctx, { configured: catalog.catalogConfigured(), groups: catalog.listCatalog(this.rooms.list()) })
    })

  /** 新建分组 {label}；成员靠入组/出组维护（纯手动组无 roots） */
  createGroup = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { label?: string }
      const g = catalog.createGroup(body.label ?? '')
      ok(ctx, { id: g.id, label: g.label })
    })

  /** 重命名分组 {label}（id 稳定不变） */
  renameGroup = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { label?: string }
      const g = catalog.renameGroup(ctx.params.id, body.label ?? '')
      ok(ctx, { id: g.id, label: g.label })
    })

  /** 入组 {path}：把文件夹加进分组（只动目录册归属，不建房不动文件） */
  addGroupMember = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { path?: string }
      catalog.addMember(ctx.params.id, body.path ?? '')
      ok(ctx, { added: body.path })
    })

  /** 出组 {path}：把文件夹移出分组（不删文件夹、不删已开的房间） */
  removeGroupMember = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { path?: string }
      catalog.removeMember(ctx.params.id, body.path ?? '')
      ok(ctx, { removed: body.path })
    })

  /** 按文件夹幂等开项目房：已有（rootPath realpath 相同）直接返回，没有则以文件夹名创建。
   *  重名（不同文件夹同名，如在办与已归档各有一个"张三咨询"）自动 ·2 后缀，与成员重名同法。 */
  openProject = (ctx: Context) =>
    guard(ctx, () => {
      const body = (ctx.request.body ?? {}) as { path?: string }
      const requested = body.path?.trim()
      if (!requested) throw new Error('缺少文件夹路径')
      const canonical = this.projectFiles.bindRoot(requested)
      const canonicalReal = realpathSafe(canonical)
      const existing = this.rooms
        .list()
        .find((r) => r.kind === 'project' && r.rootPath && realpathSafe(r.rootPath) === canonicalReal)
      if (existing) {
        ok(ctx, existing)
        return
      }
      const base = path.basename(canonical)
      let room: RoomInfo | null = null
      for (let n = 1; n <= 9 && !room; n++) {
        const name = n === 1 ? base : `${base}·${n}`
        try {
          room = this.rooms.create(name, 'project', canonical)
        } catch (err) {
          if (!(err instanceof Error) || !err.message.includes('已存在')) throw err
        }
      }
      if (!room) throw new Error(`同名项目过多，无法为「${base}」自动起名`)
      scaffoldCharter(canonical, room.name)
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
}
