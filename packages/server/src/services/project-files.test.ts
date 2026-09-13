import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileService } from './files'
import { ProjectFileService } from './project-files'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-project-files-'))
const root = path.join(base, 'case')
const outside = path.join(base, 'outside')
fs.mkdirSync(path.join(root, '6庭后补充'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(root, 'README.md'), '# case')
fs.writeFileSync(path.join(root, '6庭后补充', '赔偿项目明细.docx'), 'docx')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
fs.symlinkSync(outside, path.join(root, '逃逸链接'))

const service = new ProjectFileService(new FileService(() => [base]))

test('项目 Files 懒加载目录并按目录优先排序', () => {
  const result = service.list(root)
  assert.equal(result.rootPath, fs.realpathSync(root))
  assert.deepEqual(result.items.map((item) => item.name), ['6庭后补充', 'README.md'])
  assert.equal(result.items[0].kind, 'directory')

  const nested = service.list(root, '6庭后补充')
  assert.deepEqual(nested.items.map((item) => item.relativePath), ['6庭后补充/赔偿项目明细.docx'])
})

test('项目 Files 搜索返回相对路径，并跳过指向项目外的软链', () => {
  const result = service.search(root, '赔偿')
  assert.deepEqual(result.items.map((item) => item.relativePath), ['6庭后补充/赔偿项目明细.docx'])
  assert.equal(service.list(root).items.some((item) => item.name === '逃逸链接'), false)
})

test('项目 Files 拒绝 ../ 穿越项目根目录', () => {
  assert.throws(() => service.list(root, '../outside'), /超出项目根目录/)
})
