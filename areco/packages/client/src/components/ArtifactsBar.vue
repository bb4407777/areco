<script setup lang="ts">
// 成果栏：汇总整个对话里提到的文件产物成 chip 列表，免翻记录找文件。
// 纯前端实现：展开时沿 transcript 分页接口把全程翻一遍（只提取路径不渲染消息），
// 按「最后一次提及」去重排序，再逐个打 /api/files/meta 过滤掉不存在的（含历史假路径）。
import { ref, watch } from 'vue'
import { NSpin } from 'naive-ui'
import type { FileMeta, TranscriptPage } from '../../../shared/protocol'
import { api } from '../api'
import { extractFileLinks, iconFor, type FileLink } from '../utils/filelinks'
import { fmtBytes } from '../utils/format'

const props = defineProps<{ sessionId: string; agentLabel?: string }>()
const emit = defineEmits<{ preview: [path: string] }>()

interface Artifact extends FileLink {
  size: number
}

const open = ref(false)
const scanning = ref(false)
const scanned = ref(false)
const items = ref<Artifact[]>([])
let scanGen = 0

// 会话切换时重置状态
watch(() => props.sessionId, () => {
  scanGen++
  open.value = false
  scanning.value = false
  scanned.value = false
  items.value = []
})

const MAX_PAGES = 60 // 翻页安全上限（每页约几十条消息，足够覆盖超长会话）
const MAX_CANDIDATES = 80

async function scan() {
  if (scanning.value) return
  const gen = scanGen
  const sessionId = props.sessionId
  scanning.value = true
  try {
    // 1) 尾页起向前翻完整个 transcript，攒每一次文件提及（时序）
    const pages: string[] = []
    let before: number | undefined
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = before === undefined ? 'cursor=0' : `before=${before}`
      const page = await api.get<TranscriptPage>(`/api/sessions/${sessionId}/transcript?${q}`)
      if (gen !== scanGen) return
      // 三源取材：①正文全量（agent 汇报渠道，但常只写裸文件名）②工具入参全量
      //（Write/Edit 的 file_path 即产物落点）③工具输出只认带「生成/保存」标记的行——
      // 脚本打印的 saved:/OK -> 是真产物，而 find/ls 目录列表行无标记，天然滤掉
      //（实测曾混入 7 份重名模板 + 别案文件）；消息级 chip 仍覆盖工具输出全量，两层互补
      const SAVE_MARK = /(saved|created|written|generated|已生成|已保存|已写入|已产出|输出|成功|OK\s*->|->\s*\/Users)/i
      const text = page.messages
        .flatMap((m) => m.parts)
        .map((p) => {
          if (p.kind === 'text') return p.text
          if (p.kind === 'tool_use') return p.input
          if (p.kind === 'tool_result')
            return p.text
              .split('\n')
              .filter((line) => SAVE_MARK.test(line))
              .join('\n')
          return ''
        })
        .join('\n')
      pages.unshift(text) // 越早的页排越前，保持全程时序
      if (!page.hasMore || page.start === undefined || page.start <= 0) break
      before = page.start
    }
    const mentions: FileLink[] = []
    for (const text of pages) mentions.push(...extractFileLinks(text))

    // 2) 按最后一次提及去重：delete+set 让后提及者排后，整体反转 = 最近提及在前
    const byPath = new Map<string, FileLink>()
    for (const l of mentions) {
      byPath.delete(l.path)
      byPath.set(l.path, l)
    }
    const candidates = [...byPath.values()].reverse().slice(0, MAX_CANDIDATES)

    // 3) 存在性过滤（并发 8）：已删除/假路径的不进成果栏
    const order = new Map(candidates.map((c, i) => [c.path, i]))
    const alive: Artifact[] = []
    let idx = 0
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (idx < candidates.length) {
          const cand = candidates[idx++]
          try {
            const meta = await api.get<FileMeta>(`/api/files/meta?path=${encodeURIComponent(cand.path)}`)
            alive.push({ ...cand, size: meta.size })
          } catch {
            /* 不存在或不可读 → 丢弃 */
          }
        }
      })
    )
    if (gen !== scanGen) return
    alive.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
    items.value = alive
    scanned.value = true
  } catch {
    /* 网络失败：保留现状，下次展开/刷新再试 */
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
  <div class="artifacts">
    <button class="bar-toggle" type="button" @click="toggle">
      <span>📦 成果</span>
      <span v-if="scanned" class="count">{{ items.length }}</span>
      <span class="caret">{{ open ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open" class="panel">
      <div v-if="scanning" class="state"><n-spin size="small" /><span>扫描对话记录中…</span></div>
      <div v-else-if="!items.length" class="state">对话里没发现文件产物</div>
      <div v-else class="chips">
        <button
          v-for="it in items"
          :key="it.path"
          type="button"
          class="chip"
          :title="`${it.path}\n产出 Agent：${agentLabel || '当前 Agent'}`"
          @click="emit('preview', it.path)"
        >
          <span class="fi">{{ iconFor(it.ext) }}</span>
          <span class="fn">{{ it.name }}</span>
          <span class="agent">{{ agentLabel || '当前 Agent' }}</span>
          <span class="fs">{{ fmtBytes(it.size) }}</span>
        </button>
        <button type="button" class="chip refresh" title="重新扫描" @click="scan()">↻ 刷新</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.artifacts {
  border-top: 1px solid var(--border);
  background: var(--bar);
}
.bar-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  touch-action: manipulation;
}
.count {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--chip-bg);
  font-size: 11px;
  font-weight: 600;
}
.caret {
  margin-left: auto;
}
.panel {
  border-top: 1px solid var(--border);
  max-height: 168px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  color: var(--faint);
  font-size: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--chip-bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}
.chip:active {
  transform: scale(0.97);
}
.chip .fi {
  flex: 0 0 auto;
}
.chip .fn {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip .fs {
  flex: 0 0 auto;
  color: var(--faint);
  font-size: 10.5px;
}
.chip .agent {
  flex: 0 1 auto;
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: 10.5px;
}
.chip.refresh {
  color: var(--muted);
}
</style>
