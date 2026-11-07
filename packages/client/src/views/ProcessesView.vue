<script setup lang="ts">
// 进程页（2026-11-07 高律师「现在的 areco 能不能弄个功能，找到现在的所有进程呢？
// 比如说这些孤儿进程和现在 opc 架构下的后台进程」）。
// 数据源＝服务端 services/processes.ts 的 ps 快照；孤儿口径在服务端判（PPID=1 且非 launchd 托管），
// 前端只负责展示与「结束孤儿」，不给其他进程开口子。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NInput, NSwitch, useDialog, useMessage } from 'naive-ui'
import { api } from '../api'
import type {
  ProcessKillAllResult,
  ProcessKillResult,
  ProcessRow,
  ProcessSnapshot,
} from '../../../shared/protocol'

type Filter = 'all' | 'orphan' | 'worker' | 'service' | 'cli'

const message = useMessage()
const dialog = useDialog()

const snap = ref<ProcessSnapshot | null>(null)
const loading = ref(false)
const killing = ref(false)
const q = ref('')
const filter = ref<Filter>('all')
const auto = ref(true)
let timer: ReturnType<typeof setInterval> | undefined

const KIND_TEXT: Record<ProcessRow['kind'], string> = {
  service: '服务',
  worker: '后台',
  cli: 'CLI',
  other: '其他',
}

const counts = computed(() => {
  const rows = snap.value?.rows ?? []
  return {
    orphan: rows.filter((r) => r.orphan).length,
    worker: rows.filter((r) => r.kind === 'worker').length,
    service: rows.filter((r) => r.kind === 'service').length,
    cli: rows.filter((r) => r.kind === 'cli').length,
  }
})

const rows = computed<ProcessRow[]>(() => {
  const all = snap.value?.rows ?? []
  const kw = q.value.trim().toLowerCase()
  return all.filter((r) => {
    if (filter.value === 'orphan' && !r.orphan) return false
    if (filter.value !== 'all' && filter.value !== 'orphan' && r.kind !== filter.value) return false
    if (!kw) return true
    return String(r.pid).includes(kw) || r.command.toLowerCase().includes(kw) || r.label.includes(kw)
  })
})

function fmtBytes(n: number): string {
  if (!n) return '0'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${Math.round(n / 1024)} KB`
}

const updatedAt = computed(() =>
  snap.value ? new Date(snap.value.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    snap.value = await api.get<ProcessSnapshot>('/api/processes')
    if (snap.value.warning) message.warning(snap.value.warning)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

async function killOne(row: ProcessRow): Promise<void> {
  dialog.warning({
    title: '结束孤儿进程',
    content: `PID ${row.pid}（${row.label}）\n${row.command.slice(0, 120)}`,
    positiveText: '结束',
    negativeText: '取消',
    onPositiveClick: async () => {
      killing.value = true
      try {
        const r = await api.post<ProcessKillResult>(`/api/processes/${row.pid}/kill`)
        message.success(r.message)
      } catch (e) {
        message.error((e as Error).message)
      } finally {
        killing.value = false
        await refresh()
      }
    },
  })
}

async function killAll(): Promise<void> {
  const n = counts.value.orphan
  if (!n) return
  dialog.warning({
    title: `清理全部孤儿进程（${n} 个）`,
    content: `合计占用 ${fmtBytes(snap.value?.orphanRss ?? 0)}。这些进程的父进程已退出、也非 launchd 托管，清掉不影响正在用的服务。`,
    positiveText: '全部结束',
    negativeText: '取消',
    onPositiveClick: async () => {
      killing.value = true
      try {
        const r = await api.post<ProcessKillAllResult>('/api/processes/kill-orphans')
        message.success(`已结束 ${r.killed} 个孤儿${r.failed.length ? `，${r.failed.length} 个没杀掉` : ''}`)
      } catch (e) {
        message.error((e as Error).message)
      } finally {
        killing.value = false
        await refresh()
      }
    },
  })
}

function restartTimer(): void {
  if (timer) clearInterval(timer)
  timer = auto.value ? setInterval(() => void refresh(), 10_000) : undefined
}

onMounted(() => {
  void refresh()
  restartTimer()
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="proc-page">
    <div class="toolbar">
      <h2 class="page-title">进程</h2>
      <div class="toolbar-actions">
        <n-input v-model:value="q" size="small" clearable placeholder="搜 PID / 命令" class="search" />
        <span class="auto-switch">
          <n-switch v-model:value="auto" size="small" @update:value="restartTimer" />
          <span class="auto-text">自动刷新</span>
        </span>
        <n-button size="small" :loading="loading" @click="refresh">刷新</n-button>
        <n-button
          size="small"
          type="error"
          ghost
          :disabled="!counts.orphan || killing"
          @click="killAll"
        >清孤儿{{ counts.orphan ? `（${counts.orphan}）` : '' }}</n-button>
      </div>
    </div>

    <div class="chips">
      <button type="button" class="chip" :class="{ active: filter === 'all' }" @click="filter = 'all'">
        全部 <b>{{ snap?.total ?? 0 }}</b>
      </button>
      <button type="button" class="chip danger" :class="{ active: filter === 'orphan' }" @click="filter = 'orphan'">
        孤儿 <b>{{ counts.orphan }}</b>
        <span v-if="snap?.orphanRss" class="chip-sub">{{ fmtBytes(snap.orphanRss) }}</span>
      </button>
      <button type="button" class="chip" :class="{ active: filter === 'worker' }" @click="filter = 'worker'">
        后台任务 <b>{{ counts.worker }}</b>
      </button>
      <button type="button" class="chip" :class="{ active: filter === 'service' }" @click="filter = 'service'">
        服务 <b>{{ counts.service }}</b>
      </button>
      <button type="button" class="chip" :class="{ active: filter === 'cli' }" @click="filter = 'cli'">
        CLI <b>{{ counts.cli }}</b>
      </button>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="col-pid">PID</th>
            <th class="col-kind">类型</th>
            <th class="col-num">CPU</th>
            <th class="col-num">内存</th>
            <th class="col-num">运行</th>
            <th>命令</th>
            <th class="col-act" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.pid" :class="{ orphan: r.orphan }">
            <td class="mono">
              {{ r.pid }}<span class="ppid">←{{ r.ppid }}</span>
            </td>
            <td>
              <span class="tag" :class="r.kind">{{ r.label || KIND_TEXT[r.kind] }}</span>
              <span v-if="r.orphan" class="tag orphan-tag">孤儿</span>
            </td>
            <td class="num">{{ r.cpu.toFixed(1) }}%</td>
            <td class="num">{{ fmtBytes(r.rss) }}</td>
            <td class="num">{{ r.etime }}</td>
            <td class="cmd mono" :title="r.command">{{ r.command }}</td>
            <td class="act">
              <n-button v-if="r.killable" size="tiny" ghost type="error" :disabled="killing" @click="killOne(r)">
                结束
              </n-button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length" class="empty">
        {{ snap ? '没有匹配的进程' : '读取中…' }}
      </div>
    </div>

    <p class="foot">
      仅列当前用户的进程 · 更新于 {{ updatedAt }} · 孤儿＝父进程已退出且非 launchd 托管，只可从这里结束
    </p>
  </div>
</template>

<style scoped>
.proc-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 18px 24px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.page-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.toolbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.search {
  width: 190px;
}
.auto-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  border: 1px solid var(--border);
  background: var(--chip-bg);
  color: var(--muted);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out), color 0.15s var(--ease-out);
}
.chip b {
  color: var(--text);
  font-weight: 600;
  margin-left: 2px;
}
.chip-sub {
  margin-left: 6px;
  color: var(--faint);
}
.chip.active {
  border-color: var(--accent);
  color: var(--accent);
}
.chip.danger.active {
  border-color: var(--danger);
  color: var(--danger);
}
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bar);
  border-bottom: 1px solid var(--border);
  text-align: left;
  padding: 7px 10px;
  font-weight: 500;
  color: var(--faint);
  white-space: nowrap;
}
tbody td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
  white-space: nowrap;
}
tbody tr:hover {
  background: var(--hover);
}
tbody tr.orphan {
  background: var(--danger-bg);
}
.col-pid {
  width: 92px;
}
.col-kind {
  width: 190px;
}
.col-num {
  width: 76px;
}
.col-act {
  width: 66px;
}
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.ppid {
  color: var(--faint);
  margin-left: 4px;
  font-size: 11px;
}
.num {
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.cmd {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.act {
  text-align: right;
}
.tag {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--border-strong);
  color: var(--muted);
  margin-right: 4px;
}
.tag.service {
  border-color: var(--accent);
  color: var(--accent);
}
.tag.worker {
  border-color: #8f86c9;
  color: #8f86c9;
}
.tag.orphan-tag {
  border-color: var(--danger);
  color: var(--danger);
}
.empty {
  padding: 28px;
  text-align: center;
  color: var(--faint);
}
.foot {
  margin: 0;
  color: var(--faint);
  font-size: 11.5px;
}
@media (max-width: 720px) {
  .proc-page {
    padding: 10px 10px 18px;
  }
  .search {
    width: 120px;
  }
  .col-kind {
    width: 120px;
  }
}
</style>
