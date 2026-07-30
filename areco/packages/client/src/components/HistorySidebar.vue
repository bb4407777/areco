<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty, NInput, NSpin, NTag } from 'naive-ui'
import type { HistoryEntry } from '../../../shared/protocol'
import { fmtTime, shortPath, sourceColor } from '../utils/format'
import { useSessionsStore } from '../stores/sessions'

const router = useRouter()
const sessionsStore = useSessionsStore()
const route = useRoute()

defineProps<{
  entries: HistoryEntry[]
  total: number
  hasMore: boolean
  loading: boolean
  query: string
}>()
const emit = defineEmits<{
  search: [q: string]
  loadMore: []
  refresh: []
}>()

const activeKey = computed(() => {
  const { source, project, id } = route.params
  return source && project && id ? `${source}/${project}/${id}` : null
})

function open(entry: HistoryEntry) {
  router.push({
    path: `/history/${entry.source}/${entry.project}/${entry.id}`,
    query: {
      title: entry.title,
      ...(entry.liveSessionId ? { live: entry.liveSessionId } : {}),
      ...(entry.resumable ? { resumable: '1' } : {}),
    },
  })
}
</script>

<template>
  <div class="sidebar-panel">
    <div class="sidebar-head">
      <span class="sidebar-title">历史对话</span>
      <span v-if="total" class="count">{{ total }}</span>
    </div>
    <n-input
      :value="query"
      placeholder="搜标题 / 目录 / 会话 id"
      clearable
      size="small"
      class="search"
      @update:value="(v: string) => emit('search', v)"
    />
    <div class="sidebar-list">
      <n-spin v-if="loading && !entries.length" class="mini-spin" />
      <n-empty v-else-if="!entries.length" description="没有找到历史会话" class="mini-empty" />
      <template v-else>
        <div
          v-for="entry in entries"
          :key="`${entry.source}/${entry.project}/${entry.id}`"
          :class="['sidebar-item', { active: `${entry.source}/${entry.project}/${entry.id}` === activeKey }]"
          @click="open(entry)"
        >
          <div class="item-top">
            <span class="item-title">{{ entry.title }}</span>
            <span class="item-time">{{ fmtTime(entry.mtimeMs) }}</span>
          </div>
          <div class="item-meta">
            <n-tag size="tiny" :bordered="false" class="item-tag" :style="{ color: sourceColor(entry.source, sessionsStore.templates) }">{{ entry.source }}</n-tag>
            <span class="item-path">{{ entry.cwd ? shortPath(entry.cwd, 26) : '—' }}</span>
          </div>
        </div>
        <div class="more-bar">
          <n-button v-if="hasMore" size="tiny" quaternary :loading="loading" @click="emit('loadMore')">加载更多</n-button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sidebar-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.sidebar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.sidebar-title {
  font-weight: 700;
  font-size: 15px;
}
.count {
  font-size: 12px;
  color: var(--faint);
}
.search {
  margin: 8px 10px;
  width: auto;
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.sidebar-item {
  /* 不设 width:100%——div 是 content-box，与 padding 叠加会超宽 28px，把右侧时间挤出侧栏 */
  display: block;
  text-align: left;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  padding: 8px 14px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.12s;
}
.sidebar-item:hover {
  background: var(--chip-bg);
}
.sidebar-item.active {
  background: var(--chip-bg);
  border-left-color: var(--accent);
}
.item-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-time {
  font-size: 11px;
  color: var(--faint);
  flex: 0 0 auto;
}
.item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
}
.item-tag {
  flex: 0 0 auto;
}
.item-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
}
.more-bar {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}
.mini-spin,
.mini-empty {
  margin-top: 48px;
  display: flex;
  justify-content: center;
}
</style>
