<script setup lang="ts">
// 新建会话：默认角色模式（Worker/Thinker 二选一，模板下沉为实现层，按 /api/standcode/roles 解析）；
// 设置页「StandCode 默认角色」卡片可切回模板模式（旧形式，ui.spawnMode=template）。
// cwd 保留最近目录快捷选。不命名——首条消息自动成为会话名（同历史对话）。移动端呈现为底部抽屉。
import { computed, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NInput, NModal, NRadioButton, NRadioGroup, NSelect, NTag, useMessage } from 'naive-ui'
import type { RoleResolved, SessionSummary } from '../../../shared/protocol'
import { api, getUiPrefs } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ show: boolean }>()
// spawned 带完整会话对象：store 靠 ws 推送，spawn 返回瞬间 byId 还查不到，落点判断要用它
const emit = defineEmits<{ 'update:show': [value: boolean]; spawned: [session: SessionSummary] }>()

const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()

const templateId = ref<string | null>(null)
const cwd = ref('')
const busy = ref(false)

// 角色模式：spawnMode !== 'template'（缺省 = role）。roles = 角色当前映射（含来源标记）
const spawnMode = ref<'role' | 'template'>('role')
const role = ref<'worker' | 'thinker'>('worker')
const roles = ref<{ worker: RoleResolved; thinker: RoleResolved } | null>(null)

const ROLE_ORDER = ['worker', 'thinker'] as const
const ROLE_LABELS: Record<(typeof ROLE_ORDER)[number], string> = { worker: 'Worker', thinker: 'Thinker' }
const SOURCE_LABELS: Record<RoleResolved['source'], string> = { settings: '设置', registry: 'registry', fallback: '兜底' }

const templateOptions = computed(() =>
  store.enabledTemplates.map((t) => ({ label: `${t.name}（${t.command}）`, value: t.id }))
)

watch(
  () => props.show,
  async (show) => {
    if (!show) return
    templateId.value = store.enabledTemplates[0]?.id ?? null
    role.value = 'worker'
    cwd.value = ''
    // 旧服务端没有这两个端点（或角色无有效映射）时静默回退模板模式，保证对话框可用
    try {
      const prefs = await getUiPrefs()
      spawnMode.value = prefs.spawnMode === 'template' ? 'template' : 'role'
    } catch {
      spawnMode.value = 'template'
    }
    try {
      roles.value = await api.get<{ worker: RoleResolved; thinker: RoleResolved }>('/api/standcode/roles')
      fillRoleCwd()
    } catch {
      roles.value = null
      spawnMode.value = 'template'
    }
  }
)

watch(templateId, (id) => {
  const template = store.templates.find((t) => t.id === id)
  if (template && !cwd.value) cwd.value = template.cwd
})

// 角色模式下用解析出的模板 cwd 做默认填充（同模板模式口径：只在 cwd 为空时填）
function fillRoleCwd() {
  const resolved = roles.value?.[role.value]
  const template = resolved && store.templates.find((t) => t.id === resolved.templateId)
  if (template && !cwd.value) cwd.value = template.cwd
}
watch(role, fillRoleCwd)

async function submit() {
  if (spawnMode.value === 'template' && !templateId.value) return
  busy.value = true
  try {
    const session =
      spawnMode.value === 'role'
        ? await api.post<SessionSummary>('/api/sessions', { role: role.value, cwd: cwd.value.trim() || undefined })
        : await store.spawn(templateId.value!, { cwd: cwd.value.trim() || undefined })
    ui.rememberCwd(session.cwd)
    emit('update:show', false)
    emit('spawned', session)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <component
    :is="ui.isMobile ? NDrawer : NModal"
    :show="show"
    v-bind="ui.isMobile ? { placement: 'bottom', height: '72%' } : { preset: 'card', title: '新建会话', style: 'width: 460px' }"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <component :is="ui.isMobile ? NDrawerContent : 'div'" v-bind="ui.isMobile ? { title: '新建会话' } : {}">
      <div class="spawn-form">
        <template v-if="spawnMode === 'role'">
          <label class="field-label">角色</label>
          <n-radio-group v-model:value="role" class="role-group">
            <n-radio-button v-for="r in ROLE_ORDER" :key="r" :value="r" class="role-btn">
              <div class="role-name">{{ ROLE_LABELS[r] }}</div>
              <div class="role-tpl">
                {{ roles?.[r]?.templateName ?? '…' }}
                <span v-if="roles?.[r]" class="role-src">{{ SOURCE_LABELS[roles[r].source] }}</span>
              </div>
            </n-radio-button>
          </n-radio-group>
        </template>
        <template v-else>
          <label class="field-label">模板</label>
          <n-select v-model:value="templateId" :options="templateOptions" placeholder="选择 agent 模板" />
        </template>

        <label class="field-label">工作目录</label>
        <n-input v-model:value="cwd" placeholder="留空用模板默认目录" />
        <div v-if="ui.recentCwds.length" class="recent-cwds">
          <n-tag
            v-for="dir in ui.recentCwds"
            :key="dir"
            size="small"
            class="cwd-tag"
            :bordered="false"
            @click="cwd = dir"
          >
            {{ dir }}
          </n-tag>
        </div>

        <div class="name-hint">无需命名——发出的第一句话就是会话名</div>

        <n-button
          type="primary"
          block
          :loading="busy"
          :disabled="spawnMode === 'template' && !templateId"
          class="submit-btn"
          @click="submit"
        >
          启动
        </n-button>
      </div>
    </component>
  </component>
</template>

<style scoped>
.spawn-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.field-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}
.role-group {
  display: flex;
  width: 100%;
}
.role-btn {
  flex: 1;
  height: auto;
  padding: 8px 0;
}
.role-name {
  font-weight: 600;
  line-height: 1.4;
}
.role-tpl {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}
.role-src {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--faint);
  color: var(--bg);
  font-size: 10px;
}
.recent-cwds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cwd-tag {
  cursor: pointer;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.name-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--faint);
}
.submit-btn {
  margin-top: 14px;
}
</style>
