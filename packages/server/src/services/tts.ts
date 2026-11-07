import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { VOICE_DIR } from '../config'
import { createLogger } from '../logger'

const log = createLogger('tts')

export interface TtsServiceOptions {
  rootDir?: string
  voiceDir?: string
  python?: string
  port?: number
  startSidecar?: boolean
  fetchImpl?: typeof fetch
}

/** 懒启动 areco 自己的 sidecar；只管理本类创建的子进程。 */
export class TtsService {
  private readonly voiceDir: string
  private readonly python?: string
  private readonly port: number
  private readonly autoStart: boolean
  private readonly fetchImpl: typeof fetch
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null

  constructor(options: TtsServiceOptions = {}) {
    this.voiceDir = options.voiceDir ?? (options.rootDir ? path.join(options.rootDir, 'voice') : VOICE_DIR)
    this.python = options.python
    this.port = options.port ?? Number(process.env.ARECO_TTS_PORT || 8792)
    this.autoStart = options.startSidecar !== false
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async synthesize(text: string, req: IncomingMessage, res: ServerResponse): Promise<Readable> {
    await this.ensureStarted()
    const controller = new AbortController()
    const abort = () => controller.abort()
    const onClose = () => {
      if (!res.writableEnded) abort()
    }
    req.once('aborted', abort)
    res.once('close', onClose)
    const cleanup = () => {
      req.off('aborted', abort)
      res.off('close', onClose)
    }

    try {
      const upstream = await this.fetchImpl(`http://127.0.0.1:${this.port}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      })
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 300)
        cleanup()
        throw new Error(`TTS sidecar HTTP ${upstream.status}${detail ? `：${detail}` : ''}`)
      }
      if (!upstream.body) {
        cleanup()
        throw new Error('TTS sidecar 未返回音频流')
      }
      const stream = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>)
      stream.once('end', cleanup)
      stream.once('error', cleanup)
      stream.once('close', cleanup)
      stream.once('close', abort)
      return stream
    } catch (err) {
      cleanup()
      if (controller.signal.aborted) return Readable.from([])
      throw err
    }
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
      const body = await response.json() as { service?: unknown }
      return body.service === 'areco-tts'
    } catch {
      return false
    }
  }

  private async start(): Promise<void> {
    const venvPython = path.join(this.voiceDir, '.venv', 'bin', 'python')
    const python = this.python || process.env.ARECO_TTS_PYTHON || (fs.existsSync(venvPython) ? venvPython : 'python3')
    const configPath = path.join(this.voiceDir, 'config.json')
    const child = spawn(python, ['-u', '-m', 'voice.server.main', '--config', configPath], {
      cwd: path.dirname(this.voiceDir),
      env: {
        ...process.env,
        ARECO_TTS_CONFIG: configPath,
        ARECO_TTS_HOST: '127.0.0.1',
        ARECO_TTS_PORT: String(this.port),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    this.child = child
    child.once('error', (err) => log.error('TTS sidecar 启动失败', err))
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })

    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      if (await this.healthy()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill('SIGTERM')
    throw new Error(`TTS sidecar 未就绪（127.0.0.1:${this.port}）；请安装 voice/requirements.txt`)
  }

  stop() {
    this.child?.kill('SIGTERM')
    this.child = null
  }
}
