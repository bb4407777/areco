<script setup lang="ts">
// 待办看板（2026-11-18）：iPhone 端 todo-ios 网页版的 areco 内嵌页。
// 走服务端同源反代 /todo → 本机 :8023（packages/server/src/routes/todo-proxy.ts），
// 所以这里只放一个 iframe，不做任何数据逻辑；会话 cookie 由 areco 统一守卫。
import { ref } from 'vue'

const loading = ref(true)
</script>

<template>
  <div class="todo-host">
    <div v-if="loading" class="todo-loading">正在载入待办看板…</div>
    <iframe
      class="todo-frame"
      src="/todo/"
      title="待办看板"
      allow="clipboard-write"
      @load="loading = false"
    />
  </div>
</template>

<style scoped>
.todo-host {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--bg);
}
.todo-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.todo-loading {
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
