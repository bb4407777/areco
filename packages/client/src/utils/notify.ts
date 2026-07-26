// Claude Code 把后台子任务完成通知以合成 user 行写进 transcript（type:user + 字符串正文，
// 连 isMeta 都不标）。识别口径：正文以 <task-notification> 开头——本机实测该类行为纯 XML，
// 不会混入真人文字，前缀判定安全。
export function isTaskNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>')
}

export interface TaskNotification {
  summary: string
  body: string
}

/** 提取通知里的人话：<summary> 做折叠标题、<result> 做正文；标签缺失时兜底原文 */
export function parseTaskNotification(text: string): TaskNotification | null {
  if (!isTaskNotification(text)) return null
  const pick = (tag: string): string => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }
  return { summary: pick('summary') || '子任务通知', body: pick('result') || text }
}
