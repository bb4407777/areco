<script setup lang="ts">
// 会话卡片：状态点 + 名称（首条消息）+ 模板/模型名（标题下左对齐，同侧栏）+ 底部 cwd/uptime + 快捷动词
// lastLine 预览已撤：空闲会话恒为状态栏噪音（context %/bypass permissions）
import { computed } from 'vue'
import { NButton, NDropdown, NTag } from 'naive-ui'
import type { SessionSummary } from '../../../shared/protocol'
import { useSessionsStore } from '../stores/sessions'
import { EXIT_REASON_TEXT, STATUS_TEXT, chatCapable, fmtTime, fmtUptime, shortPath, templateColor, templateLabel, trafficColor } from '../utils/format'

const props = defineProps<{ session: SessionSummary; now: number }>()
const emit = defineEmits<{
  open: []
  stop: []
  kill: []
  restart: [resume: boolean]
  rename: []
  pin: [pinned: boolean]
  archive: []
  unarchive: []
  remove: []
  handoff: [templateId: string]
}>()

const isLive = computed(() => ['running', 'spawning', 'stopping'].includes(props.session.status))
const uptime = computed(() => {
  const s = props.session
  if (isLive.value && s.startedAt) return fmtUptime(props.now - s.startedAt)
  if (s.exitedAt) return fmtTime(s.exitedAt)
  return '—'
})
const subtitle = computed(() => {
  const s = props.session
  if (s.status === 'exited' && s.exitReason) return EXIT_REASON_TEXT[s.exitReason]
  return STATUS_TEXT[s.status]
})

const store = useSessionsStore()
// 可原生恢复对话的会话（claude 系/codex/codebuddy/reasonix）：重启默认续上对话
const resumable = computed(() => chatCapable(props.session, store.templates))

// 会话名已改为首条消息，agent 身份从名称里消失——底部显示模板名补上（模板已删则退回命令名）
const templateName = computed(() => templateLabel(props.session, store.templates))

// 换 agent 接手候选：全部启用的非 shell 模板（对话写成交接档案，新 agent 读档续干）
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish'])
const handoffChildren = computed(() =>
  store.templates
    .filter((t) => t.enabled && !SHELLS.has(t.command.split('/').pop() ?? ''))
    .map((t) => ({ label: `用 ${t.name} 接手`, key: `handoff:${t.id}` }))
)

const lightColor = computed(() =>
  trafficColor(props.session.trafficState, props.session.status)
)

const menuOptions = computed(() => {
  const s = props.session
  const options = []
  options.push({ label: '重命名', key: 'rename' })
  if (isLive.value) {
    options.push({ label: '停止（SIGTERM）', key: 'stop' })
    options.push({ label: '强制终止（SIGKILL）', key: 'kill' })
  } else {
    if (resumable.value) {
      options.push({ label: '重新启动（恢复对话）', key: 'resume' })
    } else {
      options.push({ label: '重新启动', key: 'restart' })
    }
    for (const t of handoffChildren.value) {
      options.push(t)
    }
  }
  options.push(s.pinned ? { label: '取消总台钉选', key: 'unpin' } : { label: '钉为总台（房间加成员置顶）', key: 'pin' })
  // 归档/恢复与删除对所有状态开放（运行中也能归档，与运行中能删除同口径）
  if (s.archived) options.push({ label: '恢复到看板', key: 'unarchive' })
  else options.push({ label: '归档（移出看板，保留记录）', key: 'archive' })
  options.push({ label: '删除会话', key: 'remove' })
  return options
})

function onMenu(key: string) {
  if (key === 'stop') emit('stop')
  else if (key === 'kill') emit('kill')
  else if (key === 'restart') emit('restart', false)
  else if (key === 'resume') emit('restart', true)
  else if (key === 'rename') emit('rename')
  else if (key === 'pin' || key === 'unpin') emit('pin', key === 'pin')
  else if (key === 'archive') emit('archive')
  else if (key === 'unarchive') emit('unarchive')
  else if (key === 'remove') emit('remove')
  else if (key.startsWith('handoff:')) emit('handoff', key.slice(8))
}
</script>

<template>
  <div class="card" :class="{ dead: !isLive }" @click="emit('open')">
    <div class="card-head">
      <span class="dot" :style="{ background: lightColor, boxShadow: `0 0 0 3px ${lightColor}22` }" />
      <span class="name">{{ session.pinned ? '⭐ ' : '' }}{{ session.name }}</span>
      <n-tag size="small" :bordered="false" class="status-tag" :style="{ color: lightColor }">
        {{ subtitle }}
      </n-tag>
      <span class="spacer" />
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button size="tiny" quaternary circle class="menu-btn" @click.stop>⋯</n-button>
      </n-dropdown>
    </div>
    <div v-if="templateName" class="template" :style="{ color: templateColor(session, store.templates) }">{{ templateName }}</div>
    <div class="card-foot">
      <span class="cwd">{{ shortPath(session.cwd) }}</span>
      <span class="uptime">{{ uptime }}</span>
    </div>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 14px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  cursor: pointer;
  transition:
    border-color 0.15s,
    transform 160ms var(--ease-out);
  /* 解除 grid 项 min-width:auto——否则 nowrap 的 cwd 会把 1fr 轨道撑爆（手机上整页横向溢出） */
  min-width: 0;
}
.card:hover {
  border-color: var(--border-strong);
}
.card:active {
  transform: scale(0.98);
}
.card.dead {
  opacity: 0.75;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.name {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.status-tag {
  flex: 0 0 auto;
  background: var(--chip-bg);
  font-size: 11px;
}
.spacer {
  flex: 1;
}
.menu-btn {
  color: var(--muted);
}
.card-foot {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--faint);
  min-width: 0;
}
.cwd {
  font-family: ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.template {
  /* 标题下第二行，左对齐——与侧栏 item-preview 同位（卡片 gap 8px 偏松，收紧贴题）*/
  margin-top: -4px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.uptime {
  flex: 0 0 auto;
  margin-left: 10px;
}
</style>
