import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { localDay, parseRunsText, snapshot, taskLog, todayStats } from './opc'

test('台账逐行解析：坏行跳过，最新在前，按上限截断', () => {
  const text = [
    JSON.stringify({ ts: '2026-11-07T10:00:00', task_id: 't_1', title: '一', track: 'a', tracks: 'a', ok: true, dur_s: 3 }),
    '{"task_id":"t_broken"',
    JSON.stringify({ ts: '2026-11-07T10:05:00', task_id: 't_2', title: '二', track: 'c', tracks: 'a→b→c', ok: false, err_kind: 'quota', fallback: 2 }),
  ].join('\n')
  const runs = parseRunsText(text, 10)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].taskId, 't_2')
  assert.equal(runs[0].tracks, 'a→b→c')
  assert.equal(runs[0].fallback, 2)
  assert.equal(runs[1].taskId, 't_1')
  assert.equal(runs[1].engine, '')
  assert.equal(parseRunsText(text, 1).length, 1)
})

function localTs(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fixture(): { root: string; logs: string } {
  const NOW = Math.floor(Date.now() / 1000)
  const TODAY_TS = localTs()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-opc-'))
  const logs = path.join(root, 'logs')
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.mkdirSync(logs, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'data', 'track-runs.jsonl'),
    `${JSON.stringify({ ts: TODAY_TS, task_id: 't_abc', dept: 'recording', title: '录音', track: 'codebuddy-ds', tracks: 'qoder-cn→codebuddy-ds', engine: 'codebuddy', model: 'ds', ok: true, dur_s: 12, fallback: 1 })}\n`
  )
  fs.writeFileSync(
    path.join(root, 'config', 'tracks.json'),
    JSON.stringify({
      default_prefs: ['codebuddy-ds', 'qoder-cn'],
      tracks: {
        'codebuddy-ds': { engine: 'codebuddy', model: 'ds', label: 'CodeBuddy × DS' },
        'qoder-cn': { engine: 'qoder', model: 'qwen', label: 'Qoder × Qwen' },
      },
    })
  )
  fs.writeFileSync(
    path.join(root, 'data', 'track-health.json'),
    JSON.stringify({
      'codebuddy-ds': { used: 9, fallback: 1, last_error_kind: 'quota', cooldown_until: 1 },
      'qoder-cn': { used: 3, consecutive_failures: 2, last_error_kind: 'quota', cooldown_until: 9999999999 },
    })
  )
  const db = new DatabaseSync(path.join(root, 'data', 'kanban.db'))
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL, priority INTEGER,
    created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
    consecutive_failures INTEGER DEFAULT 0, last_failure_error TEXT, worker_pid INTEGER)`)
  db.prepare(
    'INSERT INTO tasks (id,title,assignee,status,priority,created_at,consecutive_failures,last_failure_error) VALUES (?,?,?,?,?,?,?,?)'
  ).run('t_abc', '录音纪要', 'recording', 'ready', 0, NOW, 1, '限流')
  db.prepare(
    'INSERT INTO tasks (id,title,assignee,status,priority,created_at) VALUES (?,?,?,?,?,?)'
  ).run('t_done', '已办', 'wechat', 'done', 0, NOW)
  db.close()
  fs.writeFileSync(path.join(logs, 't_abc.log'), 'line1\nline2\nline3\n')
  return { root, logs }
}

test('快照：轨健康/在办工单/跑单三块拼齐，完成单不进在办', () => {
  const { root, logs } = fixture()
  const prevRoot = process.env.ARECO_OPC_ROOT
  const prevLogs = process.env.ARECO_OPC_LOGS
  process.env.ARECO_OPC_ROOT = root
  process.env.ARECO_OPC_LOGS = logs
  try {
    const snap = snapshot()
    assert.equal(snap.warning, undefined)
    assert.equal(snap.runs.length, 1)
    assert.equal(snap.tasks.length, 1)
    assert.equal(snap.tasks[0].id, 't_abc')
    assert.equal(snap.tasks[0].hasLog, true)
    assert.equal(snap.counts.done, 1)
    assert.equal(snap.tracks.length, 2)
    assert.equal(snap.tracks[0].status, 'ok')
    assert.equal(snap.tracks[1].status, 'cooldown')
    // 今日统计：台账里那一单是今天、且成功，落在最终轨 codebuddy-ds
    assert.equal(snap.today.runs, 1)
    assert.equal(snap.today.ok, 1)
    assert.equal(snap.tracks[0].usedToday, 1)
    assert.equal(snap.tracks[1].usedToday, 0)
    assert.equal(snap.tracks[0].used, 9) // 累计值仍在，只是不再展示
  } finally {
    if (prevRoot === undefined) delete process.env.ARECO_OPC_ROOT
    else process.env.ARECO_OPC_ROOT = prevRoot
    if (prevLogs === undefined) delete process.env.ARECO_OPC_LOGS
    else process.env.ARECO_OPC_LOGS = prevLogs
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('工人日志：只回尾部行，非法 id 直接拒', () => {
  const { root, logs } = fixture()
  const prevLogs = process.env.ARECO_OPC_LOGS
  process.env.ARECO_OPC_LOGS = logs
  try {
    const got = taskLog('t_abc', 2)
    assert.deepEqual(got.lines, ['line2', 'line3'])
    assert.equal(got.truncated, true)
    assert.throws(() => taskLog('../etc/passwd'), /不合法/)
  } finally {
    if (prevLogs === undefined) delete process.env.ARECO_OPC_LOGS
    else process.env.ARECO_OPC_LOGS = prevLogs
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('今日统计：只数当天、按最终轨归集、坏日期不计', () => {
  const runs = [
    { ts: '2026-11-07T09:00:00', taskId: 't_1', track: 'qoder-cn', ok: true },
    { ts: '2026-11-07T23:59:59', taskId: 't_2', track: 'qoder-cn', ok: false },
    { ts: '2026-11-06T23:59:59', taskId: 't_3', track: 'qoder-cn', ok: true },
    { ts: '', taskId: 't_4', track: 'codebuddy-ds', ok: true },
  ] as Parameters<typeof todayStats>[0]
  const got = todayStats(runs, '2026-11-07')
  assert.equal(got.runs, 2)
  assert.equal(got.ok, 1)
  assert.deepEqual(got.byTrack, { 'qoder-cn': 2 })
  assert.equal(localDay(new Date(2026, 10, 7, 0, 5)), '2026-11-07')
})

test('在办只看当天：更早的工单不入列也不计数', () => {
  const { root, logs } = fixture()
  const db = new DatabaseSync(path.join(root, 'data', 'kanban.db'))
  const old = Math.floor(Date.now() / 1000) - 3 * 86400
  db.prepare('INSERT INTO tasks (id,title,assignee,status,priority,created_at) VALUES (?,?,?,?,?,?)').run(
    't_old', '三天前的单', 'recording', 'ready', 0, old
  )
  db.close()
  const prevRoot = process.env.ARECO_OPC_ROOT
  const prevLogs = process.env.ARECO_OPC_LOGS
  process.env.ARECO_OPC_ROOT = root
  process.env.ARECO_OPC_LOGS = logs
  try {
    const snap = snapshot()
    assert.deepEqual(snap.tasks.map((t) => t.id), ['t_abc'])
    assert.equal(snap.counts.ready, 1)
  } finally {
    if (prevRoot === undefined) delete process.env.ARECO_OPC_ROOT
    else process.env.ARECO_OPC_ROOT = prevRoot
    if (prevLogs === undefined) delete process.env.ARECO_OPC_LOGS
    else process.env.ARECO_OPC_LOGS = prevLogs
    fs.rmSync(root, { recursive: true, force: true })
  }
})
