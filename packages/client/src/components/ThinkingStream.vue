<script setup lang="ts">
// 运行中的实时思考气泡：transcript 按步落盘（一步一大坨），这里用打字机匀速吐字造连续体感
//（2026-07-26 维护者定）。盒子定高、内容底部对齐——每拍吐字不改变文档高度，不扰动滚动位置
// 与「回到最新」对账（贴底自动跟滚已因 iOS 断触撤掉，打字机更不能每拍推高页面）。
import { onBeforeUnmount, ref, watch } from 'vue'
import { TYPEWRITER_TICK_MS, typewriterStep } from '../utils/typewriter'

const props = defineProps<{ text: string }>()

const shown = ref('')
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
let timer: number | null = null

function stop() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function tick() {
  const full = props.text
  const step = typewriterStep(shown.value.length, full.length)
  if (step <= 0) {
    stop() // 追平即停表，等下一坨落盘由 watch 重启
    return
  }
  shown.value = full.slice(0, shown.value.length + step)
}

watch(
  () => props.text,
  (full) => {
    if (reduce) {
      shown.value = full
      return
    }
    // 新文本不再延续已显示前缀（换轮/整页替换收缩）→ 从头重打
    if (!full.startsWith(shown.value)) shown.value = ''
    if (timer === null) timer = window.setInterval(tick, TYPEWRITER_TICK_MS)
  },
  { immediate: true }
)
onBeforeUnmount(stop)
</script>

<template>
  <div class="tstream" role="status" aria-live="off">
    <div class="tlabel">✻ 思考中…</div>
    <div class="tbox">
      <pre class="ttext">{{ shown }}<span class="caret">▍</span></pre>
    </div>
  </div>
</template>

<style scoped>
.tstream {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--fold-bg);
  overflow: hidden;
}
.tlabel {
  padding: 5px 9px;
  font-size: 12px;
  color: var(--thinking);
  user-select: none;
}
/* 定高 + 底对齐：溢出裁顶部，永远看到最新吐出的字（终端 tail 式） */
.tbox {
  height: 8.5em;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  overflow: hidden;
  padding: 0 9px 7px;
  border-top: 1px solid var(--fold-border);
  font-size: 11.5px;
}
.ttext {
  margin: 0;
  padding-top: 7px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--fold-text);
  line-height: 1.55;
}
.caret {
  color: var(--thinking);
  animation: caret-blink 1s steps(1) infinite;
}
@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
  }
}
</style>
