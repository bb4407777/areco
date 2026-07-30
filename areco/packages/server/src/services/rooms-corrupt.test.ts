// rooms.json 读坏时的行为。单独一个文件：要在 import config.ts 之前把 ARECO_ROOT
// 指到临时目录，否则会动到真的 data/rooms.json（39 个项目 73 个成员绑定）。
//
// 守的是什么（2026-07-26 修）：load() 遇 JSON 解析失败原先只 log.error 然后返回 []，
// 而 save() 会把这个 [] 原样写回去 —— **一次解析失败就把所有项目和成员绑定永久抹掉**，
// 现象上只是「项目列表空了」，没人会想到是被自己覆盖的。
// 而 atomicWrite 当时没有 fsync，掉电正好能留下一个已改名但内容截断的 rooms.json，
// 也就是上述路径的触发条件 —— 两个缺陷正好首尾相接。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-rooms-corrupt-'))
process.env.ARECO_ROOT = tmpRoot

const { RoomStore } = await import('./rooms')
const { DATA_DIR } = await import('../config')

const ROOMS_PATH = path.join(DATA_DIR, 'rooms.json')
assert.ok(ROOMS_PATH.startsWith(tmpRoot), `没被 ARECO_ROOT 改到临时目录: ${ROOMS_PATH}`)

function writeRooms(content: string) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(ROOMS_PATH, content, 'utf8')
}

function cleanup() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

test('好文件正常读写往返', () => {
  cleanup()
  const s1 = new RoomStore()
  const room = s1.create('项目甲')
  assert.equal(s1.list().length, 1)
  // 新实例应读到刚写的
  const s2 = new RoomStore()
  assert.equal(s2.list().length, 1)
  assert.equal(s2.list()[0].name, '项目甲')
  assert.equal(s2.list()[0].id, room.id)
})

test('坏 JSON 被留证，不被空名单覆盖', () => {
  cleanup()
  writeRooms('{"这不是数组": ')  // 截断的 JSON，模拟掉电
  const store = new RoomStore()
  assert.equal(store.list().length, 0, '读不出来就是空的（原行为）')

  // 关键：坏文件必须被留证，而不是被后续写入静默盖掉
  const corrupt = fs.readdirSync(DATA_DIR).filter((f) => f.includes('.corrupt-'))
  assert.equal(corrupt.length, 1, `应留下一个 .corrupt- 留证文件，实得 ${corrupt.join(',')}`)
  assert.match(fs.readFileSync(path.join(DATA_DIR, corrupt[0]), 'utf8'), /这不是数组/,
    '留证文件应保有原始坏内容')
})

test('顶层不是数组同样留证', () => {
  cleanup()
  writeRooms('{"rooms": []}')  // 合法 JSON 但不是数组
  const store = new RoomStore()
  assert.equal(store.list().length, 0)
  assert.equal(fs.readdirSync(DATA_DIR).filter((f) => f.includes('.corrupt-')).length, 1)
})

test('留证后可正常重建，新数据不受影响', () => {
  cleanup()
  writeRooms('坏得彻底')
  const store = new RoomStore()
  const room = store.create('留证后新建的项目')
  // 留证成功 = 原文件已不在，之后写的是全新文件，不会覆盖任何东西
  const reloaded = new RoomStore()
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].id, room.id)
})

test('留证失败时拒绝写入（不能拿空名单盖好数据）', () => {
  cleanup()
  writeRooms('坏文件')
  // 让 rename 失败：把 DATA_DIR 设为只读，quarantine 留不了证
  fs.chmodSync(DATA_DIR, 0o500)
  try {
    const store = new RoomStore()
    assert.equal(store.list().length, 0)
    // 此时 loadFailed 仍为 true → save 必须拒写，原坏文件保持原样
    fs.chmodSync(DATA_DIR, 0o700) // 放开权限，确认拒写不是因为权限
    store.create('不该被写进去')
    assert.equal(fs.readFileSync(ROOMS_PATH, 'utf8'), '坏文件',
      '留证失败时 save() 必须拒写，原文件内容应完好')
  } finally {
    fs.chmodSync(DATA_DIR, 0o700)
  }
})

test('atomicWrite 写出的是完整可解析 JSON（fsync 路径没写坏文件）', () => {
  cleanup()
  const store = new RoomStore()
  store.create('甲')
  store.create('乙')
  const raw = fs.readFileSync(ROOMS_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.length, 2)
  assert.ok(raw.endsWith('\n'), '应以换行结尾')
  assert.ok(!fs.existsSync(ROOMS_PATH + '.tmp'), 'tmp 文件应已被 rename 掉')
})
