<script setup lang="ts">
// 设置：系统信息（访问地址/版本/认证）+ 模板 CRUD
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NColorPicker,
  NDynamicInput,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import type { StatsSummary, Template } from '../../../shared/protocol'
import { api } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore, type VoiceEngine } from '../stores/ui'
import { fmtUptime, trafficColor } from '../utils/format'
import type { TrafficState } from '../../../shared/traffic'
import { clearInputLog, getInputLog, type InputLogEntry } from '../utils/inputLog'

interface SystemInfo {
  title: string
  version: string
  uptimeMs: number
  authEnabled: boolean
  host: string
  port: number
  maxSessions: number
  urls: { lan: string[]; tailscale: string[] }
  voice?: { engine: string; aliyunApiKeyConfigured: boolean; python: string }
}

const store = useSessionsStore()
const ui = useUiStore()

/** 设置项「新建会话默认进入对话模式」：true=对话，false=终端 */
function setNewSessionDefault(v: boolean) {
  ui.setNewSessionView(v ? 'chat' : 'terminal')
}
const message = useMessage()
const dialog = useDialog()

const appVersion = __APP_VERSION__
const system = ref<SystemInfo | null>(null)
const stats = ref<StatsSummary | null>(null)
const maxSessionsInput = ref<number>(0) // 会话上限编辑值，0 = 无上限
const savingMaxSessions = ref(false)
const showEdit = ref(false)
const editing = ref<Template>(emptyTemplate())
const isCreate = ref(false)
const busy = ref(false)

function emptyTemplate(): Template {
  return { id: '', name: '', command: '', args: [], cwd: '', color: '#7d8590', autoStart: false, enabled: true }
}

// 模板列表圆点：直接复用会话红绿灯——取该模板下会话里最值得关注的状态（无会话=灰）
function dotColor(t: Template): string {
  const ss = store.sessions.filter((s) => s.templateId === t.id)
  if (!ss.length) return trafficColor('exited')
  const rank: Record<TrafficState, number> = { 'needs-user': 0, working: 1, conclusion: 2, exited: 3, idle: 4 }
  const pick = ss.reduce((a, b) => (rank[b.trafficState] < rank[a.trafficState] ? b : a))
  return trafficColor(pick.trafficState, pick.status)
}

onMounted(async () => {
  refreshInputLog()
  try {
    system.value = await api.get<SystemInfo>('/api/system')
    maxSessionsInput.value = system.value.maxSessions
    stats.value = await api.get<StatsSummary>('/api/stats')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
})

// 会话上限：服务端写回 config.json 并即时生效（无需重启）
async function saveMaxSessions() {
  const n = maxSessionsInput.value ?? 0
  savingMaxSessions.value = true
  try {
    const r = await api.put<{ maxSessions: number }>('/api/settings', { maxSessions: n })
    if (system.value) system.value.maxSessions = r.maxSessions
    maxSessionsInput.value = r.maxSessions
    message.success(r.maxSessions === 0 ? '已设为无上限' : `会话上限已设为 ${r.maxSessions}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    savingMaxSessions.value = false
  }
}

// 语音输入设置：engine/fillMode/hotwords 存客户端 localStorage（即时生效）；aliyunKey 存服务端 config
const aliyunKeyInput = ref('')
const savingVoice = ref(false)
function onEngineChange(v: string | number) {
  ui.setVoiceEngine(String(v) as VoiceEngine)
}
function onFillModeChange(v: string | number) {
  ui.setVoiceFillMode(String(v) as 'send' | 'fill')
}
const voiceEngineOptions = [
  { label: 'FunASR（本地·推荐）', value: 'funasr' },
  { label: 'SenseVoice（粤语方言）', value: 'sensevoice' },
  { label: '阿里云（云端）', value: 'aliyun' },
  { label: 'Whisper（兜底）', value: 'whisper' },
]
const voiceFillOptions = [
  { label: '直接发送', value: 'send' },
  { label: '填入输入框', value: 'fill' },
]
async function saveAliyunKey() {
  const key = aliyunKeyInput.value.trim()
  savingVoice.value = true
  try {
    const r = await api.put<{ voice?: { aliyunApiKeyConfigured: boolean } }>('/api/settings', {
      voice: { aliyunApiKey: key },
    })
    if (system.value) {
      system.value.voice = {
        engine: system.value.voice?.engine ?? 'funasr',
        python: system.value.voice?.python ?? 'python3',
        aliyunApiKeyConfigured: r.voice?.aliyunApiKeyConfigured ?? Boolean(key),
      }
    }
    aliyunKeyInput.value = ''
    message.success(key ? '阿里云 Key 已保存' : '阿里云 Key 已清空')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    savingVoice.value = false
  }
}

function openCreate() {
  editing.value = emptyTemplate()
  isCreate.value = true
  showEdit.value = true
}

function openEdit(template: Template) {
  editing.value = JSON.parse(JSON.stringify(template)) as Template
  isCreate.value = false
  showEdit.value = true
}

async function save() {
  busy.value = true
  try {
    if (isCreate.value) await store.createTemplate(editing.value)
    else await store.updateTemplate(editing.value.id, editing.value)
    showEdit.value = false
    message.success('已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
  }
}

function confirmRemove(template: Template) {
  dialog.warning({
    title: '删除模板',
    content: `删除模板「${template.name}」？既有会话不受影响。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await store.removeTemplate(template.id)
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      }
    },
  })
}

// —— 模板拖动排序：pointer 事件自实现（HTML5 DnD 在 iOS 上不可用）。
// 手柄按下后挂 window 级 move/up 监听——拖动中 Vue 会挪行节点，节点上的 pointer capture 会丢；
// 拖动只改本地副本，松手才持久化，服务端回包为准。
const templateListEl = ref<HTMLElement | null>(null)
const dragId = ref<string | null>(null)
const dragList = ref<Template[]>([])
let dragPointerId = -1

const displayTemplates = computed(() => (dragId.value ? dragList.value : store.templates))

function dragStart(e: PointerEvent, template: Template) {
  if (dragId.value) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  dragPointerId = e.pointerId
  dragList.value = [...store.templates]
  dragId.value = template.id
  window.addEventListener('pointermove', dragMove)
  window.addEventListener('pointerup', dragEnd)
  window.addEventListener('pointercancel', dragCancel)
}

function dragMove(e: PointerEvent) {
  if (e.pointerId !== dragPointerId || !dragId.value) return
  const rows = Array.from(templateListEl.value?.querySelectorAll<HTMLElement>('.template-row') ?? [])
  const from = dragList.value.findIndex((t) => t.id === dragId.value)
  if (from < 0 || rows.length !== dragList.value.length) return
  let to = from
  for (let i = 0; i < rows.length; i++) {
    if (i === from) continue
    const rect = rows[i].getBoundingClientRect()
    const mid = rect.top + rect.height / 2
    if (i < from && e.clientY < mid) {
      to = i
      break
    }
    if (i > from && e.clientY > mid) to = i
  }
  if (to === from) return
  const list = [...dragList.value]
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  dragList.value = list
}

async function dragEnd(e: PointerEvent) {
  if (e.pointerId !== dragPointerId) return
  stopDragListeners()
  const ids = dragList.value.map((t) => t.id)
  const changed = ids.some((id, i) => store.templates[i]?.id !== id)
  if (changed) store.templates = dragList.value
  dragId.value = null
  if (!changed) return
  try {
    await store.reorderTemplates(ids)
    message.success('顺序已保存')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 旧服务端没有 reorder 路由：全局 404 处理器回 JSON「未找到」（非 JSON 形态才是「响应异常（HTTP 404）」）
    const stale = msg === '未找到' || msg.includes('404')
    message.error(stale ? '顺序保存失败：服务端还在跑旧版本，重启 areco 后再拖一次' : `顺序保存失败：${msg}`)
    await store.refreshTemplates()
  }
}

function dragCancel(e: PointerEvent) {
  if (e.pointerId !== dragPointerId) return
  stopDragListeners()
  dragId.value = null
}

function stopDragListeners() {
  dragPointerId = -1
  window.removeEventListener('pointermove', dragMove)
  window.removeEventListener('pointerup', dragEnd)
  window.removeEventListener('pointercancel', dragCancel)
}

onBeforeUnmount(stopDragListeners)

function logout() {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = '/logout'
  document.body.appendChild(form)
  form.submit()
}

// —— 一键刷新：只重载页面，不动服务（拉新前端资源/重置看板状态用）
// 不用 location.reload()：WKWebView/主屏 PWA 下 reload 会卡白屏（2026-07-24 报障）；
// 带时间戳参数整页跳转 = 强制全新加载（index.html 本身 no-store，哈希 bundle 随新 HTML 更新）
function hardReload() {
  const url = new URL(location.href)
  url.searchParams.set('_r', String(Date.now()))
  location.assign(url.toString())
}
function reloadPage() {
  hardReload()
}

// —— 一键重启：等价命令行 ./start.sh restart；服务会自杀再拉起，
// 响应可能正常返回也可能被掐断，统一进入轮询，healthz 活了自动刷新页面
const restarting = ref(false)
async function restartServer() {
  if (restarting.value) return
  restarting.value = true
  try {
    await api.post('/api/server/restart', {})
  } catch {
    /* 进程可能先走一步，忽略，照常等待 */
  }
  message.info('重启中，服务恢复后自动刷新…', { duration: 60000 })
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const res = await fetch('/healthz', { cache: 'no-store' })
      if (res.ok && (await res.text()).includes('"version"')) {
        hardReload()
        return
      }
    } catch {
      /* 还没起来，继续等 */
    }
  }
}

// —— 输入诊断（排查手机端吞字/标点丢失）：本地环形日志，最新在前
const inputLog = ref<InputLogEntry[]>([])
function refreshInputLog() {
  inputLog.value = getInputLog().slice().reverse()
}
function fmtLogTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
function fmtLogLine(e: InputLogEntry): string {
  const okMark = e.kind === 'data' ? (e.ok ? ' ✓' : ' ✗未送达') : ''
  return `${fmtLogTs(e.ts)} [${e.kind}] ${e.detail}${okMark}`
}
async function copyInputLog() {
  const content = inputLog.value.map(fmtLogLine).join('\n') || '（空）'
  // 局域网 http 非安全上下文 navigator.clipboard 被拒，降级 execCommand
  try {
    await navigator.clipboard.writeText(content)
    message.success('已复制到剪贴板')
    return
  } catch {
    /* 走降级 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = content
    ta.setAttribute('readonly', '') // 防 iOS focus 弹键盘
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, content.length) // iOS 需要显式选区
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (!ok) throw new Error('execCommand 返回 false')
    message.success('已复制到剪贴板')
  } catch {
    message.error('复制失败——可长按下方日志区手动全选复制')
  }
}
function clearLog() {
  clearInputLog()
  refreshInputLog()
  message.success('已清空')
}
</script>

<template>
  <div class="settings">
    <n-card title="系统" size="small" class="block">
      <div v-if="system" class="sysinfo">
        <div class="row"><span class="k">版本</span><span>v{{ system.version }}（前端 v{{ appVersion }}）</span></div>
        <div class="row"><span class="k">监听</span><span class="mono">{{ system.host }}:{{ system.port }}</span></div>
        <div class="row">
          <span class="k">认证</span>
          <n-tag size="small" :type="system.authEnabled ? 'success' : 'warning'" :bordered="false">
            {{ system.authEnabled ? '已启用' : '未启用（仅本机）' }}
          </n-tag>
        </div>
        <div v-if="system.urls.lan.length" class="row">
          <span class="k">局域网</span><span class="mono">{{ system.urls.lan.join('　') }}</span>
        </div>
        <div v-if="system.urls.tailscale.length" class="row">
          <span class="k">Tailscale</span><span class="mono">{{ system.urls.tailscale.join('　') }}</span>
        </div>
        <div class="row">
          <span class="k">会话上限</span>
          <n-input-number
            v-model:value="maxSessionsInput"
            :min="0"
            :precision="0"
            size="small"
            style="width: 100px"
          />
          <span class="hint">0 = 无上限</span>
          <n-button
            size="tiny"
            secondary
            :loading="savingMaxSessions"
            :disabled="maxSessionsInput === system.maxSessions"
            @click="saveMaxSessions"
          >保存</n-button>
        </div>
        <div v-if="stats" class="row">
          <span class="k">今日</span>
          <span>
            {{ stats.runningSessions }}/{{ stats.totalSessions }} 会话运行中 ·
            {{ stats.todayPromptCount }} 条指令 ·
            运行 {{ fmtUptime(stats.todayRuntimeMs) }} ·
            输出 {{ Math.round(stats.todayOutputChars / 1024) }}K 字符
          </span>
        </div>
      </div>
      <template #footer>
        <n-button size="small" secondary type="success" @click="reloadPage">一键刷新</n-button>
        <!-- 一键重启免确认（2026-07-23 维护者定）：点了就重启，运行中会话会中断，恢复后自动刷新 -->
        <n-button size="small" secondary type="error" :loading="restarting" style="margin-left: 12px" @click="restartServer">一键重启</n-button>
        <!-- 认证未启用时退出登录 = 跳登录页又弹回首页（原地转圈），不显示 -->
        <n-button v-if="system?.authEnabled" size="small" secondary style="margin-left: 12px" @click="logout">退出登录</n-button>
      </template>
    </n-card>

    <n-card size="small" class="block">
      <template #header>Agent 模板</template>
      <template #header-extra>
        <n-button size="tiny" type="primary" @click="openCreate">＋ 新建</n-button>
      </template>
      <div ref="templateListEl" class="template-list">
        <div
          v-for="template in displayTemplates"
          :key="template.id"
          class="template-row"
          :class="{ dragging: dragId === template.id }"
        >
          <span class="drag-handle" title="拖动排序" @pointerdown="dragStart($event, template)">⠿</span>
          <span class="dot" :style="{ background: dotColor(template) }" />
          <div class="template-main">
            <div class="template-name">
              {{ template.name }}
              <n-tag v-if="!template.enabled" size="small" :bordered="false" class="off-tag">停用</n-tag>
              <n-tag v-if="template.autoStart" size="small" :bordered="false" type="info">自启</n-tag>
            </div>
            <div class="template-cmd mono">{{ template.command }} {{ template.args.join(' ') }}</div>
          </div>
          <n-button size="tiny" quaternary @click="openEdit(template)">编辑</n-button>
          <n-button size="tiny" quaternary type="error" @click="confirmRemove(template)">删</n-button>
        </div>
      </div>
    </n-card>

    <n-card size="small" class="block">
      <template #header>对话模式</template>
      <div class="pref-row">
        <div>
          <div class="pref-label">新建会话默认进入对话模式</div>
          <div class="pref-hint">默认关闭（新建先进终端看启动画面）；shell 等无落盘会话始终进终端</div>
        </div>
        <n-switch :value="ui.newSessionView === 'chat'" @update:value="setNewSessionDefault" />
      </div>
      <div class="pref-row">
        <div>
          <div class="pref-label">显示思考过程</div>
          <div class="pref-hint">默认关闭，勾选后才展开 agent 的思考块</div>
        </div>
        <n-switch :value="ui.showThinking" @update:value="ui.setShowThinking" />
      </div>
      <div class="pref-row">
        <div>
          <div class="pref-label">显示工具调用</div>
          <div class="pref-hint">默认关闭，勾选后才展示工具调用及入参</div>
        </div>
        <n-switch :value="ui.showToolUse" @update:value="ui.setShowToolUse" />
      </div>
      <div class="pref-row">
        <div>
          <div class="pref-label">显示工具结果</div>
          <div class="pref-hint">默认关闭，勾选后才展示工具返回结果</div>
        </div>
        <n-switch :value="ui.showToolResult" @update:value="ui.setShowToolResult" />
      </div>
    </n-card>

    <n-card size="small" class="block">
      <template #header>语音输入</template>
      <div class="pref-row">
        <div>
          <div class="pref-label">识别引擎</div>
          <div class="pref-hint">FunASR=本地 Paraformer（默认·免费·带热词）；SenseVoice=粤语/方言；阿里云=云端（需配下方 Key）；Whisper=兜底</div>
        </div>
        <n-select
          :value="ui.voiceEngine"
          :options="voiceEngineOptions"
          size="small"
          style="width: 210px"
          @update:value="onEngineChange"
        />
      </div>
      <div class="pref-row">
        <div>
          <div class="pref-label">松开后</div>
          <div class="pref-hint">直接发送=微信式（默认）；填入输入框=可改字加附件再发</div>
        </div>
        <n-select
          :value="ui.voiceFillMode"
          :options="voiceFillOptions"
          size="small"
          style="width: 150px"
          @update:value="onFillModeChange"
        />
      </div>
      <div class="pref-row">
        <div>
          <div class="pref-label">热词（仅 FunASR）</div>
          <div class="pref-hint">空格分隔，提升人名/术语识别准确率</div>
        </div>
        <n-input
          :value="ui.voiceHotwords"
          placeholder="如 高律师 立案 判决"
          size="small"
          style="width: 240px"
          @update:value="(v: string) => ui.setVoiceHotwords(v)"
        />
      </div>
      <div class="pref-row">
        <div>
          <div class="pref-label">阿里云 API Key</div>
          <div class="pref-hint">
            仅「阿里云」引擎用，sk- 开头；存服务端不回显明文<span v-if="system?.voice?.aliyunApiKeyConfigured">（已配置）</span>
          </div>
        </div>
        <n-input
          v-model:value="aliyunKeyInput"
          type="password"
          show-password-on="click"
          :placeholder="system?.voice?.aliyunApiKeyConfigured ? '留空保存=清除已配置的 Key' : 'sk-...'"
          size="small"
          style="width: 260px"
        />
        <n-button size="small" type="primary" :loading="savingVoice" @click="saveAliyunKey">保存</n-button>
      </div>
    </n-card>

    <n-card size="small" class="block">
      <template #header>输入诊断</template>
      <template #header-extra>
        <n-button size="tiny" secondary @click="refreshInputLog">刷新</n-button>
        <n-button size="tiny" secondary @click="copyInputLog">复制</n-button>
        <n-button size="tiny" quaternary type="error" @click="clearLog">清空</n-button>
      </template>
      <div class="log-tip">手机端吞字/标点丢失排查用：终端每次键入与输入法组字事件的本地记录（最新在前，仅存本机）。</div>
      <pre v-if="inputLog.length" class="log-view">{{ inputLog.map(fmtLogLine).join('\n') }}</pre>
      <div v-else class="log-tip">暂无记录——去终端里打几个字再回来刷新。</div>
    </n-card>

    <n-modal v-model:show="showEdit" preset="card" :title="isCreate ? '新建模板' : `编辑模板 ${editing.id}`" class="edit-modal">
      <n-form label-placement="left" label-width="76" size="small">
        <n-form-item label="id">
          <n-input v-model:value="editing.id" :disabled="!isCreate" placeholder="字母数字-_" />
        </n-form-item>
        <n-form-item label="名称"><n-input v-model:value="editing.name" /></n-form-item>
        <n-form-item label="命令"><n-input v-model:value="editing.command" placeholder="claude / codex / …" /></n-form-item>
        <n-form-item label="参数">
          <n-dynamic-input v-model:value="editing.args" placeholder="单个参数" :min="0" />
        </n-form-item>
        <n-form-item label="默认目录"><n-input v-model:value="editing.cwd" placeholder="留空 = 服务端 HOME" /></n-form-item>
        <n-form-item label="颜色"><n-color-picker v-model:value="editing.color" :show-alpha="false" /></n-form-item>
        <n-form-item label="随服务自启"><n-switch v-model:value="editing.autoStart" /></n-form-item>
        <n-form-item label="启用"><n-switch v-model:value="editing.enabled" /></n-form-item>
      </n-form>
      <template #footer>
        <n-button type="primary" block :loading="busy" @click="save">保存</n-button>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px calc(20px + env(safe-area-inset-bottom, 0px));
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sysinfo {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.k {
  flex: 0 0 64px;
  color: var(--muted);
}
.hint {
  font-size: 11.5px;
  color: var(--muted);
}
.pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.pref-row:last-child {
  border-bottom: 0;
}
.pref-label {
  font-size: 13px;
  font-weight: 600;
}
.pref-hint {
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 2px;
}
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
}
.template-list {
  display: flex;
  flex-direction: column;
}
.template-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.template-row:last-child {
  border-bottom: 0;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.drag-handle {
  flex: 0 0 auto;
  cursor: grab;
  touch-action: none; /* 关键：iOS 上按住手柄拖动不触发页面滚动 */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  padding: 6px 4px;
  margin-left: -4px;
}
.template-row.dragging {
  background: var(--chip-bg);
  border-radius: 8px;
}
.template-row.dragging .drag-handle {
  cursor: grabbing;
}
.template-main {
  flex: 1;
  min-width: 0;
}
.template-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  gap: 6px;
  align-items: center;
}
.off-tag {
  background: var(--chip-bg);
}
.template-cmd {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edit-modal {
  width: min(520px, calc(100vw - 24px));
}
.log-tip {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
.log-view {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--input-bg);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
</style>
