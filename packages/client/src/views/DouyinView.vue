<script setup lang="ts">
// 抖音私信工作台（2026-11-19）：~/Code/douyin-im-export 的 serve.py 页面，areco 内嵌成 tab。
// 走服务端同源反代 /douyin → 本机 :8021（packages/server/src/routes/douyin-proxy.ts），
// 这里只放一个 iframe，数据与发送逻辑全在工作台自己那套里。
import { ref } from 'vue'

const loading = ref(true)
</script>

<template>
  <div class="dy-host">
    <div v-if="loading" class="dy-loading">正在载入抖音工作台…</div>
    <iframe
      class="dy-frame"
      src="/douyin/"
      title="抖音私信工作台"
      allow="clipboard-write"
      @load="loading = false"
    />
  </div>
</template>

<style scoped>
.dy-host {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--bg);
}
.dy-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.dy-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-dim, #8a8a8a);
  pointer-events: none;
}
</style>
