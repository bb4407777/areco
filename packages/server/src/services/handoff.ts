// 跨 agent 接续（第二档"继续"）：把任意源的历史会话渲染成交接档案，让任选的 agent 读档续干。
// 与原生 resume 的分工：resume 无损（同 agent 内部状态全保留），接续有损但通用——
// 只带走对话内容；干活的真实状态在文件与 git 里，交接档案负责把"讲到哪了"说清楚。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from '../config'
import type { TranscriptMessage } from '../../../shared/protocol'

// agmsg（跨 agent 消息，~/Code/agmsg）装机检测：装了就在档案头部告诉接手方可以联系在线同伴
const agmsgInstalled = () => fs.existsSync(path.join(os.homedir(), '.agents/skills/agmsg'))

const HANDOFF_DIR = path.join(DATA_DIR, 'handoff')
// 交接档案正文上限：超长取尾部并在头部注明（模型自己读文件，不受一次输入限制，但没必要无限大）
const MAX_BODY_CHARS = 400_000
// 工具入参/结果的单条截断：让接手方看到"查了什么、得到什么"，又不让 grep/read 的大输出淹没对话
const TOOL_INPUT_MAX = 300
const TOOL_RESULT_MAX = 700

export interface HandoffMeta {
  source: string
  project: string
  id: string
  title: string
}

function clip(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…（截断，原 ${t.length.toLocaleString()} 字符）`
}

export function writeHandoffFile(meta: HandoffMeta, messages: TranscriptMessage[]): string {
  const sections: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? '👤 用户' : '🤖 助手'
    const time = m.timestamp ? `（${m.timestamp}）` : ''
    const parts: string[] = []
    for (const p of m.parts) {
      if (p.kind === 'text') parts.push(p.text)
      else if (p.kind === 'tool_use') {
        // 入参摘要：接手方能看出"当时查/改了什么"，不用自己重放
        const input = p.input ? `：\`${clip(p.input, TOOL_INPUT_MAX).replace(/\n/g, ' ')}\`` : ''
        parts.push(`> 🔧 ${p.name}${input}`)
      } else if (p.kind === 'tool_result') {
        // 结果摘要（截断）：关键返回值随档案走，细节状态仍以工作区为准
        const text = clip(p.text, TOOL_RESULT_MAX)
        if (text) parts.push(`> ${p.isError ? '❌' : '↩️'} ${text.replace(/\n/g, '\n> ')}`)
      }
      // thinking 不进交接——内心过程对接手方无约束力
    }
    if (parts.length) sections.push(`## ${who}${time}\n\n${parts.join('\n\n')}`)
  }
  let body = sections.join('\n\n---\n\n')
  const truncated = body.length > MAX_BODY_CHARS
  if (truncated) body = body.slice(-MAX_BODY_CHARS)

  const head = [
    '# 会话接力档案',
    '',
    `- 来源 agent：${meta.source}`,
    `- 原会话：${meta.project}/${meta.id}`,
    `- 标题：${meta.title}`,
    ...(truncated ? [`- ⚠️ 原文过长，此档案只保留最后 ${MAX_BODY_CHARS.toLocaleString()} 字符`] : []),
    '',
    '> 这是另一个 agent 会话的历史记录。请通读后接着记录末尾正在进行的任务继续工作；',
    '> 工具行只是当时的摘要（🔧 调用 / ↩️ 结果，均有截断），',
    '> 若记录里的结论与当前文件/代码状态冲突，一律以当前工作区实测为准。',
    ...(agmsgInstalled()
      ? ['> 本机装有 agmsg（跨 agent 消息）：若任务需要与其他在线 agent 协作，可用 /agmsg（或 $agmsg）联系队友。']
      : []),
    '',
  ].join('\n')

  fs.mkdirSync(HANDOFF_DIR, { recursive: true })
  const file = path.join(HANDOFF_DIR, `${meta.id.replace(/[^A-Za-z0-9._-]/g, '')}.md`)
  fs.writeFileSync(file, `${head}\n${body}\n`)
  return file
}

export function handoffPrompt(file: string, source: string): string {
  return `先读 ${file} ——这是之前一段会话的完整记录（来自 ${source}），读完后接着其中最后的任务继续。`
}
