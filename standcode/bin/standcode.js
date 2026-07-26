#!/usr/bin/env node
// npm 薄壳：核心是 Python（caller/caller.py），npm 只做分发与 PATH 入口。
// STANDCODE_PYTHON 可指定解释器（默认 python3，需 ≥3.10）。
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const caller = path.join(__dirname, '..', 'caller', 'caller.py')
const py = process.env.STANDCODE_PYTHON || 'python3'
const r = spawnSync(py, [caller, ...process.argv.slice(2)], { stdio: 'inherit' })
if (r.error && r.error.code === 'ENOENT') {
  console.error(`standcode: 找不到 ${py}——请安装 Python ≥3.10 或设 STANDCODE_PYTHON`)
  process.exit(127)
}
process.exit(r.status ?? 1)
