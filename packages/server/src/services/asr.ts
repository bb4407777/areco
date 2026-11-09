import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { VOICE_DIR } from '../config'
import { createLogger } from '../logger'

const log = createLogger('asr')

export interface AsrServiceOptions {
  voiceDir?: string
  python?: string
  port?: number
  startSidecar?: boolean
  fetchImpl?: typeof fetch
}

/** 语音输入 sidecar（豆包流式 ASR + Silero VAD），懒启动；只管理本类创建的子进程。 */
export class AsrService {
  private readonly voiceDir: string
  private readonly python?: string
  private readonly port: number
  private readonly autoStart: boolean
  private readonly fetchImpl: typeof fetch
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null

  constructor(options: AsrServiceOptions = {}) {
    this.voiceDir = options.voiceDir ?? VOICE_DIR
    this.python = options.python
    this.port = options.port ?? Number(process.env.ARECO_ASR_PORT || 8794)
    this.autoStart = options.startSidecar !== false
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get address(): string {
    return `127.0.0.1:${this.port}`
  }

  async ensureStarted(): Promise<void> {
    if (!this.autoStart) return
    if (await this.healthy()) return
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async healthy(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/healthz`, {
        signal: AbortSignal.timeout(800),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { service?: unknown }
      return body.service === 'areco-asr'
    } catch {
      return false
    }
  }

  private async start(): Promise<void> {
    const venvPython = path.join(this.voiceDir, '.venv', 'bin', 'python')
    const python = this.python || process.env.ARECO_ASR_PYTHON || (fs.existsSync(venvPython) ? venvPython : 'python3')
    const configPath = path.join(this.voiceDir, 'config.json')
    const child = spawn(python, ['-u', '-m', 'voice.server.asr_ws', '--port', String(this.port), '--config', configPath], {
      cwd: path.dirname(this.voiceDir),
      env: {
        ...process.env,
        ARECO_ASR_PORT: String(this.port),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    this.child = child
    child.once('error', (err) => log.error('ASR sidecar 启动失败', err))
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })

    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      if (await this.healthy()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill('SIGTERM')
    throw new Error(`ASR sidecar 未就绪（127.0.0.1:${this.port}）；请安装 voice/requirements.txt`)
  }

  stop() {
    this.child?.kill('SIGTERM')
    this.child = null
  }
}
