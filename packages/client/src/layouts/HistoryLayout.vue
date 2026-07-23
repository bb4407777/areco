<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useUiStore } from '../stores/ui'
import type { HistoryEntry, HistoryListPage } from '../../../shared/protocol'
import { api } from '../api'
import HistorySidebar from '../components/HistorySidebar.vue'

const PAGE = 30
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

onMounted(() => void load(true))
</script>

<template>
  <div v-if="ui.isDesktop" class="split">
    <aside class="sidebar">
      <HistorySidebar
        :entries="entries"
        :total="total"
        :has-more="hasMore"
        :loading="loading"
        :query="q"
        @search="q = $event"
        @load-more="load(false)"
        @refresh="load(true)"
      />
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
  <router-view v-else />
</template>

<style scoped>
.split {
  flex: 1;
  min-height: 0;
  display: flex;
}
.sidebar {
  width: 300px;
  flex: 0 0 auto;
  border-right: 1px solid var(--border);
  background: var(--bar);
  display: flex;
  flex-direction: column;
}
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
