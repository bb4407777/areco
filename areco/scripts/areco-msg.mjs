#!/usr/bin/env node
// areco 项目消息 CLI：本机终端/agent 回执与插话用，直写 data/tasks.db（WAL，与服务端并发安全）。
// 用法：
//   发消息：node scripts/areco-msg.mjs <team> <from> <to> <消息...> [--human-relay] [--dry-run] [--strict]
//     team = 项目 team 名（页面「⇗ 邀请」里可查，形如 room-<id>；rooms 子命令可列全量）
//     from = 发言身份（项目成员名；外部终端可用任意名字，仅作显示）
//     to   = 收件身份（成员名 / all）
//     --human-relay = 转述人类原话标记（仅服务端配置白名单里的 from 生效，如微信通道
//       Hermes 转维护者指令：清零互调链深 + 按人类语义投递；名单外打标无效）
//     --stdin / --file <路径> = 正文改从 stdin/文件读入，原样保留换行与引号（长消息、
//       多行消息用这个，不再受 shell 分词/引号折磨）；此时命令行不带 <消息...>
//     --dry-run = 只校验并预览路由（team/归档/成员/白名单/正文），不落库
//     --strict  = 「to 非房内成员」「human-relay 白名单外」两类警告升级为错误（exit 5）
//   查历史：node scripts/areco-msg.mjs <team> history [N]
//     打印该项目最近 N 条消息（默认 20，旧→新）。共享上下文空间的主动查询入口——
//     服务端投递时只附「文件路径 + 近况预览」，想看全量来龙去脉用本子命令自查。
//   查房间：node scripts/areco-msg.mjs rooms [--all]    在册房间清单（默认不含归档）
//   查成员：node scripts/areco-msg.mjs members <team>   房间花名册（to 需精确匹配成员名）
// exit code（成功时 stdout 只有一行 ok，向后兼容；一切诊断信息走 stderr）：
//   0 成功 | 1 用法错误 | 3 team 不存在 | 4 房间已归档 | 5 --strict 校验失败
//   65 数据库损坏 | 74 磁盘满/IO | 75 数据库忙（重试后仍锁）| 77 无写权限 | 10 其他错误
// 投递语义（写库 ≠ 送达，排查先分清）：服务端 room-relay 以 ~1s 游标轮询拾取本库新行，
//   广播到页面并按 to/@ 注入成员会话。服务端不在线期间写入的消息页面可见，但不会投递，
//   服务端重启后为防重放也不补投——本 CLI 写完会探测 /healthz，不在线即警告。
// 零依赖；node ≥ 23.4（node:sqlite；22.5+ 需 --experimental-sqlite）。
// ARECO_ROOT 可覆盖数据根（多实例/测试）；ARECO_MSG_BUSY_MS 调 busy_timeout（默认 3000）。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT = { ok: 0, usage: 1, teamNotFound: 3, archived: 4, strict: 5, db: 10, dataErr: 65, io: 74, busy: 75, perm: 77 }

// node:sqlite 经 getBuiltinModule 拿：老 node（<22.3 无此 API；22.5~23.3 需实验 flag）
// 不再裸抛 ERR_UNKNOWN_BUILTIN_MODULE 栈，给出可执行的升级指引
let DatabaseSync = null
try {
  ;({ DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? {})
} catch {
  /* 该 node 版本没有 node:sqlite 或未开实验 flag */
}
if (!DatabaseSync) {
  console.error(`✗ 本 CLI 依赖 node:sqlite：当前 node ${process.version} 不可用。请升级 node ≥ 23.4（本机装的是 /usr/local/bin/node），或 22.5+ 加 --experimental-sqlite 运行`)
  process.exit(EXIT.db)
}

// ---- 参数解析：已知 flag 从任意位置提取（--human-relay 原行为如此，新 flag 对齐；正文里
// 要写这些 flag 字面量时请改用 --stdin/--file，argv 正文不可能原样携带它们）----
const rawArgv = process.argv.slice(2)
const flags = { humanRelay: false, dryRun: false, strict: false, stdin: false, file: null, all: false, help: false }
const argv = []
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i]
  if (a === '--human-relay') flags.humanRelay = true
  else if (a === '--dry-run') flags.dryRun = true
  else if (a === '--strict') flags.strict = true
  else if (a === '--stdin') flags.stdin = true
  else if (a === '--all') flags.all = true
  else if (a === '--help' || a === '-h') flags.help = true
  else if (a === '--file') {
    flags.file = rawArgv[++i] ?? null
    if (!flags.file) usage('--file 后面需要跟文件路径')
  } else argv.push(a)
}

function usage(err) {
  // 头两行与旧版逐字一致（外部文档/肌肉记忆认它）；err 给具体差错，别让人对着通用用法猜
  console.error('用法: node scripts/areco-msg.mjs <team> <from> <to> <消息...>')
  console.error('      node scripts/areco-msg.mjs <team> history [N]')
  console.error('      node scripts/areco-msg.mjs rooms [--all] ｜ members <team>')
  console.error('      长消息/多行消息：<team> <from> <to> --stdin（或 --file <路径>）')
  console.error('      其他 flag：--human-relay --dry-run --strict；exit code 见脚本头部注释')
  if (err) console.error(`✗ ${err}`)
  process.exit(err ? EXIT.usage : EXIT.ok)
}
if (flags.help) usage()

const root = process.env.ARECO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = resolve(root, 'data')
const dbPath = resolve(dataDir, 'tasks.db')
const roomsPath = resolve(dataDir, 'rooms.json')
const configPath = resolve(root, 'config.json')

const SCHEMA = `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  human_relay INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_team_history ON messages(team, id);
CREATE INDEX IF NOT EXISTS idx_team_created ON messages(team, created_at);`
// SCHEMA 与服务端 project-db.ts 的 messages 定义对齐（含 human_relay 列与两索引）：
// CLI 新建的测试库不再是缺列缺索引的旧结构；既有旧库走下方 ALTER 兜底，双向幂等

const BUSY_MS = Math.max(0, Number(process.env.ARECO_MSG_BUSY_MS ?? 3000) || 0)

function openDb() {
  const db = new DatabaseSync(dbPath)
  // busy_timeout 先设：journal_mode=WAL 本身就可能要拿锁（服务端 P2-10 同款顺序修正）
  db.exec(`PRAGMA busy_timeout=${BUSY_MS}; PRAGMA journal_mode=WAL;`)
  db.exec(SCHEMA)
  return db
}

function loadJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
/** rooms.json（服务端房间花名册 SoT，原子写）；不可读/不存在返回 null = 跳过校验 */
function loadRooms() {
  const j = loadJsonSafe(roomsPath)
  return Array.isArray(j) ? j : null
}
/** config.json 里 CLI 关心的三样：端口（healthz 探测）、转述白名单、人类名 */
function serverConf() {
  const j = loadJsonSafe(configPath) ?? {}
  return {
    port: Number(j?.server?.port) || 8790,
    relayAgents: Array.isArray(j?.humanRelayAgents) ? j.humanRelayAgents.map(String) : [],
  }
}

/** sqlite/系统错误 → 可区分 exit code + 一句话诊断（errcode 是 SQLite 原生错误码） */
function classify(err) {
  const m = String(err?.message ?? err)
  const code = typeof err?.errcode === 'number' ? err.errcode : -1
  const sys = typeof err?.code === 'string' ? err.code : ''
  if (code === 5 || code === 6 || /database is locked|database table is locked/i.test(m))
    return { exit: EXIT.busy, label: '数据库忙（写锁被占）' }
  if (code === 13 || sys === 'ENOSPC' || /database or disk is full/i.test(m))
    return { exit: EXIT.io, label: '磁盘满/IO 错误' }
  if (code === 8 || sys === 'EACCES' || sys === 'EPERM' || sys === 'EROFS' || /readonly database/i.test(m))
    return { exit: EXIT.perm, label: '无写权限' }
  // SQLITE_CANTOPEN(14)天然多义：权限、路径、fd 耗尽之外，满盘上重建 -wal 也报它
  //（2026-07-31 满盘实测：一次性 CLI 关库时 checkpoint 已删 -wal，下次开库重建失败走 14 不走 13）
  if (code === 14 || /unable to open database/i.test(m))
    return { exit: EXIT.perm, label: '无法打开数据库文件（权限不足/磁盘满/路径不存在）' }
  if (code === 11 || code === 26 || /malformed|not a database/i.test(m))
    return { exit: EXIT.dataErr, label: '数据库损坏' }
  return { exit: EXIT.db, label: '数据库错误' }
}

/** 写库带重试：仅 busy 类重试（其余错误重试无意义），每次全新连接 */
async function withBusyRetry(fn) {
  const delays = [300, 800]
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (err) {
      if (classify(err).exit !== EXIT.busy || i >= delays.length) throw err
      console.error(`（数据库忙，第 ${i + 1} 次重试，等 ${delays[i]}ms）`)
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
}

function dieDb(err, doing) {
  const c = classify(err)
  console.error(`✗ ${c.label}：${doing}失败 —— ${String(err?.message ?? err)}`)
  if (c.exit === EXIT.busy) console.error('  已自动重试 3 次仍拿不到写锁；持锁方通常是长事务，稍后重跑本命令即可')
  if (c.exit === EXIT.io) console.error('  先 df -h 查磁盘剩余；WAL 写入需要 db 同目录可写可扩')
  if (c.exit === EXIT.perm) console.error(`  检查权限与磁盘（df -h）：${dbPath}（及其 -wal/-shm 同目录需可写可扩）`)
  if (c.exit === EXIT.dataErr) console.error('  库疑似损坏：停止写入并通知维护者，勿删库（先备份再修复）')
  process.exit(c.exit)
}

/** team 不存在的统一出口：给候选与自查命令，不让人对着房号猜 */
function dieTeamNotFound(team, roomsList) {
  console.error(`✗ team「${team}」不存在：rooms.json（${roomsList.length} 个房间）查无此项——写进去也永远无人拾取投递`)
  const head = team.slice(0, 9)
  const cand = roomsList.filter((r) => r.team.startsWith(head) || (r.name && r.name.includes(team))).slice(0, 3)
  if (cand.length) console.error(`  是不是想找：${cand.map((r) => `${r.team}（${r.name}）`).join('、')}`)
  console.error('  全量清单：node scripts/areco-msg.mjs rooms')
  process.exit(EXIT.teamNotFound)
}

// ---- rooms 子命令：在册房间清单（读 rooms.json + 各房最后消息时间）----
if (argv[0] === 'rooms' && argv.length === 1) {
  const roomsList = loadRooms()
  if (!roomsList) {
    console.error(`✗ 无法读取 ${roomsPath}（不存在或非法 JSON）`)
    process.exit(EXIT.db)
  }
  const lastAts = {}
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath)
      try {
        db.exec(`PRAGMA busy_timeout=${BUSY_MS};`)
        for (const r of db.prepare('SELECT team, MAX(created_at) AS last FROM messages GROUP BY team').all())
          lastAts[String(r.team)] = String(r.last)
      } finally {
        db.close()
      }
    } catch {
      /* 只影响排序展示，读不到就不排 */
    }
  }
  const shown = roomsList.filter((r) => flags.all || r.archivedAt == null)
  shown.sort((a, b) => String(lastAts[b.team] ?? b.createdAt ?? '').localeCompare(String(lastAts[a.team] ?? a.createdAt ?? '')))
  for (const r of shown) {
    const when = (lastAts[r.team] ?? '').replace('T', ' ')
    const members = (r.members ?? []).map((m) => `${m.name}(${m.kind})`).join('、')
    console.log(`${r.team}  [${r.kind ?? '?'}${r.archivedAt ? '·已归档' : ''}]  ${when ? `最近 ${when}  ` : ''}${r.name}  成员: ${members || '（无）'}`)
  }
  console.error(`（共 ${shown.length} 个${flags.all ? '' : '未归档'}房间${flags.all ? '' : '；--all 含归档'}，按最近消息排序）`)
  process.exit(EXIT.ok)
}

// ---- members 子命令：房间花名册（to 需精确匹配成员名；kind=session 才会被注入投递）----
if (argv[0] === 'members') {
  const team = argv[1]
  if (!team) usage('members 需要跟 <team>')
  const roomsList = loadRooms()
  if (!roomsList) {
    console.error(`✗ 无法读取 ${roomsPath}（不存在或非法 JSON）`)
    process.exit(EXIT.db)
  }
  const room = roomsList.find((r) => r.team === team)
  if (!room) dieTeamNotFound(team, roomsList)
  console.log(`房间「${room.name}」（${room.team}，${room.kind ?? '?'}${room.archivedAt ? '，已归档' : ''}）`)
  for (const m of room.members ?? [])
    console.log(`  ${m.name}  kind=${m.kind}${m.sessionId ? `  session=${String(m.sessionId).slice(0, 8)}` : ''}`)
  console.error('（to 需精确匹配成员名，all=广播全体；kind=session 才会被注入投递，human 走页面查看）')
  process.exit(EXIT.ok)
}

const team = argv[0]
if (!team) usage('缺少 <team>')

// ---- 查历史分支：共享上下文的主动查询入口（stdout 格式冻结，caller/agent 守则依赖）----
if (argv[1] === 'history') {
  if (argv[2] !== undefined && !/^\d+$/.test(String(argv[2])))
    console.error(`（history 条数「${argv[2]}」不是数字，按默认 20）`)
  const limit = Math.max(1, Number(argv[2]) || 20)
  let db
  try {
    mkdirSync(dataDir, { recursive: true })
    db = openDb() // 房间从未发过消息时表可能不存在：建空表兜底防 SELECT 报错
  } catch (err) {
    dieDb(err, '打开数据库')
  }
  try {
    const rows = db.prepare('SELECT * FROM messages WHERE team=? ORDER BY id DESC LIMIT ?').all(team, limit)
    if (!rows.length) {
      console.log(`（项目 ${team} 暂无消息）`)
      const roomsList = loadRooms()
      if (roomsList && !roomsList.some((r) => r.team === team))
        console.error(`（提示：rooms.json 查无 team「${team}」，rooms 子命令可列全量房间）`)
    } else {
      for (const r of rows.reverse()) {
        // 升序打印（旧→新），方便通读来龙去脉
        const when = String(r.created_at).replace('T', ' ').replace(/(\d{2}:\d{2}):\d{2}Z$/, '$1Z')
        console.log(`[${when}] ${r.from_agent} → ${r.to_agent}`)
        console.log(`  ${String(r.body).replace(/\s*\r?\n\s*/g, '；')}`)
      }
    }
  } finally {
    db.close()
  }
  process.exit(EXIT.ok)
}

// ---- 发消息分支 ----
const from = argv[1]
const to = argv[2]
if (flags.stdin && flags.file) usage('--stdin 与 --file 只能二选一')
let body
if (flags.stdin) {
  if (process.stdin.isTTY) usage('--stdin 需要管道/重定向输入（如 printf "…" | node scripts/areco-msg.mjs …）')
  if (argv.length > 3) usage('用了 --stdin 就不要再在命令行带 <消息...>（二者取谁会歧义）')
  body = readFileSync(0, 'utf8')
} else if (flags.file) {
  if (argv.length > 3) usage('用了 --file 就不要再在命令行带 <消息...>（二者取谁会歧义）')
  try {
    body = readFileSync(flags.file, 'utf8')
  } catch (err) {
    usage(`--file 读取失败：${String(err?.message ?? err)}`)
  }
} else {
  body = argv.slice(3).join(' ') // 旧行为：多参数拼单空格；要保换行用 --stdin/--file
}
body = body.trim()
if (!from || !to || !body) usage(!from || !to ? '缺少 <from>/<to>' : '正文为空')

// ---- 发送前校验：黑洞消息（team 错/归档/成员名错）拦在写库前，而不是写完 ok 了事 ----
const conf = serverConf()
const roomsList = loadRooms()
let room = null
const strictHits = []
if (roomsList) {
  room = roomsList.find((r) => r.team === team) ?? null
  if (!room) dieTeamNotFound(team, roomsList)
  if (room.archivedAt != null) {
    console.error(`✗ 房间「${room.name}」已归档（${room.archivedAt}）：服务端对归档房不投递，恢复时游标快进也不补投——恢复房间后再发`)
    process.exit(EXIT.archived)
  }
  const names = (room.members ?? []).map((m) => m.name)
  if (to !== 'all' && !names.includes(to)) {
    console.error(`⚠️ to「${to}」不是房间「${room.name}」成员：消息会落库、页面可见，但不会注入任何会话`)
    console.error(`  在册成员：${(room.members ?? []).map((m) => `${m.name}(${m.kind})`).join('、') || '（无）'}（自查：members ${team}）`)
    strictHits.push('to 非房内成员')
  }
  if (!names.includes(from))
    console.error(`（from「${from}」不在成员表：作外部署名合法、仅作显示；但房内串行轮转只认成员名，成员回执别打错自己名字）`)
} else {
  console.error(`（rooms.json 不可读（${roomsPath}），跳过 team/成员校验）`)
}
if (flags.humanRelay && !conf.relayAgents.includes(from)) {
  console.error(`⚠️ from「${from}」不在转述白名单 ${JSON.stringify(conf.relayAgents)}：服务端将忽略 --human-relay，按普通 agent 消息处理`)
  strictHits.push('human-relay 白名单外')
}
if (body.length > 8000)
  console.error(`⚠️ 正文 ${body.length} 字符：投递时会全文注入目标会话终端，超长内容建议落盘后改发文件路径`)
if (flags.strict && strictHits.length) {
  console.error(`✗ --strict：${strictHits.length} 项校验未过（${strictHits.join('、')}），未写库`)
  process.exit(EXIT.strict)
}

if (flags.dryRun) {
  const memberTag = (name) => {
    if (!room) return '（未校验）'
    if (name === 'all') return '（广播全体）'
    const m = (room.members ?? []).find((x) => x.name === name)
    return m ? `（成员，kind=${m.kind}）` : '（非成员）'
  }
  console.log('[dry-run] 未写库；路由预览：')
  console.log(`  房间: ${room ? `${room.name}（${team}，${room.kind ?? '?'}）` : `${team}（rooms.json 不可读，未校验）`}`)
  console.log(`  from: ${from}${memberTag(from)}`)
  console.log(`  to:   ${to}${memberTag(to)}`)
  console.log(`  正文: ${body.length} 字符，含 ${(body.match(/\n/g) ?? []).length} 个换行${flags.humanRelay ? '；human-relay 标记' : ''}`)
  process.exit(EXIT.ok)
}

try {
  mkdirSync(dataDir, { recursive: true })
  await withBusyRetry(() => {
    const db = openDb()
    try {
      // 旧库缺 human_relay 列（服务端未升级/未重启过）：就地补列再写，与服务端迁移幂等
      const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name)
      if (!cols.includes('human_relay')) db.exec('ALTER TABLE messages ADD COLUMN human_relay INTEGER NOT NULL DEFAULT 0')
      db.prepare('INSERT INTO messages (team, from_agent, to_agent, body, human_relay) VALUES (?, ?, ?, ?, ?)').run(team, from, to, body, flags.humanRelay ? 1 : 0)
    } finally {
      db.close()
    }
  })
} catch (err) {
  dieDb(err, '写入消息')
}
console.log(flags.humanRelay ? 'ok (human-relay)' : 'ok')

// ---- 落库后探活：写库 ≠ 送达。服务端不在线时给出明确警告（07-30 OCR 晨报事故的核心诉求：
// 投递失败要能被发现）。ARECO_ROOT 指向别处且那份根没有自己的 config.json 时端口无从得知，跳过 ----
if (!process.env.ARECO_MSG_NO_PING && !(process.env.ARECO_ROOT && !existsSync(configPath))) {
  try {
    await fetch(`http://127.0.0.1:${conf.port}/healthz`, { signal: AbortSignal.timeout(800) })
  } catch {
    console.error(`⚠️ areco 服务端（127.0.0.1:${conf.port}/healthz）未响应：消息已落库、页面可见，但离线期间不投递，服务端重启后为防重放也不补投——需送达请在服务端恢复后重发本条`)
  }
}
process.exit(EXIT.ok)
