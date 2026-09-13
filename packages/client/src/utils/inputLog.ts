// 输入诊断环形日志：记录 xterm onData 发送结果与 IME 组字事件，排查手机端"吞字/标点丢失"。
// 只写本地 localStorage（300 条上限，超出丢最旧），设置页可查看/复制/清空，不上传服务端。
export interface InputLogEntry {
  ts: number
  kind: 'data' | 'comp' | 'key' | 'binput'
  /** 已转义的详情（控制字符可见） */
  detail: string
  /** data 类：wsClient.send 是否成功 */
  ok?: boolean
}

const KEY = 'areco-input-log'
const CAP = 300

/** 控制字符转可见形式，换行/回车/ESC 等一眼可辨 */
export function escapeDetail(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\x1b/g, '\\e')
    // 其余不可见字符转 \xNN
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

export function logInput(entry: Omit<InputLogEntry, 'ts'>) {
  try {
    const list = getInputLog()
    list.push({ ...entry, ts: Date.now() })
    if (list.length > CAP) list.splice(0, list.length - CAP)
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式/写满：诊断让位于正常使用 */
  }
}

export function getInputLog(): InputLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as InputLogEntry[]) : []
  } catch {
    return []
  }
}

export function clearInputLog() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
