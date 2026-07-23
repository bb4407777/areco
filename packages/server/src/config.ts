import fs from 'node:fs'
import path from 'node:path'
import type { Template } from '../../shared/protocol'
import { createLogger } from './logger'

const log = createLogger('config')

export interface ServerConfig {
  host: string
  port: number
  passwordHash: string
  sessionTtlHours: number
  title: string
  allowedHosts: string[]
  /** 同时运行会话数上限；0 = 无上限（默认）。可在设置页在线修改，即时生效 */
  maxSessions: number
  /** 显式免密开关：true = 非 loopback 也允许无密码启动（自担风险，仅限完全可信的网络） */
  insecureNoAuth: boolean
  /**
   * 文件预览白名单根目录（绝对路径）。/api/files 只放行 realpath 落在这些根内的文件，
   * 挡目录穿越与软链逃逸。空数组 = 关闭文件预览。默认给桌面/下载/临时目录。
   */
  fileRoots: string[]
  /** 显式关闭文件预览白名单：true = 登录用户可预览本机任意文件（自担风险，仅限单人完全可信场景） */
  fileRootsUnrestricted: boolean
}

export interface VoiceConfig {
  /** 默认 ASR 引擎：funasr(本地 Paraformer,默认)/sensevoice(粤语方言)/aliyun(云 dashscope)/whisper(兜底)。
   *  前端设置页可逐次覆盖（存 localStorage 随请求带）；此处是服务端兜底默认 */
  engine?: 'funasr' | 'sensevoice' | 'aliyun' | 'whisper'
  /** 阿里云 dashscope API Key（sk- 开头），仅 aliyun 引擎用。存服务端 config，绝不回传前端明文 */
  aliyunApiKey?: string
  /** python 解释器路径（须已装 funasr / openai-whisper），默认 'python3' */
  python?: string
}

export interface AppConfig {
  server: ServerConfig
  templates: Template[]
  /** 群聊里人类成员的名字（房间花名册/@mention 用）；缺省 Owner */
  humanName?: string
  /** 允许「转述人类原话」的 agent 白名单（如微信通道 Hermes）：其带 human_relay 标记的
   *  项目消息按人类语义投递（清零链深+默认投全体）。缺省空=功能关闭。 */
  humanRelayAgents?: string[]
  /** 语音输入（长按说话→转写）：ASR 引擎默认值 + 阿里云凭证 + python 解释器 */
  voice?: VoiceConfig
}

const HOME = process.env.HOME || '/'
const DEFAULT_SERVER: ServerConfig = {
  host: '127.0.0.1',
  port: 8790,
  passwordHash: '',
  sessionTtlHours: 72,
  title: 'Areco',
  allowedHosts: [],
  maxSessions: 0,
  insecureNoAuth: false,
  fileRoots: [path.join(HOME, 'Desktop'), path.join(HOME, 'Downloads'), '/tmp'],
  fileRootsUnrestricted: false,
}

// 服务必须从仓库根运行（npm scripts / start.sh 保证）；可用 ARECO_ROOT 覆盖（旧名 AGENT_REMOTE_ROOT 兼容）
export const ROOT_DIR = process.env.ARECO_ROOT || process.env.AGENT_REMOTE_ROOT || process.cwd()
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const CONFIG_PATH = path.join(ROOT_DIR, 'config.json')

/**
 * 包内资源探测。ARECO_ROOT 只指数据根，不是代码根——npm 安装（尤其 -g）时 cwd 是用户
 * 任意目录，代码资源（dist/client、config.example.json、scripts/areco-msg.mjs）都在包目录。
 * 候选顺序：ROOT_DIR（仓库根跑 = 老行为不变）→ 进程入口推 bundle 布局（dist/server→包根）
 * → dev 布局（packages/server/src→仓库根），取第一个存在的；全不存在返回首个候选。
 */
/** 进程入口真实目录：npm bin 软链（.bin/areco → dist/server/index.cjs）下 argv[1] 是
 *  链接位置，必须 realpath 才能推出真实包布局（2026-07-23 外机冒烟实测踩中） */
export const ENTRY_DIR = (() => {
  let entryFile = process.argv[1] ?? ''
  try {
    entryFile = fs.realpathSync(entryFile)
  } catch {
    /* argv[1] 缺失或不可达：按原值推 */
  }
  return path.dirname(entryFile)
})()

function nearEntry(...segments: string[]): string {
  const candidates = [
    path.join(ROOT_DIR, ...segments),
    path.resolve(ENTRY_DIR, '..', '..', ...segments),
    path.resolve(ENTRY_DIR, '..', '..', '..', ...segments),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!
}

/** 回执 CLI（scripts/areco-msg.mjs）的绝对路径 */
export const MSG_CLI_PATH = nearEntry('scripts', 'areco-msg.mjs')

/** 前端构建产物目录（npm 安装时在包内，不在数据根） */
export const CLIENT_DIR = nearEntry('dist', 'client')

/** 语音转写 python 脚本（scripts/voice-transcribe.py）的绝对路径 */
export const VOICE_SCRIPT_PATH = nearEntry('scripts', 'voice-transcribe.py')

function normalizeTemplate(raw: Partial<Template>, index: number): Template {
  return {
    id: String(raw.id || `tpl-${index}`),
    name: String(raw.name || raw.id || `模板 ${index}`),
    command: String(raw.command || ''),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    cwd: String(raw.cwd || process.env.HOME || '/'),
    color: String(raw.color || '#7d8590'),
    autoStart: Boolean(raw.autoStart),
    enabled: raw.enabled !== false,
    // 白名单拷贝务必带上 claudeHome——漏掉它 = 重启剥字段 + 下次保存回写永久丢失
    // （2026-07-17 c5 模板 claudeHome 无声失效即此因）
    ...(typeof raw.claudeHome === 'string' && raw.claudeHome.trim() ? { claudeHome: raw.claudeHome.trim() } : {}),
  }
}

const DEFAULT_VOICE: VoiceConfig = { engine: 'funasr', python: 'python3' }
const VOICE_ENGINES = ['funasr', 'sensevoice', 'aliyun', 'whisper'] as const

function normalizeVoice(raw: Partial<VoiceConfig> | undefined): VoiceConfig {
  const voice: VoiceConfig = { ...DEFAULT_VOICE }
  if (!raw) return voice
  if (typeof raw.engine === 'string' && (VOICE_ENGINES as readonly string[]).includes(raw.engine)) {
    voice.engine = raw.engine as VoiceConfig['engine']
  }
  if (typeof raw.python === 'string' && raw.python.trim()) voice.python = raw.python.trim()
  // 空串不写——"清空 key" 即不出现该字段
  if (typeof raw.aliyunApiKey === 'string' && raw.aliyunApiKey.trim()) voice.aliyunApiKey = raw.aliyunApiKey.trim()
  return voice
}

export function loadConfig(): AppConfig {
  let raw: Partial<AppConfig> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<AppConfig>
    } catch (err) {
      // 损坏的 config 不能让进程带病活着（rejected promise 只记日志、永不 listen = 僵尸），与安全闸同风格直接退出
      log.error(
        `拒绝启动：config.json 解析失败（${CONFIG_PATH}）：${err instanceof Error ? err.message : String(err)}\n` +
          `  请修复 JSON 语法后重启；或删除该文件，将按安全默认值重新生成`
      )
      process.exit(1)
    }
  } else {
    // 首跑找 example：仓库根没有（npm 安装场景）就到包内找，保证外机首跑有一套通用模板
    const examplePath = nearEntry('config.example.json')
    if (fs.existsSync(examplePath)) {
      raw = JSON.parse(fs.readFileSync(examplePath, 'utf8')) as Partial<AppConfig>
      // 首次生成：默认只绑 loopback（安全默认值），要对外需自行改 host + 设密码
      raw.server = { ...(raw.server as ServerConfig), host: '127.0.0.1' }
    }
    log.warn(`config.json 不存在，按安全默认值生成（host=127.0.0.1）`)
  }

  const rawServer = (raw.server ?? {}) as Partial<ServerConfig>
  const config: AppConfig = {
    server: {
      ...DEFAULT_SERVER,
      ...rawServer,
      // fileRoots 缺省时用默认；显式给了（含空数组=主动关闭）则尊重
      fileRoots: Array.isArray(rawServer.fileRoots) ? rawServer.fileRoots.map(String) : DEFAULT_SERVER.fileRoots,
    },
    templates: (raw.templates ?? []).map(normalizeTemplate),
    ...(typeof raw.humanName === 'string' && raw.humanName.trim() ? { humanName: raw.humanName.trim() } : {}),
    ...(Array.isArray(raw.humanRelayAgents)
      ? { humanRelayAgents: raw.humanRelayAgents.map(String).filter((s) => s.trim()) }
      : {}),
    voice: normalizeVoice(raw.voice),
  }
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(config)
  return config
}

export function saveConfig(config: AppConfig) {
  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, CONFIG_PATH)
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

// 安全闸：非 loopback 绑定必须已设密码，否则拒绝启动（旧版"免密开 0.0.0.0"教训）。
// 唯一豁免：config 显式写明 insecureNoAuth: true（自担风险）。
export function enforceSecurityGate(config: AppConfig) {
  if (!isLoopbackHost(config.server.host) && !config.server.passwordHash.trim()) {
    if (config.server.insecureNoAuth) {
      log.warn(
        `⚠️ 免密模式（insecureNoAuth）：${config.server.host}:${config.server.port} 对网络内所有设备完全开放，` +
          `任何能连到本机的设备都可获得等同本机 shell 的控制权。仅限完全可信的网络。`
      )
      return
    }
    log.error(
      `拒绝启动：server.host=${config.server.host}（非 loopback）但未设置访问密码。\n` +
        `  设置密码：npm run hash -- "你的密码" --save\n` +
        `  或仅本机访问：把 config.json 的 server.host 改为 127.0.0.1\n` +
        `  或显式免密（自担风险）：config.json 的 server.insecureNoAuth 改为 true`
    )
    process.exit(1)
  }
}
