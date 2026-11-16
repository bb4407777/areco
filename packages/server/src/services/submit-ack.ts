// 提交回执：以 agent 自己的转写文件为准，判断「这一句到底进去了没有」。
//
// 背景（2026-11-16）：输入框里的字发不出去，历史上靠看屏幕判断——尾字在框里就再按回车、
// 框空了就算成功。屏幕是渲染结果，不是事实：TUI 还在重绘时尾字要等好几秒才画出来，长文
// 实测挂框 25 秒；反过来，认错框就会把用户正在打的字抢先发出去。转写文件是 agent 自己的
// 记录——提交那一刻就会落一条 user 消息（2026-11-16 实测：22:56:42 提交，22:56:42 落盘），
// 拿它当唯一判据，屏幕只留作防止误触菜单的兜底。
import fs from 'node:fs'
import { agentKindOf, locateAgentFile, parseWorkbuddy } from './agent-transcript'
import type { Session } from './session'

export interface SubmitAck {
  path: string
  /** 写正文之前的文件字节数：只有这之后新落的 user 消息才算这次提交的回执 */
  from: number
  /** 归一化后的尾段（24 字），用来认「这条 user 消息是不是我刚写的那一句」 */
  key: string
  /** 正文太短（<8 字）时不比对内容，任何新 user 消息都算回执 */
  loose: boolean
}

const norm = (text: string) => text.replace(/\s+/g, '').trim()

/** 写正文之前取基线；不是 workbuddy / 定位不到转写文件时返回 null（退回屏幕判断） */
export function prepareSubmitAck(session: Session, body: string): SubmitAck | null {
  const kind = agentKindOf(session.command, session.harness)
  if (kind !== 'workbuddy') return null
  const text = norm(body)
  if (!text) return null
  let path: string | null = null
  try {
    path = locateAgentFile(session, kind)
  } catch {
    path = null
  }
  if (!path) return null
  let from = 0
  try {
    from = fs.statSync(path).size
  } catch {
    return null
  }
  return { path, from, key: text.slice(-24), loose: text.length < 8 }
}

/** 基线之后是否落了这次提交对应的 user 消息 */
export function submitAckSeen(ack: SubmitAck): boolean {
  let raw: string
  try {
    const size = fs.statSync(ack.path).size
    if (size <= ack.from) return false
    // 只读新增部分：单条消息可能很长（带附件路径），留 512KB 足够，不整文件重读
    const len = Math.min(size - ack.from, 512 * 1024)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(ack.path, 'r')
    try {
      fs.readSync(fd, buf, 0, len, ack.from)
    } finally {
      fs.closeSync(fd)
    }
    raw = buf.toString('utf8')
  } catch {
    return false
  }
  // 末尾那行可能正写到一半，丢掉它再解析
  const lines = raw.split('\n')
  lines.pop()
  const parsed = parseWorkbuddy(lines.join('\n'))
  for (let i = parsed.length - 1; i >= 0; i--) {
    const msg = parsed[i]
    if (msg.role !== 'user') continue
    const text = norm(msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n'))
    if (ack.loose || text.includes(ack.key)) return true
  }
  return false
}

/** 测试用：直接对一段 jsonl 判断是否含指定尾段（不碰文件系统） */
export function jsonlHasUserKey(raw: string, key: string, loose = false): boolean {
  const parsed = parseWorkbuddy(raw)
  return parsed.some((msg) => {
    if (msg.role !== 'user') return false
    const text = norm(msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n'))
    return loose || text.includes(key)
  })
}
