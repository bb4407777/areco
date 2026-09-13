import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepForDir } from './dir-sweep'

// 模拟「刚新建、Spotlight 还没索引」的目录树——sweep 不依赖任何索引，纯 readdir 实扫
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-dir-sweep-'))
fs.mkdirSync(path.join(base, 'Desktop', '咨询', '未命名文件夹'), { recursive: true })
fs.writeFileSync(path.join(base, 'Desktop', '咨询', '未命名文件夹', '微信图片_1.jpg'), 'x')
fs.mkdirSync(path.join(base, 'Desktop', '旧案', '未命名文件夹'), { recursive: true }) // 同名但子项不符
fs.mkdirSync(path.join(base, 'Desktop', '.backups', '未命名文件夹'), { recursive: true }) // 点目录里的不该被扫到
fs.writeFileSync(path.join(base, 'Desktop', '.backups', '未命名文件夹', '占位'), '')
const roots = [path.join(base, 'Desktop')]

test('sweep 按目录名+首层子项核验命中，未索引也能定位', async () => {
  const found = await sweepForDir('未命名文件夹', ['微信图片_1.jpg'], { roots })
  assert.deepEqual(found, [path.join(base, 'Desktop', '咨询', '未命名文件夹')])
})

test('sweep 无 samples 时返回全部同名可见目录，浅层在前', async () => {
  fs.mkdirSync(path.join(base, 'Desktop', '未命名文件夹'), { recursive: true })
  const found = await sweepForDir('未命名文件夹', [], { roots })
  assert.equal(found[0], path.join(base, 'Desktop', '未命名文件夹')) // depth 1 先于 depth 2
  assert.equal(found.length, 3) // .backups 里的不出现
  assert.ok(found.every((p) => !p.includes('.backups')))
})

test('sweep NFC/NFD 归一：磁盘 NFD 名也能被 NFC 查询命中', async () => {
  const nfd = 'café'.normalize('NFD')
  fs.mkdirSync(path.join(base, 'Desktop', nfd, 'inner'), { recursive: true })
  const found = await sweepForDir('café'.normalize('NFC'), ['inner'], { roots })
  assert.equal(found.length, 1)
  assert.equal(path.basename(found[0]).normalize('NFC'), 'café')
})

test('sweep 根自身同名也算候选', async () => {
  const found = await sweepForDir('Desktop', [], { roots })
  assert.deepEqual(found, [path.join(base, 'Desktop')])
})

test('sweep maxDepth 之外的不下钻', async () => {
  const found = await sweepForDir('未命名文件夹', ['微信图片_1.jpg'], { roots, maxDepth: 1 })
  assert.deepEqual(found, []) // 目标在 depth 2
})
