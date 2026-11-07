// 进程快照与分类：座舱「进程」页的数据源（2026-11-07 高律师「现在的 areco 能不能弄个功能，
// 找到现在的所有进程呢？比如说这些孤儿进程和现在 opc 架构下的后台进程」）。
//
// 判孤儿的口径（关键，实测校准过）：
//   PPID=1 的进程一大堆是正常的——launchd 拉起的服务、App 的 crashpad_handler、
//   Finder 扩展、adb server、hindsight 的 postgres，全都挂到 PID 1 下。
//   只看 PPID 会把它们全标成孤儿，一键清理就会把正在用的东西杀掉。
// 故真孤儿 = PPID==1 且 属当前用户 且 不在 `launchctl list` 的 PID 表里
//            且 分类是「CLI 引擎 / OPC 后台脚本」——即 codebuddy --acp、我们的 python 脚本这类，
//            App 自带 helper 与系统服务一律不碰。
// 其余进程一律不许从这里结束——kill 只服务孤儿，避免把座舱变成乱砍进程的入口。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessKind, ProcessRow, ProcessSnapshot } from '../../../shared/protocol'

const execFileAsync = promisify(execFile)

export type { ProcessKind, ProcessRow, ProcessSnapshot }

interface Rule {
  re: RegExp
  kind: ProcessKind
  label: string
}

// 顺序即优先级：先认常驻服务，再认后台任务，最后兜底 CLI / 其他
const RULES: Rule[] = [
  { re: /skills\/cc-connect\/(bin\/cc-connect|scripts\/workbuddy-acp-clean)/, kind: 'service', label: 'cc-connect 中枢' },
  { re: /server\.acp_bridge|acp_bridge\.py/, kind: 'service', label: 'ACP 桥 :8647' },
  { re: /server\.main --port 8698|hermes-live\/server\/main\.py/, kind: 'service', label: 'hermes-live :8698' },
  // 服务实际命令行是 `node dist/server/index.cjs`（不带 areco 字样，要靠启动形态认）；
  // Electron 壳是 areco.app/Contents/MacOS/areco。不可写宽泛的 packages/server——
  // 任何人 grep/编辑这个目录，其 zsh 命令行都会带这串路径，被误标成服务。
  { re: /areco\.app\/Contents\/MacOS\/areco$/, kind: 'service', label: 'areco 座舱 :8790' },
  { re: /(^|\/)node\s+\S*dist\/server\/index\.cjs$/, kind: 'service', label: 'areco 座舱 :8790' },
  { re: /ego-browser/, kind: 'service', label: 'ego 浏览器' },
  { re: /hindsight/, kind: 'service', label: 'hindsight' },
  { re: /skills\/opc\/(scripts|lib)\/|pi-worker|chat-dispatch\.py|kanban|orchestrat/, kind: 'worker', label: 'OPC 后台' },
  { re: /cli\/bin\/codebuddy/, kind: 'cli', label: 'CodeBuddy CLI' },
]

const SYSTEM_PATHS = /^\/(sbin|usr\/sbin|usr\/libexec|System|Library\/AppleSystemLogs)\//

export function etimeToSec(etime: string): number {
  const s = (etime || '').trim()
  if (!s) return 0
  let days = 0
  let rest = s
  const dash = s.indexOf('-')
  if (dash > 0) {
    days = Number(s.slice(0, dash)) || 0
    rest = s.slice(dash + 1)
  }
  const parts = rest.split(':').map((x) => Number(x) || 0)
  if (parts.length === 1) return days * 86400 + parts[0]
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1]
  return days * 86400 + parts[parts.length - 3] * 3600 + parts[parts.length - 2] * 60 + parts[parts.length - 1]
}

// shell 包装器本身不带业务含义，且 `zsh -c '…'` 的内联脚本里会出现任何路径与关键字
// （编辑/grep 这个仓库时命令行就含 packages/server、skills/opc），必须先短路为「其他」，
// 否则整条命令按内联文本分类，会把编辑器会话标成服务或后台任务。
const SHELL_WRAPPER = /^\/(?:bin|usr\/bin)\/(?:zsh|bash|sh)\s+-c\b/

export function classify(command: string): { kind: ProcessKind; label: string } {
  if (SHELL_WRAPPER.test(command)) return { kind: 'other', label: '其他' }
  for (const r of RULES) {
    if (r.re.test(command)) return { kind: r.kind, label: r.label }
  }
  return { kind: 'other', label: '其他' }
}

export interface RawProc {
  pid: number
  ppid: number
  pgid: number
  uid: number
  stat: string
  pcpu: number
  pmem: number
  rssKb: number
  etime: string
  command: string
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s(.*)$/

export function parsePs(stdout: string): RawProc[] {
  const out: RawProc[] = []
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line)
    if (!m) continue
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      stat: m[5],
      pcpu: Number(m[6]),
      pmem: Number(m[7]),
      rssKb: Number(m[8]),
      etime: m[9],
      command: m[10],
    })
  }
  return out
}

/** `launchctl list` 的 PID 列 → 常驻服务 PID 集合（这些 PPID 也是 1，但不是孤儿） */
export function parseLaunchdPids(stdout: string): Set<number> {
  const set = new Set<number>()
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3) continue
    const pid = Number(cols[0])
    if (Number.isInteger(pid) && pid > 0) set.add(pid)
  }
  return set
}

export function buildSnapshot(
  procs: RawProc[],
  launchdPids: Set<number>,
  selfUid: number
): ProcessSnapshot {
  // 只列当前用户的进程：root 那几百个系统守护进程是噪声，高律师要看的是自己这摊
  const mine = procs.filter((p) => p.uid === selfUid)
  const rows: ProcessRow[] = mine.map((p) => {
    const { kind, label } = classify(p.command)
    const orphan =
      p.ppid === 1 &&
      p.uid === selfUid &&
      (kind === 'cli' || kind === 'worker') &&
      !launchdPids.has(p.pid) &&
      !SYSTEM_PATHS.test(p.command) &&
      !p.stat.startsWith('Z')
    return {
      pid: p.pid,
      ppid: p.ppid,
      pgid: p.pgid,
      kind,
      label,
      orphan,
      killable: orphan,
      cpu: p.pcpu,
      mem: p.pmem,
      rss: p.rssKb * 1024,
      etime: p.etime,
      ageSec: etimeToSec(p.etime),
      command: p.command,
    }
  })
  // 孤儿排最前（按内存降序），其余按内存降序：一眼看到谁在占内存
  rows.sort((a, b) => Number(b.orphan) - Number(a.orphan) || b.rss - a.rss)
  const orphans = rows.filter((r) => r.orphan)
  return {
    ts: Date.now(),
    total: rows.length,
    orphanCount: orphans.length,
    orphanRss: orphans.reduce((s, r) => s + r.rss, 0),
    rows,
  }
}

export async function snapshot(): Promise<ProcessSnapshot> {
  const psArgs = ['-axo', 'pid=,ppid=,pgid=,uid=,stat=,pcpu=,pmem=,rss=,etime=,command=']
  let procs: RawProc[] = []
  let warning: string | undefined
  try {
    const { stdout } = await execFileAsync('/bin/ps', psArgs, { maxBuffer: 16 * 1024 * 1024 })
    procs = parsePs(stdout)
  } catch (e) {
    warning = `ps 执行失败：${(e as Error).message}`
  }
  let launchdPids = new Set<number>()
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['list'], { maxBuffer: 8 * 1024 * 1024 })
    launchdPids = parseLaunchdPids(stdout)
  } catch (e) {
    // 拿不到 launchctl 时保守处理：宁可一个孤儿都不标，也不误标常驻服务
    warning = warning ?? `launchctl 执行失败：${(e as Error).message}`
    return { ...buildSnapshot(procs, new Set(procs.map((p) => p.pid)), process.getuid?.() ?? -1), warning }
  }
  return { ...buildSnapshot(procs, launchdPids, process.getuid?.() ?? -1), warning }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 只结束孤儿：结束前重新取快照核身份，避免 TOCTOU 误杀 */
export async function killOrphan(pid: number): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, message: 'pid 非法' }
  if (pid === process.pid) return { ok: false, message: '不能结束本服务自身' }
  const snap = await snapshot()
  const row = snap.rows.find((r) => r.pid === pid)
  if (!row) return { ok: false, message: '进程已不存在' }
  if (!row.orphan) return { ok: false, message: '只允许结束孤儿进程（父进程已退出且非 launchd 托管的）' }
  const pgid = row.pgid > 1 ? row.pgid : row.pid
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (e) {
      return { ok: false, message: `SIGTERM 失败：${(e as Error).message}` }
    }
  }
  for (let i = 0; i < 10; i += 1) {
    if (!alive(pid)) return { ok: true, message: `已结束 ${pid}（${row.label}）` }
    await sleep(300)
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  await sleep(300)
  return alive(pid)
    ? { ok: false, message: `${pid} 仍在运行（可能被系统重启）` }
    : { ok: true, message: `已强制结束 ${pid}（${row.label}）` }
}

export async function killAllOrphans(): Promise<{ killed: number; failed: { pid: number; message: string }[] }> {
  const snap = await snapshot()
  const targets = snap.rows.filter((r) => r.orphan)
  const failed: { pid: number; message: string }[] = []
  let killed = 0
  for (const t of targets) {
    const r = await killOrphan(t.pid)
    if (r.ok) killed += 1
    else failed.push({ pid: t.pid, message: r.message })
  }
  return { killed, failed }
}
