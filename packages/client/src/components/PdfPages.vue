<script setup lang="ts">
// PDF 逐页渲染（PDF.js）：iOS 上 iframe 内嵌 PDF 只显示第一页，这里用 canvas 逐页画。
// 虚拟化：IntersectionObserver 进入视口附近才渲染、远离即销毁 canvas（iOS canvas 总内存有硬顶，
// 120 页证据卷全量渲染必爆），占位 div 用 aspect-ratio 撑高度保证滚动条稳定。
// pdfjs-dist 走动态 import——只有真正预览 PDF 才拉这个 ~1MB 异步 chunk。
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ src: string }>()
const emit = defineEmits<{ ready: []; error: [msg: string] }>()

// 构建标签：远程排障时确认设备拿到的是不是新包（页面顶部可见）
const BUILD_TAG = 'pv4'
const DPR = Math.min(2, Math.round((window.devicePixelRatio || 1) * 10) / 10)

interface PageSlot {
  num: number
  ratio: number // height / width，先用第 1 页的值占位，实际渲染后校正
  failMsg: string // 渲染失败原因（空 = 正常）；显示在页框里便于远程定位
  state: string // 渲染阶段仪表：待渲/取页中/渲染中/完成…——空白排障全靠它
}

const slots = ref<PageSlot[]>([])
const total = ref(0)
const root = ref<HTMLElement | null>(null)

// 非响应式内部状态（避免大对象进 Vue 代理）
let doc: import('pdfjs-dist').PDFDocumentProxy | null = null
let loadingTask: { destroy(): Promise<void> } | null = null
let observer: IntersectionObserver | null = null
const renderTasks = new Map<number, { cancel(): void }>()
const renderedAt = new Map<number, number>() // pageNum -> 渲染时的容器宽度（宽度变了要重渲）
let destroyed = false

// 旧 Safari（<17.4）没有 ES2024 的 Promise.withResolvers，pdfjs 主线程与 worker 都会用到。
// 主线程在这里垫；worker 用 legacy 构建（官方自带旧浏览器兼容）
function polyfillWithResolvers() {
  const P = Promise as unknown as { withResolvers?: () => unknown }
  if (typeof P.withResolvers !== 'function') {
    P.withResolvers = function <T>() {
      let resolve!: (v: T | PromiseLike<T>) => void
      let reject!: (r?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }
}

async function init() {
  try {
    polyfillWithResolvers()
    // legacy 构建：面向旧浏览器（iPhone 报 Promise.withResolvers is not a function 即此因）
    const [pdfjs, workerMod] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<typeof import('pdfjs-dist')>,
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default
    // disableFontFace：老 iOS WebKit 上 FontFace 装载内嵌字体会让 render 永久挂起
    //（无 resolve 无 reject，症状=空白页框且无报错）；改矢量路径直绘文字，稳定优先。
    // isOffscreenCanvasSupported:false：iOS 16-17 的 OffscreenCanvas 有实现坑，
    // pdfjs 检测到"支持"就走离屏管线 → render 成功但画布全白（pv3 仪表实锤），显式关闭
    loadingTask = pdfjs.getDocument({
      url: props.src,
      withCredentials: true,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
    })
    doc = await (loadingTask as unknown as import('pdfjs-dist').PDFDocumentLoadingTask).promise
    if (destroyed) return void loadingTask.destroy()
    total.value = doc.numPages
    const first = await doc.getPage(1)
    const vp = first.getViewport({ scale: 1 })
    const baseRatio = vp.height / vp.width
    slots.value = Array.from({ length: doc.numPages }, (_, i) => ({
      num: i + 1,
      ratio: baseRatio,
      failMsg: '',
      state: '待渲',
    }))
    emit('ready')
    // 等 Vue 真把占位 div 打上 DOM（nextTick）+ 一帧布局稳定后再挂观察器；
    // 另主动渲一遍视口附近的页——不把首屏押在 IO 的首发回调上
    await nextTick()
    requestAnimationFrame(() => {
      setupObserver()
      renderNearViewport()
    })
  } catch (e) {
    if (!destroyed) emit('error', e instanceof Error ? e.message : String(e))
  }
}

function setupObserver() {
  if (destroyed || !root.value) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const num = Number(el.dataset.page)
        if (!num) continue
        if (entry.isIntersecting) void renderPage(num, el)
        else destroyPage(num, el)
      }
    },
    // 视口上下各预渲染约 1.5 屏；远离即回收
    { rootMargin: '150% 0px 150% 0px' }
  )
  for (const el of root.value.querySelectorAll<HTMLElement>('.pdf-page')) observer.observe(el)
}

/** 兜底主动渲染：视口上下 2.5 屏内的占位页直接渲，不依赖 IO 首发回调 */
function renderNearViewport() {
  if (destroyed || !root.value) return
  const vh = window.innerHeight || 800
  for (const el of root.value.querySelectorAll<HTMLElement>('.pdf-page')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > -vh * 2.5 && r.top < vh * 2.5) {
      const num = Number(el.dataset.page)
      if (num) void renderPage(num, el)
    }
  }
}

function setState(num: number, s: string) {
  const slot = slots.value[num - 1]
  if (slot) slot.state = s
}

/** 带超时的 promise：老 WebKit 上多处会无声挂起，必须全部套上限时 */
function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}超时（${ms / 1000}s）`)), ms)),
  ])
}

/** 画布空白检测：降采样读像素，全白/全透明 = 渲染"成功"但没画出东西（iOS 清画布等） */
function canvasLooksBlank(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = document.createElement('canvas')
    probe.width = 12
    probe.height = 12
    const pctx = probe.getContext('2d')
    if (!pctx) return false
    pctx.drawImage(canvas, 0, 0, 12, 12)
    const d = pctx.getImageData(0, 0, 12, 12).data
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) return false
    }
    return true
  } catch {
    return false
  }
}

async function renderPage(num: number, el: HTMLElement, attempt = 0) {
  if (!doc || destroyed) return
  const width = el.clientWidth
  if (width <= 0) {
    setState(num, `量宽为0，重测#${attempt + 1}`)
    // 布局未就绪（过渡动画/隐藏期），稍后重测一次
    if (attempt < 3) setTimeout(() => void renderPage(num, el, attempt + 1), 350)
    else {
      const slot = slots.value[num - 1]
      if (slot) slot.failMsg = '容器宽度始终为0（布局未就绪）'
    }
    return
  }
  // 已按当前宽度渲染过就跳过
  if (el.querySelector('canvas') && renderedAt.get(num) === width) return
  if (renderTasks.has(num)) return
  try {
    setState(num, '取页中')
    const page = await raceTimeout(doc.getPage(num), 8_000, '取页对象')
    if (destroyed) return
    const base = page.getViewport({ scale: 1 })
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = page.getViewport({ scale: (width / base.width) * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context 创建失败')
    setState(num, `渲染中 ${canvas.width}×${canvas.height}`)
    // 只传 canvasContext（spec 写法）：同时传 canvas 在部分版本会被拒
    const task = page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0])
    renderTasks.set(num, task)
    // 看门狗：渲染 promise 在老 WebKit 上可能永久挂起（不 resolve 不 reject），
    // 超时主动 cancel 并按失败路径亮红字——任何形态的失败都必须可见。
    // timedOut 标记防止 cancel 异常被下面的 /cancel/i 静默分支吃掉
    let watchdog: number | undefined
    let timedOut = false
    try {
      await Promise.race([
        task.promise,
        new Promise((_, rej) => {
          watchdog = window.setTimeout(() => {
            timedOut = true
            try {
              task.cancel()
            } catch {
              /* 已完成/已取消 */
            }
            rej(new Error('渲染超时（10s，疑似字体/worker 挂起）'))
          }, 10_000)
        }),
      ])
    } catch (e) {
      if (timedOut) throw new Error('渲染超时（10s，疑似字体/worker 挂起）')
      throw e
    } finally {
      clearTimeout(watchdog)
    }
    renderTasks.delete(num)
    if (destroyed) return
    // 校正真实纵横比（个别页尺寸不同——扫描件/横页）
    const slot = slots.value[num - 1]
    const realRatio = base.height / base.width
    if (slot && Math.abs(slot.ratio - realRatio) > 0.001) slot.ratio = realRatio
    if (slot) slot.failMsg = ''
    el.querySelector('canvas')?.remove()
    el.appendChild(canvas)
    renderedAt.set(num, width)
    if (canvasLooksBlank(canvas)) {
      setState(num, '完成但画布全白（疑似 iOS 清空/未画出内容）')
      if (slot) slot.failMsg = '渲染返回成功但画布是空白的（canvasLooksBlank）'
      // 第 1 页就全白 = 本机渲染管线整体不可用 → 整组件降级（父级退回 iframe 首页模式）
      if (num === 1) emit('error', 'iOS 画布全白，降级 iframe 模式')
    } else {
      setState(num, `完成 ${canvas.width}×${canvas.height}`)
    }
  } catch (e) {
    renderTasks.delete(num)
    const msg = e instanceof Error ? e.message : String(e)
    // 滚走触发的取消不算失败
    if (/cancel/i.test(msg)) {
      setState(num, '已取消（滚出视口）')
      return
    }
    if (attempt < 1 && !destroyed) {
      setTimeout(() => void renderPage(num, el, attempt + 1), 400)
      return
    }
    // 重试仍失败：页框内亮出原因，便于远程定位（勿再静默吞掉）
    const slot = slots.value[num - 1]
    if (slot) slot.failMsg = msg.slice(0, 120)
  }
}

function destroyPage(num: number, el: HTMLElement) {
  renderTasks.get(num)?.cancel()
  renderTasks.delete(num)
  const canvas = el.querySelector('canvas')
  if (canvas) {
    // Safari 显式清零帮助尽快释放 canvas 内存
    canvas.width = 0
    canvas.height = 0
    canvas.remove()
  }
  renderedAt.delete(num)
}

onMounted(() => void init())
onBeforeUnmount(() => {
  destroyed = true
  observer?.disconnect()
  for (const t of renderTasks.values()) t.cancel()
  renderTasks.clear()
  // 规范销毁走 loadingTask.destroy()（连带终结 worker 与文档）
  void loadingTask?.destroy().catch(() => undefined)
  loadingTask = null
  doc = null
})
</script>

<template>
  <div ref="root" class="pdf-pages">
    <div class="diag">诊断 {{ BUILD_TAG }} · {{ total }}页 · dpr{{ DPR }}</div>
    <div
      v-for="slot in slots"
      :key="slot.num"
      class="pdf-page"
      :data-page="slot.num"
      :style="{ aspectRatio: `1 / ${slot.ratio}` }"
    >
      <span class="pno">{{ slot.num }} / {{ total }}</span>
      <span class="pstate">{{ slot.state }}</span>
      <span v-if="slot.failMsg" class="perr">第{{ slot.num }}页渲染失败：{{ slot.failMsg }}</span>
    </div>
  </div>
</template>

<style scoped>
.pdf-pages {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
}
.pdf-page {
  position: relative;
  width: 100%;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.pdf-page :deep(canvas),
.pdf-page canvas {
  display: block;
  width: 100%;
  height: auto;
}
.pno {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 10px;
  color: #999;
  background: rgba(255, 255, 255, 0.7);
  padding: 1px 6px;
  border-radius: 999px;
  pointer-events: none;
}
.perr {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  font-size: 11px;
  color: #c33;
  text-align: center;
  word-break: break-all;
}
.diag {
  font-size: 10px;
  color: #8a8a8a;
  text-align: center;
  padding: 2px 0;
}
.pstate {
  position: absolute;
  bottom: 6px;
  left: 8px;
  font-size: 10px;
  color: #8a8a8a;
  background: rgba(255, 255, 255, 0.7);
  padding: 1px 6px;
  border-radius: 999px;
  pointer-events: none;
}
</style>
