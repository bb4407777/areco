<script setup lang="ts">
// 「正在输入中…」指示：对话流尾部的三点跳动气泡。
// 对话模式没有终端那种代码滚屏的活感，agent 干活时给一个有生命体征的反馈。
// 外层可用 --sender 指定文字着色（项目页按成员模板色），不指定则用默认 muted。
defineProps<{ label?: string }>()
</script>

<template>
  <div class="typing" role="status" aria-live="polite">
    <span class="tdot" /><span class="tdot" /><span class="tdot" />
    <span v-if="label" class="tlabel">{{ label }}</span>
  </div>
</template>

<style scoped>
.typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  padding: 6px 12px;
  border-radius: 12px;
  background: var(--chip-bg);
}
.tdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sender, var(--muted));
  animation: tblink 1.2s infinite;
}
.tdot:nth-child(2) {
  animation-delay: 0.15s;
}
.tdot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes tblink {
  0%,
  60%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}
.tlabel {
  margin-left: 4px;
  font-size: 12px;
  color: var(--sender, var(--muted));
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .tdot {
    animation: none;
    opacity: 0.6;
  }
}
</style>
