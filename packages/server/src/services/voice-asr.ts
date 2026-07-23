// 语音转写服务：把一段 16kHz wav 转成文字。
//   - funasr / sensevoice / whisper → spawn scripts/voice-transcribe.py（本地推理）
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
const TIMEOUT_MS = 45_000 // funasr 首次加载模型 + 推理，给足

/**
 * spawn python 脚本转写。stdout 最后一行 JSON = {text, engine, error?}。
 * 脚本即便异常也会吐 JSON（带 error），这里按 error 字段判成败，拿不到 JSON 才兜底用 stderr。
 */
export function spawnPythonTranscribe(
  engine: 'paraformer' | 'sensevoice' | 'whisper',
  wavPath: string,
  hotwords: string,
  python = 'python3',
): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    if (!VOICE_SCRIPT_PATH || !fs.existsSync(VOICE_SCRIPT_PATH)) {
      reject(new Error(`语音转写脚本不存在：${VOICE_SCRIPT_PATH}（areco 包内缺失 scripts/voice-transcribe.py）`))
      return
    }
    // 路径/热词全走 argv，不拼 shell 字符串（同 worktree.ts 防注入口径）
    const args = [VOICE_SCRIPT_PATH, '--engine', engine, '--audio', wavPath]
    if (hotwords) args.push('--hotwords', hotwords)
    log.info(`spawn ${python} voice-transcribe --engine ${engine}`)
    const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      reject(new Error(`语音转写超时（${TIMEOUT_MS / 1000}s）——首次加载模型较慢，重试一次通常即好`))
    }, TIMEOUT_MS)

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动 python（${python}）：${err.message}。可在 config.json voice.python 指定装了 funasr 的解释器`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 取 stdout 最后一行非空 JSON（脚本保证最后吐一行结果）
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
      const last = lines[lines.length - 1]
      if (last) {
        try {
          const parsed = JSON.parse(last) as { text?: unknown; engine?: unknown; error?: unknown }
          if (parsed.error) {
            reject(new Error(String(parsed.error)))
            return
          }
          resolve({ text: String(parsed.text ?? '').trim(), engine: String(parsed.engine ?? engine) })
          return
        } catch {
          /* JSON 解析失败，落到下面 stderr 兜底 */
        }
      }
      reject(new Error(`语音转写失败（退出码 ${code}）：${(stderr || stdout).slice(-300) || '无输出'}`))
    })
  })
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
  return spawnPythonTranscribe(pyEngine as 'paraformer' | 'sensevoice' | 'whisper', wavPath, opts.hotwords ?? '', opts.python)
}
