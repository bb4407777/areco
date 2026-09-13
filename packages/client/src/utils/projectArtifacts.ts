import type { RoomMessage } from '../../../shared/protocol'
import { extractFileLinks, type FileLink } from './filelinks'

// 项目成果只认 agent 明确汇报完成/产出的消息，避免把维护者上传的原始材料混入成果。
const RESULT_MARK = /(已完成|完成[，,:：。\s]|已生成|生成完|已保存|已写入|已产出|产物|交付物|初稿|定稿|终稿|输出到|saved|created|written|generated)/i

const PROJECT_FILE_EXT = '(?:pdf|png|jpe?g|gif|webp|svg|bmp|heic|html?|txt|md|json|csv|log|xml|ya?ml|mp4|mov|webm|m4v|docx?|xlsx?|pptx?)'
// 反引号内允许目录/文件名带空格；裸路径为避免吞掉前置正文，只认不含空白的相对路径。
const QUOTED_RELATIVE_PATH_RE = new RegExp(`\`([^\`\n]+?\\.${PROJECT_FILE_EXT})\``, 'gi')
const BARE_RELATIVE_PATH_RE = new RegExp(
  `(?:^|[\\s（(：:,，])((?:\\.{1,2}/)?[^\\s\`"'|<>：:,，/]+(?:/[^\\s\`"'|<>：:,，/]+)+\\.${PROJECT_FILE_EXT})(?=[\\s)\\]，。、；：!?？'"\`|<>]|$)`,
  'gi',
)

export function isLocatedProjectArtifact(path: string): boolean {
  return path.startsWith('/Users/') || path.startsWith('~/')
}

function fileLink(path: string): FileLink {
  const name = path.split('/').pop() ?? path
  return { path, name, ext: (name.split('.').pop() ?? '').toLowerCase() }
}

/** 项目回执除绝对路径外，也保留案件目录内的相对成果路径；相对路径仅展示，不猜其绝对位置。 */
export function extractProjectFileLinks(text: string): FileLink[] {
  const links = extractFileLinks(text)
  const seen = new Set(links.map((link) => link.path))
  // 先遮蔽绝对路径，避免其中的中文括号/空格被当作边界，又截出一条相对路径后缀。
  let relativeText = text
  for (const link of links) relativeText = relativeText.split(link.path).join(' ')

  const add = (raw: string) => {
    const path = raw.trim().replace(/[，。、；：!？)\]]+$/u, '')
    if (!path.includes('/') || isLocatedProjectArtifact(path) || seen.has(path)) return
    seen.add(path)
    links.push(fileLink(path))
  }

  for (const match of relativeText.matchAll(QUOTED_RELATIVE_PATH_RE)) add(match[1])
  for (const match of relativeText.matchAll(BARE_RELATIVE_PATH_RE)) add(match[1])
  return links
}

export interface ProjectArtifactMention extends FileLink {
  producer: string
  contributors: string[]
  firstMentionAt: string
  lastMentionAt: string
}

export function collectProjectArtifactMentions(
  messages: RoomMessage[],
  humanName: string,
  maxCandidates = 80,
): ProjectArtifactMention[] {
  const byPath = new Map<string, ProjectArtifactMention>()
  const chronological = [...messages].sort((a, b) => {
    const ta = Date.parse(a.createdAt)
    const tb = Date.parse(b.createdAt)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.id - b.id
  })

  for (const message of chronological) {
    if (message.from === humanName || !RESULT_MARK.test(message.body)) continue
    for (const link of extractProjectFileLinks(message.body)) {
      const existing = byPath.get(link.path)
      if (!existing) {
        byPath.set(link.path, {
          ...link,
          producer: message.from,
          contributors: [message.from],
          firstMentionAt: message.createdAt,
          lastMentionAt: message.createdAt,
        })
        continue
      }

      existing.name = link.name
      existing.ext = link.ext
      existing.lastMentionAt = message.createdAt
      if (!existing.contributors.includes(message.from)) existing.contributors.push(message.from)
    }
  }

  return [...byPath.values()]
    .sort((a, b) => Date.parse(b.lastMentionAt) - Date.parse(a.lastMentionAt))
    .slice(0, maxCandidates)
}
