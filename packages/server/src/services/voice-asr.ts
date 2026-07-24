// 语音转写服务：把一段 16kHz wav 转成文字。
//   - funasr / sensevoice / whisper → 常驻 python worker（scripts/voice-transcribe.py --serve，
//     模型只加载一次，行 JSON 协议；崩溃自动重建，空闲 15 分钟回收）
//   - aliyun → Node 直连阿里云 dashscope paraformer-realtime-v2（搬白龙马 cloud-asr.js 协议）
//
// 由 controllers/api.ts 的 POST /api/voice/transcribe 调用：它把前端送上来的 wav 落临时盘，
// 再按引擎路由到这里。整段转写（非流式）：第一版 PTT「松开直接发送」用，松手后一次性转。
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { WebSocket } from 'ws'
import { VOICE_SCRIPT_PATH } from '../config'
import { createLogger } from '../logger'

const log = createLogger('voice-asr')

export interface TranscribeResult {
  text: string
  engine: string
}

const PYTHON_ENGINES = new Set(['paraformer', 'sensevoice', 'whisper'])
const TIMEOUT_MS = 45_000 // aliyun 用
const WORKER_TIMEOUT_MS = 60_000 // 单请求上限（含该引擎首次冷加载模型）
const WORKER_IDLE_MS = 15 * 60_000 // 空闲回收：释放模型占的内存

// ─── 常驻 python worker（脚本 --serve 模式，stdin/stdout 行 JSON）───
// 模型在 worker 内只加载一次，后续请求秒回；FIFO 串行（python 单循环天然串行）；
// 崩溃/超时杀进程，下个请求自动重建（代价是一次冷加载）；空闲 15 分钟自动回收。

interface PendingReq {
  engine: string
  resolve: (r: TranscribeResult) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

class VoiceWorker {
  private child: ReturnType<typeof spawn> | null = null
  private buf = ''
  private queue: PendingReq[] = []
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private python: string) {}

  request(engine: string, wavPath: string, hotwords: string): Promise<TranscribeResult> {
    this.ensureSpawned()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log.warn(`请求超时（${WORKER_TIMEOUT_MS / 1000}s），杀 worker 待下请求重建`)
        this.kill(new Error(`语音转写超时（${WORKER_TIMEOUT_MS / 1000}s）——模型冷加载较慢，重试一次通常即好`))
      }, WORKER_TIMEOUT_MS)
      this.queue.push({ engine, resolve, reject, timer })
      this.touch()
      try {
        this.child!.stdin!.write(JSON.stringify({ audio: wavPath, engine, hotwords }) + '\n')
      } catch (err) {
        this.kill(new Error(`语音转写进程不可写：${err instanceof Error ? err.message : String(err)}`))
      }
    })
  }

  dispose() {
    this.kill(null)
  }

  private ensureSpawned() {
    if (this.child) return
    if (!VOICE_SCRIPT_PATH || !fs.existsSync(VOICE_SCRIPT_PATH)) {
      throw new Error(`语音转写脚本不存在：${VOICE_SCRIPT_PATH}（areco 包内缺失 scripts/voice-transcribe.py）`)
    }
    log.info(`spawn 常驻 worker：${this.python} voice-transcribe --serve`)
    const child = spawn(this.python, [VOICE_SCRIPT_PATH, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout!.on('data', (d: Buffer) => this.onData(d))
    child.stderr!.on('data', (d: Buffer) => log.debug(`[py] ${d.toString().trimEnd()}`))
    child.on('error', (err) => {
      this.kill(new Error(`无法启动 python（${this.python}）：${err.message}。可在 config.json voice.python 指定装了 funasr 的解释器`))
    })
    child.on('exit', (code) => {
      if (this.child !== child) return // kill() 已处理
      this.kill(new Error(`语音转写进程意外退出（码 ${code}）`))
    })
  }

  private onData(d: Buffer) {
    this.buf += d.toString()
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line.startsWith('{')) continue // funasr 进度条等杂行
      if (line.includes('"ready"')) continue // 启动就绪行，不对应任何请求（必须在 shift 前判）
      const req = this.queue.shift()
      if (!req) continue
      clearTimeout(req.timer)
      this.touch()
      try {
        const parsed = JSON.parse(line) as { text?: unknown; engine?: unknown; error?: unknown }
        if (parsed.error) req.reject(new Error(String(parsed.error)))
        else req.resolve({ text: String(parsed.text ?? '').trim(), engine: String(parsed.engine ?? req.engine) })
      } catch {
        req.reject(new Error(`语音转写进程返回了无法解析的内容：${line.slice(-200)}`))
      }
    }
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      log.info(`空闲 ${WORKER_IDLE_MS / 60000} 分钟，回收 worker（释放模型内存）`)
      this.kill(null)
    }, WORKER_IDLE_MS)
    this.idleTimer.unref()
  }

  private kill(err: Error | null) {
    const child = this.child
    this.child = null
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    for (const req of this.queue.splice(0)) {
      clearTimeout(req.timer)
      req.reject(err ?? new Error('语音转写进程已回收，请重试'))
    }
  }
}

let worker: VoiceWorker | null = null
let workerPython = ''

function getWorker(python: string): VoiceWorker {
  if (worker && workerPython !== python) {
    worker.dispose() // python 配置变了，旧 worker 作废重建
    worker = null
  }
  if (!worker) {
    worker = new VoiceWorker(python)
    workerPython = python
  }
  return worker
}

/** 读 wav → 抽取 PCM data chunk（16kHz 16bit 单声道，areco 前端 AudioWorklet 产的即此格式）。 */
function extractPcmFromWav(wavPath: string): Buffer {
  const buf = fs.readFileSync(wavPath)
  // 标准 wav：12 字节 RIFF 头后是若干 chunk，找 'data' chunk
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('latin1')
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2) // chunk 对齐填充
  }
  return buf.subarray(44) // 回退：跳过 44 字节标准头
}

const ALIYUN_KEY_RE = /^sk-[A-Za-z0-9_\-.]{20,}$/

/**
 * 阿里云 dashscope paraformer-realtime-v2 整段识别：连 WS → run-task → 推全部 PCM → finish-task
 * → 收集所有 sentence_end 拼成全文。协议搬白龙马 src/voice/cloud-asr.js。
 */
export function aliyunRecognize(wavPath: string, apiKey?: string): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    const key = (apiKey ?? '').trim()
    if (!ALIYUN_KEY_RE.test(key)) {
      reject(new Error('阿里云 ASR 未配置有效 API Key（需 sk- 开头）。请在设置页「语音」填入 dashscope Key，或改用 FunASR 引擎'))
      return
    }
    const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
    const taskId = crypto.randomUUID()
    const pcm = extractPcmFromWav(wavPath)
    let settled = false
    let finalText = ''
    let lastInterim = '' // 句末结果缺位时的兜底（paraformer-realtime 偶有 interim 未 finalize）

    const ws = new WebSocket(WS_URL, { headers: { Authorization: `bearer ${key}` } })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error(`阿里云 ASR 超时（${TIMEOUT_MS / 1000}s）`))
    }, TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: 'paraformer-realtime-v2',
            parameters: {
              sample_rate: 16000,
              format: 'pcm',
              language_hints: ['zh'],
              punctuation_prediction: true,
              inverse_text_normalization: true,
            },
            input: {},
          },
        }),
      )
      // 分块推 PCM（~200ms/块 = 6400 字节 = 3200 样本 × 2B），推完发 finish-task
      const CHUNK = 6400
      for (let i = 0; i < pcm.length; i += CHUNK) {
        if (ws.readyState !== WebSocket.OPEN) break
        ws.send(pcm.subarray(i, i + CHUNK))
      }
      ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }))
    })
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { header?: { event?: string; error_message?: string }; payload?: { output?: { sentence?: { text?: string; status?: string } } } }
        const event = msg.header?.event
        if (event === 'result-generated') {
          const sentence = msg.payload?.output?.sentence
          if (sentence?.text) {
            if (sentence.status === 'sentence_end') finalText += sentence.text // 整段：拼句末
            else lastInterim = sentence.text // 记最新中间结果，task-finished 时兜底
          }
        } else if (event === 'task-failed') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          reject(new Error(msg.header?.error_message || '阿里云 ASR 任务失败'))
        } else if (event === 'task-finished') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          resolve({ text: (finalText || lastInterim).trim(), engine: 'aliyun' })
        }
      } catch {
        /* 单帧解析失败忽略，等后续帧 */
      }
    })
    ws.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`阿里云 ASR 连接错误：${err.message}`))
    })
  })
}

/** 按引擎名路由到具体转写实现。engine 来自前端请求或 config 默认。 */
export async function transcribe(
  engine: string,
  wavPath: string,
  opts: { hotwords?: string; python?: string; aliyunApiKey?: string },
): Promise<TranscribeResult> {
  if (engine === 'aliyun') return aliyunRecognize(wavPath, opts.aliyunApiKey)
  // 前端 'funasr' → python 'paraformer'；sensevoice/whisper 直通
  const pyEngine = engine === 'funasr' ? 'paraformer' : engine
  if (!PYTHON_ENGINES.has(pyEngine)) {
    throw new Error(`未知语音引擎：${engine}`)
  }
  return getWorker(opts.python ?? 'python3').request(pyEngine, wavPath, opts.hotwords ?? '')
}
