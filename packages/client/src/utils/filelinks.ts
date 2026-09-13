// 从对话文本里认出本地文件路径，供 ChatMessage 渲成可预览 chip。
// 只认「白名单可能命中」的绝对路径（/Users/… 或 ~/…）且以已知可预览扩展名结尾。
// 中文文件名常带空格（如「周 文书」），故允许路径含空格与 CJK，用扩展名锚定右边界。

const PREVIEWABLE_EXT = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'heic',
  'html',
  'htm',
  'txt',
  'md',
  'json',
  'csv',
  'log',
  'xml',
  'yaml',
  'yml',
  'mp4',
  'mov',
  'webm',
  'm4v',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
]

// 路径起点：/Users/ 或 ~/ ；中间允许除引号/反引号/换行/竖线外的字符（含空格与中文）；
// 以 .ext 结尾。惰性匹配 + 扩展名锚定，避免把后续正文吞进来。
const EXT_ALT = PREVIEWABLE_EXT.join('|')
const PATH_RE = new RegExp(
  `(?:~|/Users/[^/\\s]+)(?:/[^\\n\`"'|<>]*?)\\.(?:${EXT_ALT})(?=[\\s\\)\\]，。、；：!？'"\`|<>]|$)`,
  'gi'
)

export interface FileLink {
  path: string
  name: string
  ext: string
}

const ICON: Record<string, string> = {
  pdf: '📄',
  docx: '📝',
  doc: '📝',
  xlsx: '📊',
  xls: '📊',
  pptx: '📑',
  ppt: '📑',
  html: '🌐',
  htm: '🌐',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  webp: '🖼️',
  svg: '🖼️',
  bmp: '🖼️',
  heic: '🖼️',
  mp4: '🎬',
  mov: '🎬',
  webm: '🎬',
  m4v: '🎬',
}

export function iconFor(ext: string): string {
  return ICON[ext] ?? '📎'
}

/** 从一段文本抽取所有可预览文件路径（去重，保序） */
export function extractFileLinks(text: string): FileLink[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: FileLink[] = []
  for (const m of text.matchAll(PATH_RE)) {
    let p = m[0].trim()
    // 去掉误吞的行尾标点（正则已用 lookahead 挡住，双保险）
    p = p.replace(/[，。、；：!？)\]]+$/u, '')
    if (seen.has(p)) continue
    seen.add(p)
    const name = p.split('/').pop() ?? p
    const ext = (name.split('.').pop() ?? '').toLowerCase()
    out.push({ path: p, name, ext })
  }
  return out
}
