// 会话元数据与终端快照落盘：data/sessions.json（防抖原子写）+ data/snapshots/<id>.snap
import fs from 'node:fs'
import path from 'node:path'
import type { SessionSummary } from '../../../shared/protocol'
import type { SessionSnapshot } from './session'
import { DATA_DIR } from '../config'
import { createLogger } from '../logger'

const log = createLogger('persist')

const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json')
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots')
const SAVE_DEBOUNCE_MS = 1000

function atomicWrite(filePath: string, content: string) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}

export class Persistence {
  private saveTimer: NodeJS.Timeout | null = null
  private pendingList: SessionSummary[] | null = null

  constructor() {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  }

  loadSessions(): SessionSummary[] {
    try {
      if (!fs.existsSync(SESSIONS_PATH)) return []
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'))
      return Array.isArray(parsed) ? (parsed as SessionSummary[]) : []
    } catch (err) {
      log.error('sessions.json 读取失败，按空处理', err)
      return []
    }
  }

  /** 防抖 1s 原子写 */
  saveSessions(list: SessionSummary[]) {
    this.pendingList = list
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.pendingList) return
    try {
      atomicWrite(SESSIONS_PATH, JSON.stringify(this.pendingList, null, 2) + '\n')
    } catch (err) {
      log.error('sessions.json 写入失败', err)
    }
    this.pendingList = null
  }

  private snapPath(id: string): string {
    // id 是服务端生成的 UUID，此处再防御一层路径注入
    return path.join(SNAPSHOT_DIR, id.replace(/[^a-zA-Z0-9-]/g, '') + '.snap')
  }

  saveSnapshot(id: string, snap: SessionSnapshot) {
    try {
      atomicWrite(this.snapPath(id), JSON.stringify(snap))
    } catch (err) {
      log.error(`快照写入失败 ${id}`, err)
    }
  }

  loadSnapshot(id: string): SessionSnapshot | null {
    try {
      const p = this.snapPath(id)
      if (!fs.existsSync(p)) return null
      return JSON.parse(fs.readFileSync(p, 'utf8')) as SessionSnapshot
    } catch {
      return null
    }
  }

  deleteSnapshot(id: string) {
    try {
      fs.rmSync(this.snapPath(id), { force: true })
    } catch {
      /* ignore */
    }
  }
}
