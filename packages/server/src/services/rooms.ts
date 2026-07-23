// 项目协作元数据：data/rooms.json（原子写，与 persistence 同惯例）。
// 消息不在这里——SoT 是项目消息库（project-db.ts，data/projects.db）；
// 成员名单在此（房间=team）。本文件只管"项目有哪些、谁在项目里"。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { RoomInfo, RoomMember } from '../../../shared/protocol'
import { DATA_DIR } from '../config'
import { createLogger } from '../logger'
import { isGitRepo } from './worktree'

const log = createLogger('rooms')

const ROOMS_PATH = path.join(DATA_DIR, 'rooms.json')

/** 人类成员默认名（config.humanName 可覆盖；@mention 与花名册身份） */
export const DEFAULT_HUMAN_NAME = 'Owner'
/** 广播保留字：@all = 房内全部会话成员 */
export const ALL_MENTION = 'all'

function atomicWrite(filePath: string, content: string) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
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

  constructor(humanName: string = DEFAULT_HUMAN_NAME) {
    this.humanName = humanName
    this.rooms = this.load()
  }

  private load(): RoomInfo[] {
    try {
      if (!fs.existsSync(ROOMS_PATH)) return []
      const parsed = JSON.parse(fs.readFileSync(ROOMS_PATH, 'utf8'))
      if (!Array.isArray(parsed)) return []
      // 旧 rooms.json 没有 archivedAt：读取时补 null，下一次保存自然完成迁移。
      // 旧 rooms.json 同样没有 dispatchMode：补 'serial'（当前默认），迁移方式同 archivedAt。
      // repoPath（认领制自动开工作区用）、rootPath（项目 Files 根）缺省补 null，同上。
      return (parsed as Partial<RoomInfo>[]).map((room) => ({
        ...(room as RoomInfo),
        archivedAt: typeof room.archivedAt === 'number' ? room.archivedAt : null,
        dispatchMode: room.dispatchMode === 'parallel' || room.dispatchMode === 'claim' ? room.dispatchMode : 'serial',
        repoPath: typeof room.repoPath === 'string' && room.repoPath ? room.repoPath : null,
        rootPath: typeof room.rootPath === 'string' && room.rootPath ? room.rootPath : null,
      }))
    } catch (err) {
      log.error('rooms.json 读取失败，按空处理', err)
      return []
    }
  }

  private save() {
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

  create(name: string): RoomInfo {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('项目名不能为空')
    if (this.rooms.some((r) => r.name === trimmed)) throw new Error(`项目「${trimmed}」已存在`)
    const id = crypto.randomUUID().slice(0, 8)
    const room: RoomInfo = {
      id,
      name: trimmed,
      team: `room-${id}`,
      createdAt: Date.now(),
      archivedAt: null,
      dispatchMode: 'serial', // 默认串行轮转（2026-07-22 调转）：一次只放行一位成员
      repoPath: null,
      rootPath: null,
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

  /** 切调度模式：parallel=全员即注；serial=串行轮转一次只放行一位（默认）；claim=认领制先到先得 */
  setDispatchMode(id: string, mode: 'parallel' | 'serial' | 'claim'): RoomInfo {
    const room = this.get(id)
    this.assertActive(room)
    if (mode !== 'parallel' && mode !== 'serial' && mode !== 'claim') throw new Error('调度模式只能是 parallel、serial 或 claim')
    if (room.dispatchMode !== mode) {
      room.dispatchMode = mode
      this.save()
    }
    return room
  }

  /** 绑定/解绑 git 仓库（claim 赢家自动开工作区用）；绑定时校验真是 git 仓，null 解绑 */
  setRepoPath(id: string, repoPath: string | null): RoomInfo {
    const room = this.get(id)
    this.assertActive(room)
    const trimmed = repoPath?.trim() || null
    if (trimmed && !isGitRepo(trimmed)) throw new Error(`「${trimmed}」不是 git 仓库（git rev-parse 失败）`)
    if (room.repoPath !== trimmed) {
      room.repoPath = trimmed
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
