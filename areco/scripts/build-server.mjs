// esbuild 把 server 打成单文件 dist/server/index.cjs
import * as esbuild from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const serverOutDir = resolve(rootDir, 'dist/server')

rmSync(serverOutDir, { recursive: true, force: true })
mkdirSync(serverOutDir, { recursive: true })

await esbuild.build({
  entryPoints: [resolve(rootDir, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  // 根 package.json 是 type:module，CJS 产物必须用 .cjs 后缀
  outfile: resolve(serverOutDir, 'index.cjs'),
  // npm bin 入口直接执行本文件（package.json bin.areco），须带 shebang
  banner: { js: '#!/usr/bin/env node' },
  external: ['node-pty'],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  sourcemap: true,
  minify: true,
  treeShaking: true,
  logLevel: 'info',
})
