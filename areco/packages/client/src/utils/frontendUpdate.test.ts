import assert from 'node:assert/strict'
import test from 'node:test'
import { entryAssetFromHtml } from './frontendVersion'

test('从 Vite 首页提取入口 hash', () => {
  const html = '<script type="module" src="/assets/js/index-AbC123.js"></script>'
  assert.equal(entryAssetFromHtml(html), '/assets/js/index-AbC123.js')
})

test('script 属性顺序变化仍可识别', () => {
  const html = '<script crossorigin src="/assets/js/index-Z9.js" type="module"></script>'
  assert.equal(entryAssetFromHtml(html), '/assets/js/index-Z9.js')
})

test('忽略非入口模块，入口不存在返回 null', () => {
  assert.equal(entryAssetFromHtml('<script type="module" src="/assets/js/vendor-x.js"></script>'), null)
})
