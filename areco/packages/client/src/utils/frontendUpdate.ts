import { readonly, ref } from 'vue'
import { entryAssetFromHtml } from './frontendVersion'

const POLL_MS = 15_000
const IDLE_MS = 3_000

const available = ref(false)
const blocked = ref(false)
let started = false
let checking = false
let reloadTimer: number | null = null
let lastActivityAt = performance.now()
let hasUnsavedWork: () => boolean = () => false

export const frontendUpdateAvailable = readonly(available)
export const frontendUpdateBlocked = readonly(blocked)

export function loadedEntryAsset(): string | null {
  return [...document.scripts]
    .map((el) => el.src ? new URL(el.src, location.href).pathname : '')
    .find((path) => /\/assets\/js\/index-[^/]+\.js$/.test(path)) ?? null
}

function clearReloadTimer() {
  if (reloadTimer !== null) window.clearTimeout(reloadTimer)
  reloadTimer = null
}

function canReloadNow() {
  return document.visibilityState === 'visible'
    && !hasUnsavedWork()
    && performance.now() - lastActivityAt >= IDLE_MS
}

function scheduleReload() {
  clearReloadTimer()
  blocked.value = !canReloadNow()
  if (blocked.value) return
  reloadTimer = window.setTimeout(() => location.reload(), 800)
}

function markActivity() {
  lastActivityAt = performance.now()
  if (available.value) scheduleReload()
}

export function reloadFrontendNow(force = false) {
  if (!force && hasUnsavedWork()) return false
  location.reload()
  return true
}

export async function checkFrontendUpdate() {
  if (checking || available.value) return
  checking = true
  try {
    const current = loadedEntryAsset()
    if (!current) return
    const res = await fetch(`/?__areco_update=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    })
    if (!res.ok) return
    const next = entryAssetFromHtml(await res.text(), location.href)
    if (!next || next === current) return
    // 构建窗口内先确认新入口已可取，避免刷新到半套产物。
    const asset = await fetch(next, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
    if (!asset.ok) return
    available.value = true
    console.info(`[update] 新前端已就绪 ${current} → ${next}（build ${__BUILD_ID__}）`)
    scheduleReload()
    window.setInterval(scheduleReload, 1_000)
  } catch {
    // 离线/构建切换中的短暂失败不影响当前页面，下轮再查。
  } finally {
    checking = false
  }
}

export function startFrontendUpdateWatcher(opts?: { hasUnsavedWork?: () => boolean }) {
  if (started) return
  started = true
  hasUnsavedWork = opts?.hasUnsavedWork ?? hasUnsavedWork
  for (const event of ['pointerdown', 'keydown', 'input'] as const) {
    document.addEventListener(event, markActivity, { capture: true, passive: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkFrontendUpdate()
  })
  window.addEventListener('pageshow', () => void checkFrontendUpdate())
  window.setInterval(() => void checkFrontendUpdate(), POLL_MS)
  window.setTimeout(() => void checkFrontendUpdate(), 2_000)
}
