<script setup lang="ts">
// 新建 bot：与「新建会话」同一套字段（模板 + 工作目录），不要求命名、不问类型与身份。
// 名字取工作目录名，唤醒后按第一句话改也行（2026-11-18）。
import { computed, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NInput, NModal, NSelect, NTag, useMessage } from 'naive-ui'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { loadBots, type Bot } from '../composables/useBots'

const emit = defineEmits<{ created: [bot: Bot] }>()
const show = defineModel<boolean>('show', { required: true })

const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()

const templateId = ref<string | null>(null)
const cwd = ref('')
const busy = ref(false)

const templateOptions = computed(() =>
  store.enabledTemplates.map((t) => ({ label: `${t.name}（${t.command}）`, value: t.id }))
)

watch(show, (v) => {
  if (!v) return
  templateId.value = store.enabledTemplates[0]?.id ?? null
  cwd.value = ''
})

watch(templateId, (id) => {
  const t = store.templates.find((x) => x.id === id)
  if (t && !cwd.value) cwd.value = t.cwd
})

async function create() {
  if (!templateId.value) return
  busy.value = true
  try {
    const bot = await api.post<Bot>('/api/bots', {
      templateId: templateId.value,
      cwd: cwd.value.trim() || undefined,
    })
    show.value = false
    await loadBots()
    emit('created', bot)
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
    v-bind="ui.isMobile ? { placement: 'bottom', height: '62%' } : { preset: 'card', title: '新建 bot', style: 'width: 460px' }"
    @update:show="(v: boolean) => (show = v)"
  >
    <component :is="ui.isMobile ? NDrawerContent : 'div'" v-bind="ui.isMobile ? { title: '新建 bot' } : {}">
      <div class="form">
        <label class="field-label">模板</label>
        <n-select v-model:value="templateId" :options="templateOptions" placeholder="选择 agent 模板" />

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

        <div class="name-hint">无需命名——名字取工作目录名</div>

        <n-button
          type="primary"
          block
          :loading="busy"
          :disabled="!templateId"
          class="submit-btn"
          @click="create"
        >
          建
        </n-button>
      </div>
    </component>
  </component>
</template>

<style scoped>
.form {
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
