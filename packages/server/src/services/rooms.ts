// 项目协作元数据：data/rooms.json（原子写，与 persistence 同惯例）。
// 消息不在这里——SoT 是项目消息库（project-db.ts，data/projects.db）；
// 成员名单在此（房间=team）。本文件只管"项目有哪些、谁在项目里"。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { RoomInfo, RoomKind, RoomMember } from '../../../shared/protocol'
import { DATA_DIR } from '../config'
import { createLogger } from '../logger'

const log = createLogger('rooms')

const ROOMS_PATH = path.join(DATA_DIR, 'rooms.json')

/** 报错文案按房间类型措辞（任务/项目两个 tab 共用同一套存储与接口） */
export const KIND_LABEL: Record<RoomKind, string> = { task: '任务', project: '项目' }

/** 项目驻留上下文文件名（rootPath 下）：建项目时脚手架、投递简报指路、成员回写，三处同源 */
export const CHARTER_FILE = 'PROJECT.md'

/** 人类成员默认名（config.humanName 可覆盖；@mention 与花名册身份） */
export const DEFAULT_HUMAN_NAME = 'Owner'
/** 广播保留字：@all = 房内全部会话成员 */
export const ALL_MENTION = 'all'

function atomicWrite(filePath: string, content: string) {
  const tmp = filePath + '.tmp'
  // rename 前 fsync：原先只 write+rename，掉电可能留下一个**已改名但内容截断**的
  // rooms.json —— 正好是下面 load() 解析失败那条路的触发条件。
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
}

/**
 * 从消息正文解析 @mention：成员名可含空格（模板名如「Claude Code (Fable5)」），
 * 所以按"在每个 @ 位置做成员名最长前缀匹配"，而不是按空白切词。
 * @all（大小写不敏感）是保留字，不匹配任何成员名。
 */
export function parseMentions(body: string, members: RoomMember[]): { targets: string[]; all: boolean } {
  const names = members.map((m) => m.name).sort((a, b) => b.length - a.length)
  const targets: string[] = []
  let all = false
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue
    // 中文里自然写法常是“你看下@某人”，不能要求 @ 前必须有空格；只拦截 ASCII
    // 标识符/邮箱/路径内部的 @（dev@example、foo/@bar），其它文字和标点后都视为 mention。
    if (i > 0 && /[A-Za-z0-9._%+\-/]/.test(body[i - 1])) continue
    const rest = body.slice(i + 1)
    if (!all && rest.toLowerCase().startsWith(ALL_MENTION)) {
      const next = rest[ALL_MENTION.length]
      if (next === undefined || /[\s，。；：、,.!！?？]/.test(next)) {
        all = true
        continue
      }
    }
    const hit = names.find((n) => rest.startsWith(n))
    if (hit && !targets.includes(hit)) targets.push(hit)
  }
  return { targets, all }
}

export class RoomStore {
  private rooms: RoomInfo[]
  readonly humanName: string
  /** load 失败过 → 拒绝写盘（否则会把空名单盖到好数据上，见 load/save 注释） */
  private loadFailed = false

  constructor(humanName: string = DEFAULT_HUMAN_NAME) {
    this.humanName = humanName
    this.rooms = this.load()
  }

  private load(): RoomInfo[] {
    try {
      if (!fs.existsSync(ROOMS_PATH)) return []
      const parsed = JSON.parse(fs.readFileSync(ROOMS_PATH, 'utf8'))
      if (!Array.isArray(parsed)) {
        this.quarantine(new Error('rooms.json 顶层不是数组'))
        return []
      }
      // 旧 rooms.json 没有 archivedAt：读取时补 null，下一次保存自然完成迁移。
      // 旧 rooms.json 同样没有 dispatchMode：补 'serial'（当前默认），迁移方式同 archivedAt。
      // rootPath（项目 Files 根）缺省补 null，同上。
      // kind（2026-07-26 项目/任务分家）缺省补 'task'：既有房间全是任务，项目须显式创建。
      return (parsed as Partial<RoomInfo>[]).map((room) => ({
        ...(room as RoomInfo),
        kind: room.kind === 'project' ? 'project' : 'task',
        archivedAt: typeof room.archivedAt === 'number' ? room.archivedAt : null,
        // claim 调度模式已砍掉（2026-07-25），旧 rooms.json 里残留的 'claim' 视为默认 'serial'
        dispatchMode: room.dispatchMode === 'parallel' ? 'parallel' : 'serial',
        rootPath: typeof room.rootPath === 'string' && room.rootPath ? room.rootPath : null,
      }))
    } catch (err) {
      this.quarantine(err)
      return []
    }
  }

  /**
   * 读坏了：留证 + 上闸。
   *
   * 原先只 log.error 然后返回 []，而 save() 会把这个 [] 原样写回去 —— 一次 JSON 解析
   * 失败就把 39 个项目、73 个成员绑定**永久抹掉**，且看起来只是「项目列表空了」。
   * 现在把坏文件改名留证，并置 loadFailed 让 save() 拒写，等人来处理。
   */
  private quarantine(err: unknown) {
    log.error('rooms.json 读取失败 —— 已拒绝后续写入，避免空名单覆盖好数据', err)
    this.loadFailed = true
    try {
      const bak = `${ROOMS_PATH}.corrupt-${Date.now()}`
      fs.renameSync(ROOMS_PATH, bak)
      log.error(`坏文件已留证：${bak}（修好后改回 rooms.json 并重启）`)
      // 留证成功 = 原文件已不在，之后写的是全新文件，不会覆盖任何东西 → 解除闸
      this.loadFailed = false
    } catch (e) {
      log.error('坏文件留证失败，写入闸保持关闭', e)
    }
  }

  private save() {
    if (this.loadFailed) {
      log.error('rooms.json 曾读取失败且未能留证，拒绝写入（防止空名单覆盖好数据）')
      return
    }
    try {
      fs.mkdirSync(path.dirname(ROOMS_PATH), { recursive: true })
      atomicWrite(ROOMS_PATH, JSON.stringify(this.rooms, null, 2) + '\n')
    } catch (err) {
      log.error('rooms.json 写入失败', err)
    }
  }

  list(): RoomInfo[] {
    return this.rooms
  }

  get(id: string): RoomInfo {
    const room = this.rooms.find((r) => r.id === id)
    if (!room) throw new Error(`项目不存在: ${id}`)
    return room
  }

  create(name: string, kind: RoomKind = 'task', rootPath: string | null = null): RoomInfo {
    const trimmed = name.trim()
    if (!trimmed) throw new Error(`${KIND_LABEL[kind]}名不能为空`)
    if (this.rooms.some((r) => r.name === trimmed)) throw new Error(`「${trimmed}」已存在`)
    // 项目 = 驻扎在文件夹里的常驻域，没有根目录就没有 PROJECT.md 落点，直接拦下
    if (kind === 'project' && !rootPath) throw new Error('项目必须绑定根目录（驻留上下文 PROJECT.md 的落点）')
    const id = crypto.randomUUID().slice(0, 8)
    const room: RoomInfo = {
      id,
      name: trimmed,
      team: `room-${id}`,
      kind,
      createdAt: Date.now(),
      archivedAt: null,
      dispatchMode: 'serial', // 默认串行轮转（2026-07-22 调转）：一次只放行一位成员
      rootPath,
      members: [{ name: this.humanName, kind: 'human', sessionId: null }],
    }
    this.rooms.push(room)
    this.save()
    return room
  }

  remove(id: string) {
    const i = this.rooms.findIndex((r) => r.id === id)
    if (i < 0) throw new Error(`项目不存在: ${id}`)
    this.rooms.splice(i, 1)
    this.save()
    // 消息历史故意保留在消息库（team 名即项目 id，重建项目不占名）；
    // 成员会话的级联删除在 controller 层（RoomControllers.remove），本类只管项目元数据。
  }

  archive(id: string): RoomInfo {
    const room = this.get(id)
    if (room.archivedAt === null) {
      room.archivedAt = Date.now()
      this.save()
    }
    return room
  }

  unarchive(id: string): RoomInfo {
    const room = this.get(id)
    if (room.archivedAt !== null) {
      room.archivedAt = null
      this.save()
    }
    return room
  }

  private assertActive(room: RoomInfo) {
    if (room.archivedAt !== null) throw new Error(`项目「${room.name}」已归档，只能查看或恢复`)
  }

  /** 切调度模式：parallel=全员即注；serial=串行轮转一次只放行一位（默认） */
  setDispatchMode(id: string, mode: 'parallel' | 'serial'): RoomInfo {
    const room = this.get(id)
    this.assertActive(room)
    if (mode !== 'parallel' && mode !== 'serial') throw new Error('调度模式只能是 parallel 或 serial')
    if (room.dispatchMode !== mode) {
      room.dispatchMode = mode
      this.save()
    }
    return room
  }

  /** 路径校验由 controller 的 ProjectFileService 先完成；这里只持久化 canonical root。 */
  setRootPath(id: string, rootPath: string | null): RoomInfo {
    const room = this.get(id)
    this.assertActive(room)
    const trimmed = rootPath?.trim() || null
    if (room.rootPath !== trimmed) {
      room.rootPath = trimmed
      this.save()
    }
    return room
  }

  /** 加成员：baseName 重名自动加 ·2 后缀；返回最终成员 */
  addMember(id: string, member: Omit<RoomMember, 'name'> & { name: string }): RoomMember {
    const room = this.get(id)
    this.assertActive(room)
    if (member.kind === 'session' && member.sessionId && room.members.some((m) => m.sessionId === member.sessionId)) {
      throw new Error('该会话已在项目里')
    }
    let name = member.name.trim()
    if (!name) throw new Error('成员名不能为空')
    if (name.toLowerCase() === ALL_MENTION) throw new Error(`「${ALL_MENTION}」是广播保留字，不能作成员名`)
    const taken = new Set(room.members.map((m) => m.name))
    if (taken.has(name)) {
      let n = 2
      while (taken.has(`${name}·${n}`)) n++
      name = `${name}·${n}`
    }
    const final: RoomMember = { name, kind: member.kind, sessionId: member.sessionId }
    room.members.push(final)
    this.save()
    return final
  }

  removeMember(id: string, name: string) {
    const room = this.get(id)
    this.assertActive(room)
    const i = room.members.findIndex((m) => m.name === name)
    if (i < 0) throw new Error(`成员「${name}」不在项目里`)
    if (room.members[i].kind === 'human') throw new Error('不能移除人类成员')
    room.members.splice(i, 1)
    this.save()
  }
}
