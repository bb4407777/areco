<script setup lang="ts">
// 文件预览底部抽屉：pdf/图片内嵌，html 走 sandbox iframe，docx 等 as=pdf 现转，文本拉原文，视频 <video>。
// 动效基线（Emil）：iOS drawer 曲线，进 320ms / 退 220ms，仅 transform+opacity，尊重 reduced-motion。
import { ref, watch, computed, onBeforeUnmount } from 'vue'
import { NSpin } from 'naive-ui'
import type { FileMeta } from '../../../shared/protocol'
import { api } from '../api'
import { fmtBytes } from '../utils/format'
import PdfPages from './PdfPages.vue'

// iOS/iPadOS 的 iframe 内嵌 PDF 只渲染第一页（WebKit 限制），改走 PDF.js 逐页画；
// 桌面浏览器保留原生 iframe 阅读器（自带缩放/搜索）。?pdfjs=1 供桌面调试强制走 PDF.js
const usePdfjs =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  new URLSearchParams(location.search).has('pdfjs')

const props = defineProps<{ path: string | null }>()
const emit = defineEmits<{ close: [] }>()

const meta = ref<FileMeta | null>(null)
const loading = ref(false)
const error = ref('')
const textContent = ref('')
const frameLoading = ref(false)
// PDF.js 初始化失败（如极老 WebKit 连 legacy 构建都跑不动）→ 退回 iframe 首页模式
const pdfjsFailed = ref(false)

function onPdfjsError() {
  pdfjsFailed.value = true
  frameLoading.value = true
}

const rawUrl = computed(() => (props.path ? `/api/files/raw?path=${encodeURIComponent(props.path)}` : ''))
const pdfUrl = computed(() => `${rawUrl.value}&as=pdf`)

function reset() {
  meta.value = null
  error.value = ''
  textContent.value = ''
  frameLoading.value = false
  pdfjsFailed.value = false
}

async function load(path: string) {
  reset()
  loading.value = true
  try {
    const m = await api.get<FileMeta>(`/api/files/meta?path=${encodeURIComponent(path)}`)
    meta.value = m
    if (m.preview === 'pdf' || m.preview === 'convert-pdf' || m.preview === 'html') frameLoading.value = true
    if (m.preview === 'text') {
      const res = await fetch(rawUrl.value, { credentials: 'same-origin' })
      textContent.value = await res.text()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.path,
  (p) => {
    if (p) void load(p)
    else reset()
  },
  { immediate: true }
)

// 打开时锁背景滚动
watch(
  () => props.path,
  (p) => {
    document.body.style.overflow = p ? 'hidden' : ''
  }
)
onBeforeUnmount(() => {
  document.body.style.overflow = ''
})

function openFull() {
  const m = meta.value
  if (!m) return
  const url = m.preview === 'convert-pdf' ? pdfUrl.value : rawUrl.value
  window.open(url, '_blank')
}
function download() {
  if (props.path) window.open(`${rawUrl.value}&download=1`, '_blank')
}
</script>

<template>
  <Transition name="sheet">
    <div v-if="path" class="overlay" @click.self="emit('close')">
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="grip" />
        <header class="bar">
          <div class="title">
            <div class="name">{{ meta?.name ?? '加载中…' }}</div>
            <div v-if="meta" class="sub">{{ meta.ext.replace('.', '').toUpperCase() }} · {{ fmtBytes(meta.size) }}</div>
          </div>
          <button class="act" type="button" title="全屏打开" @click="openFull">⤢</button>
          <button class="act" type="button" title="下载" @click="download">⤓</button>
          <button class="act close" type="button" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div class="body">
          <n-spin v-if="loading" class="center" />
          <div v-else-if="error" class="center err">{{ error }}</div>

          <template v-else-if="meta">
            <!-- PDF / 现转 PDF：iOS 走 PDF.js 逐页渲染（iframe 只显首页），桌面走原生 iframe 阅读器 -->
            <div
              v-if="meta.preview === 'pdf' || meta.preview === 'convert-pdf'"
              class="frame-wrap"
              :class="usePdfjs && !pdfjsFailed ? 'paged' : 'native'"
            >
              <n-spin v-if="frameLoading" class="center overlay-spin" />
              <div v-if="usePdfjs && !pdfjsFailed" class="pdf-scroll">
                <PdfPages
                  :key="meta.path"
                  :src="meta.preview === 'convert-pdf' ? pdfUrl : rawUrl"
                  @ready="frameLoading = false"
                  @error="onPdfjsError"
                />
              </div>
              <iframe
                v-else
                :src="meta.preview === 'convert-pdf' ? pdfUrl : rawUrl"
                class="frame"
                @load="frameLoading = false"
              />
              <p v-if="pdfjsFailed" class="hint">当前系统版本仅能内嵌显示第一页，点右上 ⤢ 全屏查看完整文档</p>
              <p v-else-if="meta.preview === 'convert-pdf'" class="hint">Word/Excel 已转 PDF 预览，排版与打印件一致</p>
            </div>

            <!-- 图片 -->
            <div v-else-if="meta.preview === 'image'" class="img-wrap">
              <img :src="rawUrl" :alt="meta.name" />
            </div>

            <!-- HTML：sandbox iframe（服务端已下 CSP sandbox） -->
            <div v-else-if="meta.preview === 'html'" class="frame-wrap">
              <n-spin v-if="frameLoading" class="center overlay-spin" />
              <iframe :src="rawUrl" class="frame" sandbox="allow-scripts allow-popups" @load="frameLoading = false" />
            </div>

            <!-- 视频 -->
            <div v-else-if="meta.preview === 'video'" class="img-wrap">
              <video :src="rawUrl" controls playsinline preload="metadata" />
            </div>

            <!-- 文本 -->
            <pre v-else-if="meta.preview === 'text'" class="text">{{ textContent }}</pre>

            <!-- 不可预览 -->
            <div v-else class="center download-only">
              <p>此类型无法在线预览</p>
              <button class="dl-btn" type="button" @click="download">下载文件</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.42);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.sheet {
  background: var(--panel, #1a1a1a);
  border-radius: 16px 16px 0 0;
  /* iOS PWA 刘海坑（看板顶条同款教训）：顶边必须让出 safe-area-inset-top，
     否则抽屉头部顶进状态栏。dvh 处理 Safari 动态工具栏，vh 兜底旧版 */
  height: calc(100vh - env(safe-area-inset-top, 0px) - 20px);
  height: calc(100dvh - env(safe-area-inset-top, 0px) - 20px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.4);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.grip {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--border-strong, #555);
  margin: 8px auto 4px;
  flex: 0 0 auto;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 10px;
  border-bottom: 1px solid var(--border);
}
.title {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  font-size: 11px;
  color: var(--faint);
  margin-top: 1px;
}
.act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  line-height: 1;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--chip-bg);
  color: var(--text);
  font-size: 15px;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
  /* iOS 按钮 UA 样式会把字形顶偏，flex 居中 + 清 padding 归位 */
  -webkit-appearance: none;
  appearance: none;
  align-self: center;
}
.act:active {
  transform: scale(0.92);
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}
.frame-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}
/* iframe 模式：锁满高，iframe 自己内部滚 */
.frame-wrap.native {
  height: 100%;
}
/* PDF.js 逐页模式：自然长高，随 .body 滚动（锁高会把长文档裁掉） */
.frame-wrap.paged {
  min-height: 100%;
}
.pdf-scroll {
  flex: 1;
}
.frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: #fff;
}
.hint {
  margin: 0;
  padding: 5px 12px;
  font-size: 11px;
  color: var(--faint);
  text-align: center;
  background: var(--bar);
  border-top: 1px solid var(--border);
}
.img-wrap {
  display: flex;
  justify-content: center;
  padding: 12px;
}
.img-wrap img,
.img-wrap video {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
.text {
  margin: 0;
  padding: 12px 14px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
}
.overlay-spin {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.05);
  z-index: 1;
}
.err {
  color: var(--danger);
  font-size: 13px;
  padding: 0 24px;
  text-align: center;
}
.dl-btn {
  padding: 8px 20px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

/* 抽屉进退：iOS drawer 曲线，进 320ms / 退 220ms（退比进快，Emil 非对称原则） */
.sheet-enter-active .sheet,
.sheet-leave-active .sheet {
  transition: transform 320ms cubic-bezier(0.32, 0.72, 0, 1);
}
.sheet-leave-active .sheet {
  transition-duration: 220ms;
}
.sheet-enter-from .sheet,
.sheet-leave-to .sheet {
  transform: translateY(100%);
}
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 260ms ease;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .sheet-enter-active .sheet,
  .sheet-leave-active .sheet {
    transition: none;
  }
  .sheet-enter-from .sheet,
  .sheet-leave-to .sheet {
    transform: none;
  }
}
</style>
