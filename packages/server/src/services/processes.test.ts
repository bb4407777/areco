import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSnapshot,
  classify,
  etimeToSec,
  parseLaunchdPids,
  parsePs,
} from './processes'

const UID = 501

// ps 一行：pid ppid pgid uid stat cpu mem rss etime command
const psOut = [
  '  101     1   101   501 S    0.0  0.4  65000 22:30:44 node /x/cli/bin/codebuddy --acp --model m',
  '  102   900   102   501 S    0.0  0.2  30000 01:00:00 node /x/cli/bin/codebuddy --acp --model m',
  '  103     1   103   501 S    0.0  0.1  20000 3-04:00:00 /usr/libexec/foo --bar',
  '  104     1   104   501 R    2.5  1.0  90000 00:10:00 node /x/skills/opc/scripts/pi-worker.py',
  '  105     1   105     0 S    0.0  0.1  10000 10:00:00 /sbin/launchd',
].join('\n')

test('ps 行解析：命令里的空格不截断', () => {
  const procs = parsePs(psOut)
  assert.equal(procs.length, 5)
  assert.equal(procs[0].pid, 101)
  assert.equal(procs[0].ppid, 1)
  assert.equal(procs[0].rssKb, 65000)
  assert.ok(procs[0].command.includes('--model m'))
})

test('etime → 秒：分/时/天三档', () => {
  assert.equal(etimeToSec('00:10'), 10)
  assert.equal(etimeToSec('01:00:00'), 3600)
  assert.equal(etimeToSec('3-04:00:00'), 3 * 86400 + 4 * 3600)
})

test('分类：服务/后台/CLI/其他', () => {
  assert.equal(classify('/Users/gao/Code/areco/packages/server/dist/index.js').kind, 'service')
  assert.equal(classify('/opt/homebrew/bin/python3 -m server.acp_bridge').label, 'ACP 桥 :8647')
  assert.equal(classify('/x/skills/cc-connect/bin/cc-connect').kind, 'service')
  assert.equal(classify('node /x/skills/opc/scripts/pi-worker.py').kind, 'worker')
  assert.equal(classify('node /x/cli/bin/codebuddy --acp').kind, 'cli')
  assert.equal(classify('/usr/bin/vim foo.txt').kind, 'other')
})

test('launchctl list：PID 列为 - 的跳过', () => {
  const out = 'PID\tStatus\tLabel\n101\t0\tcom.a\n-\t78\tcom.b\n102\t0\tcom.c\n'
  const pids = parseLaunchdPids(out)
  assert.deepEqual([...pids].sort((a, b) => a - b), [101, 102])
})

test('孤儿判据：PPID=1 且非 launchd、非系统路径、属当前用户', () => {
  const snap = buildSnapshot(parsePs(psOut), new Set([103]), UID)
  const byPid = new Map(snap.rows.map((r) => [r.pid, r]))
  assert.equal(byPid.get(101)?.orphan, true) // 父没了、也不是 launchd 托管
  assert.equal(byPid.get(101)?.killable, true)
  assert.equal(byPid.get(102)?.orphan, false) // 有爹
  assert.equal(byPid.get(103)?.orphan, false) // launchd 托管（PID 在表里）
  assert.equal(byPid.get(104)?.orphan, true) // 后台任务也可以是孤儿
  assert.equal(byPid.get(105), undefined) // 别人的进程不进列表（uid=0）
  assert.equal(snap.orphanCount, 2)
  assert.equal(snap.orphanRss, (65000 + 90000) * 1024)
  // 孤儿排最前，且按内存降序
  assert.deepEqual(snap.rows.map((r) => r.pid), [104, 101, 102, 103])
})

test('App helper / 常驻进程不算孤儿（实测踩过的误判）', () => {
  const helpers = [
    '  301     1   301   501 S    0.0  0.1  20000 01:00:00 /Applications/WeChat.app/Contents/Frameworks/crashpad_handler --no-rate-limit',
    '  302     1   302   501 S    0.0  0.1  20000 01:00:00 /Library/Input Methods/WeType.app/Contents/PlugIns/WeTypeFinderSync.appex/Contents/MacOS/WeTypeFinderSync',
    '  303     1   303   501 S    0.0  0.1  20000 01:00:00 adb -L tcp:5037 fork-server server --reply-fd 4',
    '  304     1   304   501 S    0.0  0.1  30000 02:00:00 /Users/gao/.pg0/installation/18.1.0/bin/postgres -D /Users/gao/.pg0/instances/hindsight/data',
  ].join('\n')
  const snap = buildSnapshot(parsePs(helpers), new Set(), UID)
  assert.equal(snap.orphanCount, 0, snap.rows.filter((r) => r.orphan).map((r) => r.pid).join(','))
})

test('僵尸进程不算孤儿', () => {
  const zombie = '  201     1   201   501 Z    0.0  0.0   1000 05:00:00 node /x/cli/bin/codebuddy --acp\n'
  const snap = buildSnapshot(parsePs(zombie), new Set(), UID)
  assert.equal(snap.orphanCount, 0)
})
