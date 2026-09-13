<script setup lang="ts">
// 项目级成果栏：从多 Agent 项目房间的明确交付回执提取文件，并保留产出者/参与者/时间。
import { computed, ref, watch } from 'vue'
import { NSpin } from 'naive-ui'
import type { FileMeta, RoomMessage } from '../../../shared/protocol'
import { api } from '../api'
import { iconFor } from '../utils/filelinks'
import { fmtBytes } from '../utils/format'
import {
  collectProjectArtifactMentions,
  isLocatedProjectArtifact,
  type ProjectArtifactMention,
} from '../utils/projectArtifacts'

const props = defineProps<{ roomId: string; messages: RoomMessage[]; humanName: string }>()
const emit = defineEmits<{ preview: [path: string]; locate: [path: string] }>()

interface ProjectArtifact extends ProjectArtifactMention {
  size: number | null
}

const open = ref(false)
const scanning = ref(false)
const scanned = ref(false)
const items = ref<ProjectArtifact[]>([])
let scanGen = 0

const sourceKey = computed(() => props.messages.map((message) => message.id).join(','))
watch(sourceKey, () => {
  scanGen++
  scanned.value = false
  if (open.value) void scan()
})

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

async function scan() {
  if (scanning.value) return
  const gen = scanGen
  scanning.value = true
  try {
    // 项目页首载只拿最近 100 条；成果展开时取服务端上限 500 条，再合并 WS 实时消息。
    let sourceMessages = props.messages
    try {
      const history = await api.get<RoomMessage[]>(`/api/rooms/${props.roomId}/messages?limit=500`)
      const byId = new Map(history.map((message) => [message.id, message]))
      for (const message of props.messages) byId.set(message.id, message)
      sourceMessages = [...byId.values()]
    } catch {
      // 旧服务端或瞬时网络失败时仍用页面已经加载的消息，不让成果栏完全不可用。
    }
    if (gen !== scanGen) return
    const candidates = collectProjectArtifactMentions(sourceMessages, props.humanName)
    const order = new Map(candidates.map((candidate, index) => [candidate.path, index]))
    const alive: ProjectArtifact[] = []
    let index = 0
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (index < candidates.length) {
        const candidate = candidates[index++]
        if (!isLocatedProjectArtifact(candidate.path)) {
          // 项目回执常只写案件目录内相对路径。没有项目 rootPath 时只展示来源，不猜绝对位置。
          alive.push({ ...candidate, size: null })
          continue
        }
        try {
          const meta = await api.get<FileMeta>(`/api/files/meta?path=${encodeURIComponent(candidate.path)}`)
          alive.push({ ...candidate, size: meta.size })
        } catch {
          // 明确写出的绝对路径若不存在、已移走或无权读取，则不展示。
        }
      }
    }))
    if (gen !== scanGen) return
    alive.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
    items.value = alive
    scanned.value = true
  } finally {
    if (gen === scanGen) scanning.value = false
  }
}

function toggle() {
  open.value = !open.value
  if (open.value && !scanned.value) void scan()
}
</script>

<template>
  <div class="project-artifacts">
    <button class="bar-toggle" type="button" @click="toggle">
      <span>📦 项目成果</span>
      <span v-if="scanned" class="count">{{ items.length }}</span>
      <span class="hint">标注产出 Agent</span>
      <span class="caret">{{ open ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open" class="panel">
      <div v-if="scanning" class="state"><n-spin size="small" /><span>核验成果文件中…</span></div>
      <div v-else-if="!items.length" class="state">尚未发现 Agent 明确回执的文件成果</div>
      <div v-else class="chips">
        <div
          v-for="item in items"
          :key="item.path"
          class="chip"
          :class="{ unresolved: item.size === null }"
          :title="`${item.path}${item.size === null ? '\n路径待定位：项目未记录案件根目录，未猜测绝对路径' : ''}\n产出：${item.producer}\n时间：${formatTime(item.firstMentionAt)}${item.contributors.length > 1 ? `\n参与：${item.contributors.slice(1).join('、')}` : ''}`"
        >
          <button class="chip-open" type="button" @click="item.size === null ? emit('locate', item.path) : emit('preview', item.path)">
            <span class="fi">{{ iconFor(item.ext) }}</span>
            <span class="main">
              <span class="fn">{{ item.name }}</span>
              <span class="meta">
                <strong>{{ item.producer }}</strong>
                <span>{{ formatTime(item.firstMentionAt) }}</span>
                <span v-if="item.contributors.length > 1">＋{{ item.contributors.length - 1 }} 位参与</span>
              </span>
            </span>
            <span class="fs">{{ item.size === null ? '路径待定位' : fmtBytes(item.size) }}</span>
          </button>
          <button class="locate" type="button" title="在项目文件中定位" @click.stop="emit('locate', item.path)">⌖</button>
        </div>
        <button type="button" class="chip refresh" title="重新扫描" @click="scan()">↻ 刷新</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-artifacts { border-top: 1px solid var(--border); background: var(--bar); }
.bar-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px; border: 0; background: none; color: var(--muted); font-size: 12px; cursor: pointer; }
.count { padding: 0 7px; border-radius: 999px; background: var(--chip-bg); font-size: 11px; font-weight: 600; }
.hint { color: var(--faint); font-size: 10.5px; }
.caret { margin-left: auto; }
.panel { max-height: 210px; overflow-y: auto; border-top: 1px solid var(--border); -webkit-overflow-scrolling: touch; }
.state { display: flex; align-items: center; gap: 8px; padding: 10px 12px; color: var(--faint); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 12px; }
.chip { display: inline-flex; align-items: center; gap: 7px; min-width: 210px; max-width: 100%; padding: 6px 9px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--chip-bg); color: var(--text); font-size: 12px; text-align: left; cursor: pointer; }
.chip:active { transform: scale(0.98); }
.chip-open { display: inline-flex; align-items: center; gap: 7px; flex: 1; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.chip.unresolved { opacity: 0.82; }
.locate { flex: 0 0 auto; border: 0; border-radius: 5px; padding: 2px 5px; background: none; color: var(--muted); cursor: pointer; }
.locate:hover { background: var(--hover); color: var(--accent); }
.main { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.fn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--faint); font-size: 10.5px; }
.meta strong { color: var(--accent); font-weight: 600; }
.fs { flex: 0 0 auto; color: var(--faint); font-size: 10.5px; }
.refresh { min-width: auto; color: var(--muted); }
@media (max-width: 640px) { .chip { width: 100%; min-width: 0; } .hint { display: none; } }
</style>
