<script setup lang="ts">
// 全屏拖放遮罩：dragging 时 Teleport 到 body 覆盖整页，提示用户松手。会话页/项目页共用
defineProps<{ visible: boolean }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="drag-overlay">
      <div class="drag-hint">📁 松手即可：文件上传 / 文件夹填入源路径</div>
    </div>
  </Teleport>
</template>

<style scoped>
.drag-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.drag-hint {
  padding: 22px 36px;
  border: 2px dashed var(--accent);
  border-radius: 16px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
  pointer-events: none; /* 让 drag 事件穿透到 document，不干扰计数 */
}
</style>
