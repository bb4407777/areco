<script setup lang="ts">
// 历史对话列表：mtime 倒序翻所有落盘会话（claude 系 + kimi + qclaw 原生层，codex/reasonix 等走 chatlog 层），搜索按标题/路径/id
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NEmpty, NInput, NSpin, NTag } from 'naive-ui'
import type { HistoryEntry, HistoryListPage } from '../../../shared/protocol'
import { useUiStore } from '../stores/ui'
import { api } from '../api'
import { fmtBytes, fmtTime, shortPath } from '../utils/format'

const PAGE = 30

const router = useRouter()
const ui = useUiStore()
const entries = ref<HistoryEntry[]>([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const q = ref('')
let debounce: number | null = null

async function load(reset: boolean) {
  loading.value = true
  try {
    const offset = reset ? 0 : entries.value.length
    const query = q.value.trim() ? `&q=${encodeURIComponent(q.value.trim())}` : ''
    const page = await api.get<HistoryListPage>(`/api/history?limit=${PAGE}&offset=${offset}${query}`)
    entries.value = reset ? page.entries : [...entries.value, ...page.entries]
    total.value = page.total
    hasMore.value = page.hasMore
  } finally {
    loading.value = false
  }
}

watch(q, () => {
  if (debounce !== null) clearTimeout(debounce)
  debounce = window.setTimeout(() => void load(true), 300)
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

onMounted(() => void load(true))
</script>

<template>
  <!-- 桌面端：侧边栏已有历史列表，内容区显示空状态 -->
  <div v-if="ui.isDesktop && !$route.params.id" class="desktop-hint">
    <n-empty v-if="!entries.length && !loading" description="没有找到历史会话" />
    <div v-else class="select-hint">← 从左侧选择一条历史记录</div>
  </div>

  <!-- 手机端：完整历史列表 -->
  <div v-else class="history">
    <div class="toolbar">
      <h2 class="page-title">历史对话</h2>
      <span class="count" v-if="total">{{ total }} 个会话</span>
    </div>
    <n-input v-model:value="q" placeholder="搜标题 / 目录 / 会话 id" clearable size="small" class="search" />

    <n-spin v-if="loading && !entries.length" class="center" />
    <n-empty v-else-if="!entries.length" description="没有找到历史会话" class="center" />

    <div v-else class="list">
      <button v-for="entry in entries" :key="`${entry.source}/${entry.project}/${entry.id}`" class="row" type="button" @click="open(entry)">
        <div class="row-main">
          <span class="title">{{ entry.title }}</span>
          <span class="time">{{ fmtTime(entry.mtimeMs) }}</span>
        </div>
        <div class="row-meta">
          <n-tag size="tiny" :bordered="false" class="src" :class="entry.source">{{ entry.source }}</n-tag>
          <n-tag v-if="entry.liveSessionId" size="tiny" :bordered="false" type="success">看板会话</n-tag>
          <span class="path">{{ entry.cwd ? shortPath(entry.cwd, 34) : '—' }}</span>
          <span class="size">{{ fmtBytes(entry.size) }}</span>
        </div>
      </button>
      <div class="more">
        <n-button v-if="hasMore" size="small" secondary :loading="loading" @click="load(false)">加载更多</n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.desktop-hint {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.select-hint {
  font-size: 14px;
  color: var(--faint);
}
.history {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px calc(20px + env(safe-area-inset-bottom, 0px));
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.toolbar {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.page-title {
  margin: 0;
  font-size: 17px;
}
.count {
  font-size: 12px;
  color: var(--muted);
}
.search {
  margin-bottom: 10px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card, var(--bar));
  padding: 10px 12px;
  cursor: pointer;
  color: var(--text);
  font: inherit;
}
.row:active {
  opacity: 0.75;
}
.row-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.time {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--muted);
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--muted);
}
.src.reasonix {
  color: #b48ce8;
}
.src.codex {
  color: #10a37f;
}
.src.workbuddy {
  color: #e8a33d;
}
.src.cc-connect {
  color: #63a3e8;
}
.src.kimi {
  color: #4f7dff;
}
.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.size {
  flex: 0 0 auto;
}
.more {
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
}
.center {
  margin-top: 18vh;
  display: flex;
  justify-content: center;
}
</style>
