// 会话名演化跟踪器：增量扫 agent transcript 的新增完整行，产出两类命名候选——
//  ① 原生标题：claude custom-title 行 / workbuddy ai-title 行
//    （kimi 原生标题在同会话目录 state.json，行里没有，由 manager 用 kimiTitleOf 直读）
//  ② 最新用户 prompt：codex/qclaw/reasonix/kimi 没有原生标题时的演化名——话题漂移跟随最新输入
// claude 系只收 ① 不追 prompt：Claude 自己的命名保留（ Claude Code 会随话题重写 custom-title，
// 跟着它就是演化）。本模块纯函数无 Session 依赖，改名决策（autoNamed 锁定）在 session-manager。
import type { AgentKind } from './agent-transcript'
import {
  handoffTitleFromPrompt,
  parseCodex,
  parseKimi,
  parseQclaw,
  parseReasonix,
  parseWorkbuddy,
} from './agent-transcript'

/** 'claude' = claude 系 transcript（custom-title 行）；其余为各 agent 原生格式 */
export type NameSource = AgentKind | 'claude'

const MAX_TITLE = 80

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t
}

/** 单条用户输入 → prompt 演化名；交接档案注入（「先读 …/完整记录（来自 X）」）取档案标题，取不到不改名 */
function promptCandidate(text: string): string {
  const t = text.trim()
  if (!t) return ''
  if (t.startsWith('先读 ') || t.includes('完整记录（来自')) return handoffTitleFromPrompt(t)
  return clip(t)
}

function userTextsOfLine(line: string, kind: AgentKind): string[] {
  const messages =
    kind === 'codex'
      ? parseCodex(line)
      : kind === 'kimi'
        ? parseKimi(line)
        : kind === 'qclaw'
          ? parseQclaw(line)
          : kind === 'reasonix'
            ? parseReasonix(line)
            : parseWorkbuddy(line)
  const texts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const part of m.parts) if (part.kind === 'text') texts.push(part.text)
  }
  return texts
}

/**
 * 单会话增量扫描状态。offset 只推进到「最后一个完整行尾（\n）」，半行字节不消费，
 * 下次从同一字节位置重读——UTF-8 多字节字符因此永远不会被砍半（换行符是 ASCII 边界）。
 */
export class NameTracker {
  nativeTitle = ''
  promptTitle = ''
  private offset = 0

  get cursor(): number {
    return this.offset
  }

  /** 文件被替换/截断（size 小于已扫位置）时归零重扫 */
  resetIfShrunk(size: number) {
    if (size < this.offset) this.offset = 0
  }

  /** 喂新增字节（从 cursor 到文件尾）：只解析完整行；后出现的候选覆盖先出现的（演化语义） */
  feed(chunk: Buffer, source: NameSource): void {
    const lastNl = chunk.lastIndexOf(0x0a)
    if (lastNl < 0) return
    const complete = chunk.subarray(0, lastNl + 1)
    this.offset += complete.length
    for (const line of complete.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.parseLine(trimmed, source)
    }
  }

  private parseLine(line: string, source: NameSource) {
    if (source === 'claude') {
      let row: { type?: unknown; customTitle?: unknown; aiTitle?: unknown }
      try {
        row = JSON.parse(line) as typeof row
      } catch {
        return
      }
      // claude 系两种原生标题行都吃：官方/隔离分身写 custom-title，本机定制构建写 ai-title（实测并存）
      const title =
        row.type === 'custom-title' && typeof row.customTitle === 'string'
          ? row.customTitle
          : row.type === 'ai-title' && typeof row.aiTitle === 'string'
            ? row.aiTitle
            : ''
      if (title.trim()) this.nativeTitle = clip(title)
      return
    }
    if (source === 'workbuddy') {
      let row: { type?: unknown; aiTitle?: unknown }
      try {
        row = JSON.parse(line) as typeof row
      } catch {
        return
      }
      if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) {
        this.nativeTitle = clip(row.aiTitle)
        return
      }
      // 无 ai-title 行时落回 prompt 跟踪（ai-title 未生成前先有个名）
    }
    for (const text of userTextsOfLine(line, source)) {
      const candidate = promptCandidate(text)
      if (candidate) this.promptTitle = candidate
    }
  }
}

/**
 * 本轮候选名：原生标题优先（agent 自己的语义命名），无原生标题用最新 prompt 演化。
 * claude 只要 custom-title（保留 Claude 自己的命名，不拿 prompt 覆盖）。
 * kimi 原生标题在 state.json 由 manager 直读，不在此合并。
 */
export function nameCandidateOf(tracker: NameTracker, source: NameSource): string {
  if (source === 'claude') return tracker.nativeTitle
  return tracker.nativeTitle || tracker.promptTitle
}
