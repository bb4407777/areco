<script setup lang="ts">
// OPC 后台页（2026-11-07）：一屏看轨道健康 + 看板在办 + 最近跑单。
// 数据源全在服务端 services/opc.ts（只读 ~/skills/opc 与 ~/.hermes/kanban/logs）；
// 这里只展示与按需拉单张工单的日志尾部，不提供任何写操作。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NInput, NModal, NSwitch, useMessage } from 'naive-ui'
import { api } from '../api'
import type { OpcRun, OpcSnapshot, OpcTaskLog, OpcTaskRow, OpcTrackRow } from '../../../shared/protocol'

const message = useMessage()

const snap = ref<OpcSnapshot | null>(null)
const loading = ref(false)
const auto = ref(true)
const q = ref('')
const logShow = ref(false)
const logLoading = ref(false)
const logTitle = ref('')
const log = ref<OpcTaskLog | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

const STATUS_TEXT: Record<string, string> = {
  ready: '待派',
  claimed: '认领',
  running: '在跑',
  in_progress: '在跑',
  blocked: '阻断',
}

const tasks = computed<OpcTaskRow[]>(() => {
  const kw = q.value.trim().toLowerCase()
  const rows = snap.value?.tasks ?? []
  if (!kw) return rows
  return rows.filter((r) => `${r.title}\n${r.assignee}\n${r.id}`.toLowerCase().includes(kw))
})

const runs = computed<OpcRun[]>(() => {
  const kw = q.value.trim().toLowerCase()
  const rows = (snap.value?.runs ?? []).slice(0, 80)
  if (!kw) return rows
  return rows.filter((r) => `${r.title}\n${r.dept}\n${r.track}\n${r.tracks}`.toLowerCase().includes(kw))
})

const activeCount = computed(
  () => (snap.value?.counts.ready ?? 0) + (snap.value?.counts.claimed ?? 0) + (snap.value?.counts.running ?? 0) + (snap.value?.counts.in_progress ?? 0)
)

const updatedAt = computed(() =>
  snap.value ? new Date(snap.value.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
)

function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDur(sec: number): string {
  if (!sec) return '—'
  if (sec < 60) return `${sec.toFixed(0)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`
  return `${(sec / 3600).toFixed(1)}h`
}

function trackState(t: OpcTrackRow): string {
  if (t.status === 'cooldown') {
    const left = Math.max(0, Math.round(t.cooldownUntil - Date.now() / 1000))
    return `冷却 ${left}s`
  }
  if (t.status === 'error') return t.lastErrorKind || '异常'
  if (t.status === 'missing') return '未用'
  return '正常'
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    snap.value = await api.get<OpcSnapshot>('/api/opc')
    if (snap.value.warning) message.warning(snap.value.warning)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

async function openLog(row: OpcTaskRow): Promise<void> {
  logTitle.value = `${row.title || row.id}（${row.id}）`
  log.value = null
  logShow.value = true
  logLoading.value = true
  try {
    log.value = await api.get<OpcTaskLog>(`/api/opc/tasks/${row.id}/log`)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    logLoading.value = false
  }
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
  <div class="opc-page">
    <div class="toolbar">
      <h2 class="page-title">OPC 后台</h2>
      <span class="counts">
        在办 <b>{{ activeCount }}</b> · 待派 <b>{{ snap?.counts.ready ?? 0 }}</b> · 阻断
        <b>{{ snap?.counts.blocked ?? 0 }}</b> · 累计完成
        <b>{{ snap?.counts.done ?? 0 }}</b>
      </span>
      <div class="toolbar-actions">
        <n-input v-model:value="q" size="small" clearable placeholder="搜工单 / 轨 / 部门" class="search" />
        <span class="auto-switch">
          <n-switch v-model:value="auto" size="small" @update:value="restartTimer" />
          <span class="auto-text">自动刷新</span>
        </span>
        <n-button size="small" :loading="loading" @click="refresh">刷新</n-button>
      </div>
    </div>

    <div class="tracks">
      <span
        v-for="t in snap?.tracks ?? []"
        :key="t.id"
        class="track"
        :class="t.status"
        :title="`${t.label}\n模型 ${t.model || '账户默认'}\n冷却至 ${t.cooldownUntil ? new Date(t.cooldownUntil * 1000).toLocaleString('zh-CN') : '—'}\n最近错误 ${t.lastError || '无'}`"
      >
        {{ t.id }}
        <span class="track-state">{{ trackState(t) }}</span>
        <span class="track-used">{{ t.used }} 单</span>
      </span>
      <span v-if="!snap?.tracks.length" class="empty-inline">轨道表读取中…</span>
    </div>

    <section class="block">
      <div class="block-head">
        <h3>在办工单</h3>
        <span class="hint">点「日志」看该单工人最后 400 行</span>
      </div>
      <div class="table-wrap short">
        <table>
          <thead>
            <tr>
              <th class="col-id">工单</th>
              <th class="col-st">状态</th>
              <th class="col-dept">岗位</th>
              <th class="col-time">创建</th>
              <th class="col-fail">连败</th>
              <th>标题</th>
              <th class="col-act" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in tasks" :key="r.id">
              <td class="mono">{{ r.id }}</td>
              <td>
                <span class="tag" :class="r.status">{{ STATUS_TEXT[r.status] ?? r.status }}</span>
              </td>
              <td>{{ r.assignee }}</td>
              <td class="num">{{ fmtTime(r.createdAt * 1000) }}</td>
              <td class="num" :class="{ danger: r.failures > 0 }">{{ r.failures }}</td>
              <td class="title" :title="r.title">{{ r.title }}</td>
              <td class="act">
                <n-button v-if="r.hasLog" size="tiny" ghost @click="openLog(r)">日志</n-button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!tasks.length" class="empty">{{ snap ? '队列里没有在办工单' : '读取中…' }}</div>
      </div>
    </section>

    <section class="block">
      <div class="block-head">
        <h3>最近跑单</h3>
        <span class="hint">换轨单的「轨」列显示 轨1→轨2…</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-time">开始</th>
              <th class="col-dept">岗位</th>
              <th>标题</th>
              <th class="col-track">轨</th>
              <th class="col-model">模型</th>
              <th class="col-dur">耗时</th>
              <th class="col-ok">结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="`${r.taskId}-${r.ts}`" :class="{ bad: !r.ok }">
              <td class="num">{{ fmtTime(Date.parse(r.ts)) }}</td>
              <td>{{ r.dept }}</td>
              <td class="title" :title="r.title">{{ r.title }}</td>
              <td class="mono track-cell">
                {{ r.tracks || r.track }}
                <span v-if="r.fallback" class="tag fallback">换轨</span>
              </td>
              <td class="mono">{{ r.model }}</td>
              <td class="num">{{ fmtDur(r.durS) }}</td>
              <td>
                <span class="tag" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '成' : r.errKind || '败' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!runs.length" class="empty">{{ snap ? '没有匹配的跑单' : '读取中…' }}</div>
      </div>
    </section>

    <p class="foot">只读视图 · 数据来自 ~/skills/opc 台账与看板 · 更新于 {{ updatedAt }}</p>

    <NModal v-model:show="logShow" preset="card" :title="`工人日志 · ${logTitle}`" class="log-modal">
      <div v-if="logLoading" class="empty">读取中…</div>
      <template v-else-if="log">
        <p class="log-meta">{{ log.path }}<span v-if="log.truncated"> · 仅显示尾部</span></p>
        <pre class="log-body">{{ log.lines.join('\n') }}</pre>
      </template>
      <div v-else class="empty">没有日志</div>
    </NModal>
  </div>
</template>

<style scoped>
.opc-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.counts {
  color: var(--muted);
  font-size: 12px;
}
.counts b {
  color: var(--text);
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
.tracks {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.track {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 11px;
  font-size: 11.5px;
  color: var(--text);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.track.ok {
  border-color: var(--accent);
}
.track.cooldown {
  border-color: #e8a33d;
}
.track.error,
.track.missing {
  border-color: var(--faint);
  color: var(--faint);
}
.track-state {
  color: var(--muted);
  font-family: inherit;
}
.track-used {
  color: var(--faint);
}
.empty-inline {
  color: var(--faint);
  font-size: 12px;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  flex: 1;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.block-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.hint {
  color: var(--faint);
  font-size: 11.5px;
}
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.table-wrap.short {
  max-height: 34vh;
  flex: 0 1 auto;
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
tbody tr.bad {
  background: var(--danger-bg);
}
.col-id {
  width: 104px;
}
.col-st,
.col-ok {
  width: 70px;
}
.col-dept {
  width: 104px;
}
.col-time {
  width: 92px;
}
.col-fail,
.col-dur {
  width: 62px;
}
.col-track {
  width: 200px;
}
.col-model {
  width: 190px;
}
.col-act {
  width: 60px;
}
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.num {
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.num.danger {
  color: var(--danger);
}
.title {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.track-cell {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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
}
.tag.running,
.tag.in_progress {
  border-color: var(--accent);
  color: var(--accent);
}
.tag.claimed {
  border-color: #8f86c9;
  color: #8f86c9;
}
.tag.blocked {
  border-color: var(--danger);
  color: var(--danger);
}
.tag.ok {
  border-color: var(--accent);
  color: var(--accent);
}
.tag.bad {
  border-color: var(--danger);
  color: var(--danger);
}
.tag.fallback {
  margin-left: 4px;
  border-color: #e8a33d;
  color: #e8a33d;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--faint);
}
.foot {
  margin: 0;
  color: var(--faint);
  font-size: 11.5px;
}
.log-meta {
  margin: 0 0 8px;
  color: var(--faint);
  font-size: 11.5px;
  word-break: break-all;
}
.log-body {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--code-bg, #11151c);
  color: var(--text);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
@media (max-width: 720px) {
  .opc-page {
    padding: 10px 10px 18px;
  }
  .search {
    width: 120px;
  }
  .counts {
    display: none;
  }
}
</style>
