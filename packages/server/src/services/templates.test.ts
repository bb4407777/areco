// shellQuote/buildShellCommand 转义单测（zsh -ilc 注入面是本项目最敏感的一行字符串）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shellQuote, buildShellCommand, effectiveTranscriptDir, probeTranscriptDir, reorderTemplates } from './templates'
import type { Template } from '../../../shared/protocol'

test('shellQuote 基本包裹', () => {
  assert.equal(shellQuote('abc'), `'abc'`)
  assert.equal(shellQuote('a b'), `'a b'`)
})

test('shellQuote 单引号', () => {
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`)
})

test('危险字符经真实 zsh round-trip 后原样保留', () => {
  const cases = [
    'hello world',
    `it's a trap`,
    '$HOME `whoami` $(id)',
    '中文 参数',
    'semi;colon && pipe | redirect > /tmp/x',
    '--sandbox',
    'danger-full-access',
    `mix'ed "quo\`tes$ \\backslash`,
  ]
  for (const input of cases) {
    const out = execFileSync('/bin/zsh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' })
    assert.equal(out, input, `round-trip 失败: ${JSON.stringify(input)}`)
  }
})

test('buildShellCommand 组装 exec 前缀', () => {
  assert.equal(buildShellCommand('claude', ['--session-id', 'abc']), `exec 'claude' '--session-id' 'abc'`)
})

test('reorderTemplates 按 ids 重排且只认完整排列', () => {
  const tpl = (id: string): Template =>
    ({ id, name: id, command: 'x', args: [], cwd: '/', color: '#000', autoStart: false, enabled: true })
  const list = [tpl('a'), tpl('b'), tpl('c')]
  assert.deepEqual(reorderTemplates(list, ['c', 'a', 'b']).map((t) => t.id), ['c', 'a', 'b'])
  // 非法输入全拒绝：缺项 / 多项 / 重复 / 未知 id
  assert.throws(() => reorderTemplates(list, ['a', 'b']))
  assert.throws(() => reorderTemplates(list, ['a', 'b', 'c', 'd']))
  assert.throws(() => reorderTemplates(list, ['a', 'a', 'b']))
  assert.throws(() => reorderTemplates(list, ['a', 'b', 'x']))
})

test('probeTranscriptDir 按约定目录自动探测（含去 cli/cn 后缀变体），探不到返回 null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-probe-'))
  // qoderclicn 形态：~/.qoder-cn/projects（靠去后缀变体命中）
  fs.mkdirSync(path.join(home, '.qoder-cn', 'projects'), { recursive: true })
  assert.equal(probeTranscriptDir('qoderclicn', home), path.join(home, '.qoder-cn', 'projects'))
  // 直接形态：~/.foo/projects
  fs.mkdirSync(path.join(home, '.foo', 'projects'), { recursive: true })
  assert.equal(probeTranscriptDir('/usr/local/bin/foo', home), path.join(home, '.foo', 'projects'))
  // -cn 直挂形态：~/.bar-cn/projects
  fs.mkdirSync(path.join(home, '.bar-cn', 'projects'), { recursive: true })
  assert.equal(probeTranscriptDir('bar', home), path.join(home, '.bar-cn', 'projects'))
  // 探不到
  assert.equal(probeTranscriptDir('nonexistent-cli', home), null)
})

test('effectiveTranscriptDir：显式 transcriptDir 优先；claude 系返回 null', () => {
  const tpl = (over: Partial<Template>): Template =>
    ({ id: 't', name: 't', command: 'x', args: [], cwd: '/', color: '#000', autoStart: false, enabled: true, ...over })
  assert.equal(effectiveTranscriptDir(tpl({ transcriptDir: '/data/projects' })), '/data/projects')
  assert.equal(effectiveTranscriptDir(tpl({ command: 'claude' })), null, '裸 claude 走 claudeHome 旧路')
  assert.equal(effectiveTranscriptDir(tpl({ claudeHome: '/iso/home' })), null, 'claudeHome 包装器走旧路')
})
