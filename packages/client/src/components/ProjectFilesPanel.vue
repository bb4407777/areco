<script setup lang="ts">
// 项目 Files 第一版：显式 rootPath、只读懒加载目录树、全项目文件名搜索、点击复用 FilePreview。
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSpin, useMessage } from 'naive-ui'
import type { ProjectFileList, ProjectFileNode } from '../../../shared/protocol'
import { api } from '../api'
import { useRoomsStore } from '../stores/rooms'
import { fmtBytes } from '../utils/format'
import { iconFor } from '../utils/filelinks'

const props = defineProps<{
  roomId: string
  rootPath: string | null
  archived: boolean
  locatePath?: string
  locateNonce?: number
}>()
const emit = defineEmits<{ preview: [path: string] }>()

const rooms = useRoomsStore()
const toast = useMessage()
const bindDraft = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const query = ref('')
const searchResults = ref<ProjectFileNode[]>([])
const children = ref<Record<string, ProjectFileNode[]>>({})
const expanded = ref(new Set<string>())
const truncated = ref(false)
let generation = 0
let searchTimer: number | null = null

interface VisibleRow { node: ProjectFileNode; depth: number }
const rows = computed<VisibleRow[]>(() => {
  if (query.value.trim()) return searchResults.value.map((node) => ({ node, depth: 0 }))
  const out: VisibleRow[] = []
  const walk = (dir: string, depth: number) => {
    for (const node of children.value[dir] ?? []) {
      out.push({ node, depth })
      if (node.kind === 'directory' && expanded.value.has(node.relativePath)) walk(node.relativePath, depth + 1)
    }
  }
  walk('', 0)
  return out
})

function extOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase()
}

function fileIcon(node: ProjectFileNode): string {
  return node.kind === 'directory' ? (expanded.value.has(node.relativePath) ? '📂' : '📁') : iconFor(extOf(node.name))
}

async function loadDirectory(relative = '') {
  const gen = generation
  loading.value = true
  error.value = ''
  try {
    const result = await api.get<ProjectFileList>(
      `/api/rooms/${props.roomId}/files?dir=${encodeURIComponent(relative)}`
    )
    if (gen !== generation) return
    children.value = { ...children.value, [relative]: result.items }
    truncated.value = truncated.value || result.truncated
  } catch (err) {
    if (gen === generation) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (gen === generation) loading.value = false
  }
}

async function runSearch() {
  const q = query.value.trim()
  if (!q) {
    searchResults.value = []
    if (!children.value[''] && props.rootPath) await loadDirectory('')
    return
  }
  const gen = generation
  loading.value = true
  error.value = ''
  try {
    const result = await api.get<ProjectFileList>(
      `/api/rooms/${props.roomId}/files?q=${encodeURIComponent(q)}`
    )
    if (gen !== generation) return
    searchResults.value = result.items
    truncated.value = result.truncated
  } catch (err) {
    if (gen === generation) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (gen === generation) loading.value = false
  }
}

watch(query, () => {
  if (searchTimer !== null) clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void runSearch(), 260)
})

watch(
  () => [props.roomId, props.rootPath] as const,
  ([, root]) => {
    generation++
    bindDraft.value = root ?? ''
    query.value = ''
    searchResults.value = []
    children.value = {}
    expanded.value = new Set()
    truncated.value = false
    error.value = ''
    if (root) void loadDirectory('')
  },
  { immediate: true },
)

watch(
  () => props.locateNonce,
  () => {
    const target = props.locatePath?.trim()
    if (!target) return
    query.value = target.split('/').pop() ?? target
    void runSearch()
  },
  { immediate: true },
)

async function saveRoot() {
  if (props.archived || saving.value) return
  saving.value = true
  try {
    const path = bindDraft.value.trim() || null
    await rooms.setRoot(props.roomId, path)
    await rooms.refresh()
    toast.success(path ? '已绑定项目文件根目录' : '已解绑项目文件根目录')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function toggle(node: ProjectFileNode) {
  if (node.kind === 'file') {
    emit('preview', node.path)
    return
  }
  const next = new Set(expanded.value)
  if (next.has(node.relativePath)) {
    next.delete(node.relativePath)
  } else {
    next.add(node.relativePath)
    if (!children.value[node.relativePath]) await loadDirectory(node.relativePath)
  }
  expanded.value = next
}
</script>

<template>
  <section class="files-panel">
    <div class="bind-row">
      <NInput
        v-model:value="bindDraft"
        size="small"
        :disabled="archived"
        placeholder="粘贴项目根目录绝对路径，例如 /Users/you/Projects/我的项目…"
        @keyup.enter="saveRoot"
      />
      <NButton size="small" :loading="saving" :disabled="archived" @click="saveRoot">绑定目录</NButton>
    </div>
    <div v-if="rootPath" class="root" :title="rootPath">📁 {{ rootPath }}</div>

    <template v-if="rootPath">
      <NInput v-model:value="query" size="small" clearable placeholder="搜索整个项目的文件名或相对路径" class="search" />
      <div class="tree">
        <NSpin v-if="loading && !rows.length" class="state" />
        <div v-else-if="error" class="state error">{{ error }}</div>
        <NEmpty v-else-if="!rows.length" :description="query.trim() ? '没有匹配文件' : '目录为空'" class="state" />
        <button
          v-for="row in rows"
          v-else
          :key="`${query.trim() ? 'q' : 't'}-${row.node.relativePath}`"
          type="button"
          class="file-row"
          :style="{ paddingLeft: `${12 + row.depth * 18}px` }"
          :title="row.node.path"
          @click="toggle(row.node)"
        >
          <span v-if="!query.trim() && row.node.kind === 'directory'" class="chevron">
            {{ expanded.has(row.node.relativePath) ? '▾' : '▸' }}
          </span>
          <span v-else class="chevron" />
          <span class="icon">{{ fileIcon(row.node) }}</span>
          <span class="file-main">
            <span class="name">{{ row.node.name }}</span>
            <span v-if="query.trim()" class="relative">{{ row.node.relativePath }}</span>
          </span>
          <span v-if="row.node.kind === 'file'" class="size">{{ fmtBytes(row.node.size ?? 0) }}</span>
        </button>
        <div v-if="loading && rows.length" class="more"><NSpin size="small" /> 加载中…</div>
        <div v-if="truncated" class="more">结果较多，已显示安全上限内的内容</div>
      </div>
    </template>

    <div v-else class="unbound">
      <div class="unbound-icon">🗂️</div>
      <strong>先绑定这个项目的案件目录</strong>
      <p>Files 只读取该目录，不会根据 Agent 的 cwd 或聊天时间猜位置，也不会提供删除和在线编辑。</p>
    </div>
  </section>
</template>

<style scoped>
.files-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--panel); }
.bind-row { display: flex; gap: 8px; padding: 10px 12px 6px; }
.bind-row :deep(.n-input) { flex: 1; min-width: 0; }
.root { margin: 0 12px 8px; color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search { width: auto; margin: 0 12px 8px; align-self: stretch; }
.tree { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--border); padding: 5px 0 18px; }
.file-row { display: flex; align-items: center; width: 100%; gap: 6px; min-height: 34px; padding-top: 5px; padding-right: 12px; padding-bottom: 5px; border: 0; background: none; color: var(--text); text-align: left; cursor: pointer; }
.file-row:hover { background: var(--hover); }
.chevron { width: 12px; flex: 0 0 12px; color: var(--faint); }
.icon { width: 20px; flex: 0 0 20px; text-align: center; }
.file-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.name, .relative { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.relative { color: var(--faint); font-size: 10.5px; }
.size { flex: 0 0 auto; color: var(--faint); font-size: 10.5px; }
.state { min-height: 180px; display: flex; align-items: center; justify-content: center; color: var(--faint); }
.error { color: #d03050; }
.more { display: flex; justify-content: center; gap: 6px; padding: 8px; color: var(--faint); font-size: 11px; }
.unbound { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 28px; color: var(--muted); text-align: center; }
.unbound-icon { font-size: 38px; margin-bottom: 10px; }
.unbound strong { color: var(--text); }
.unbound p { max-width: 520px; line-height: 1.6; }
@media (max-width: 640px) { .bind-row { flex-direction: column; } .file-row { min-height: 40px; } }
</style>
