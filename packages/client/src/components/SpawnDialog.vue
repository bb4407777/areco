<script setup lang="ts">
// 新建会话：模板 + cwd（最近目录快捷选）。不命名——首条消息自动成为会话名（同历史对话）。移动端呈现为底部抽屉。
import { computed, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NInput, NModal, NSelect, NTag, useMessage } from 'naive-ui'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; spawned: [id: string] }>()

const store = useSessionsStore()
const ui = useUiStore()
const message = useMessage()

const templateId = ref<string | null>(null)
const cwd = ref('')
const busy = ref(false)

const templateOptions = computed(() =>
  store.enabledTemplates.map((t) => ({ label: `${t.name}（${t.command}）`, value: t.id }))
)

watch(
  () => props.show,
  (show) => {
    if (show) {
      templateId.value = store.enabledTemplates[0]?.id ?? null
      cwd.value = ''
    }
  }
)

watch(templateId, (id) => {
  const template = store.templates.find((t) => t.id === id)
  if (template && !cwd.value) cwd.value = template.cwd
})

async function submit() {
  if (!templateId.value) return
  busy.value = true
  try {
    const session = await store.spawn(templateId.value, {
      cwd: cwd.value.trim() || undefined,
    })
    ui.rememberCwd(session.cwd)
    emit('update:show', false)
    emit('spawned', session.id)
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

        <div class="name-hint">无需命名——发出的第一句话就是会话名</div>

        <n-button type="primary" block :loading="busy" :disabled="!templateId" class="submit-btn" @click="submit">
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
