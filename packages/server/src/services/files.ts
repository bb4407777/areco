// 文件预览服务：白名单内本地产物的 realpath 校验、mime 判定、docx→PDF 现转（带缓存）。
// 安全边界：所有对外路径必须 realpath 后落在 config.fileRoots 之一内，挡目录穿越与软链逃逸。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { DATA_DIR } from '../config'
import { createLogger } from '../logger'
import type { FileMeta, PreviewKind } from '../../../shared/protocol'

const log = createLogger('files')

// 预览大小闸：直传 100MB 上限；现转文档 30MB 上限（soffice 转大文件既慢又吃内存）
const MAX_RAW_BYTES = 100 * 1024 * 1024
const MAX_CONVERT_BYTES = 30 * 1024 * 1024
const PREVIEW_CACHE = path.join(DATA_DIR, 'preview-cache')

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
}

// soffice 可转 PDF 的办公文档
const CONVERTIBLE = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.rtf'])

// soffice 二进制绝对路径候选：服务可能在最小 PATH 环境下启动（start.sh/launchd），裸命令名会 ENOENT
const SOFFICE_CANDIDATES = [
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
]
let sofficeResolved: string | null | undefined
function sofficeBin(): string | null {
  if (sofficeResolved === undefined)
    sofficeResolved = SOFFICE_CANDIDATES.find((p) => fs.existsSync(p)) ?? null
  return sofficeResolved
}
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic'])
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const TEXT = new Set(['.txt', '.md', '.json', '.csv', '.log', '.xml', '.yaml', '.yml'])

function previewKindFor(ext: string): PreviewKind {
  if (ext === '.pdf') return 'pdf'
  if (IMAGE.has(ext)) return 'image'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (TEXT.has(ext)) return 'text'
  if (VIDEO.has(ext)) return 'video'
  if (CONVERTIBLE.has(ext)) return 'convert-pdf'
  return 'download'
}

export class FileService {
  constructor(
    private roots: () => string[],
    private unrestricted: () => boolean = () => false
  ) {}

  /** 白名单根 realpath 化（根本身可能是软链，如 macOS /tmp → /private/tmp）；不存在的根忽略 */
  private resolvedRoots(): string[] {
    const out: string[] = []
    for (const r of this.roots()) {
      try {
        out.push(fs.realpathSync(r))
      } catch {
        /* 根不存在则跳过 */
      }
    }
    return out
  }

  /**
   * 把请求路径解析为受信任的真实路径。抛错即拒绝。
   * 关键：先展开 ~，再对「真实存在的文件」取 realpath（含软链目标），
   * 用 realpath 结果与各白名单根做前缀比较——软链指向根外一律落空。
   * config.server.fileRootsUnrestricted = true 时跳过白名单（自担风险，仅限单人完全可信场景）。
   */
  private resolveExisting(input: string, expected: 'file' | 'directory'): string {
    if (!input || typeof input !== 'string') throw new Error('路径不能为空')
    let p = input.trim()
    if (p.startsWith('~/') || p === '~') p = path.join(os.homedir(), p.slice(1))
    if (!path.isAbsolute(p)) throw new Error('必须是绝对路径')

    let real: string
    try {
      real = fs.realpathSync(p)
    } catch {
      throw new Error('文件不存在')
    }

    if (!this.unrestricted()) {
      const roots = this.resolvedRoots()
      if (roots.length === 0) throw new Error('文件预览未启用')
      const inRoot = roots.some((root) => real === root || real.startsWith(root + path.sep))
      if (!inRoot) throw new Error('路径不在允许范围内')
    }

    const st = fs.statSync(real)
    if (expected === 'file' && !st.isFile()) throw new Error('不是文件')
    if (expected === 'directory' && !st.isDirectory()) throw new Error('不是目录')
    return real
  }

  resolve(input: string): string {
    return this.resolveExisting(input, 'file')
  }

  /** 项目 Files 绑定目录时复用同一套 realpath + fileRoots 安全边界。 */
  resolveDirectory(input: string): string {
    return this.resolveExisting(input, 'directory')
  }

  meta(input: string): FileMeta {
    const real = this.resolve(input)
    const st = fs.statSync(real)
    const ext = path.extname(real).toLowerCase()
    return {
      path: real,
      name: path.basename(real),
      size: st.size,
      mimeType: MIME[ext] || 'application/octet-stream',
      ext,
      preview: previewKindFor(ext),
      mtimeMs: st.mtimeMs,
    }
  }

  mimeFor(ext: string): string {
    return MIME[ext.toLowerCase()] || 'application/octet-stream'
  }

  maxRawBytes = MAX_RAW_BYTES

  /**
   * 把办公文档现转为 PDF，结果按 (真实路径 + mtime + size) 哈希缓存。
   * 并发保护：转到唯一临时目录再原子改名进缓存，避免两个请求踩同一输出文件。
   */
  async toPdf(input: string): Promise<string> {
    const real = this.resolve(input)
    const ext = path.extname(real).toLowerCase()
    if (!CONVERTIBLE.has(ext)) throw new Error('该类型不支持转 PDF')
    const st = fs.statSync(real)
    if (st.size > MAX_CONVERT_BYTES) throw new Error('文件过大，无法在线预览（请下载查看）')

    const key = crypto.createHash('sha1').update(`${real}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16)
    const cached = path.join(PREVIEW_CACHE, `${key}.pdf`)
    if (fs.existsSync(cached)) return cached

    fs.mkdirSync(PREVIEW_CACHE, { recursive: true })
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-soffice-'))
    try {
      await this.runSoffice(real, workdir)
      const produced = fs
        .readdirSync(workdir)
        .find((f) => f.toLowerCase().endsWith('.pdf'))
      if (!produced) throw new Error('转换失败：未生成 PDF')
      // 原子落缓存：先在缓存目录内落临时名再改名（同分区 rename 原子）。
      // 临时名带随机后缀：并发同文件请求若都用同一 tmp 名，A 改名成功后 B 的 renameSync 会 ENOENT
      const tmpOut = path.join(PREVIEW_CACHE, `.${key}.${process.pid}.${crypto.randomUUID()}.tmp.pdf`)
      fs.copyFileSync(path.join(workdir, produced), tmpOut)
      fs.renameSync(tmpOut, cached)
      return cached
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true })
    }
  }

  private runSoffice(srcFile: string, outDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const bin = sofficeBin()
      if (!bin) {
        reject(new Error('未安装 LibreOffice（soffice），无法转换文档'))
        return
      }
      // 独立 user profile，避免与桌面正在跑的 soffice 抢锁
      const profile = `-env:UserInstallation=file://${path.join(outDir, 'profile')}`
      execFile(
        bin,
        ['--headless', profile, '--convert-to', 'pdf', '--outdir', outDir, srcFile],
        { timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) {
            log.warn(`soffice 转换失败: ${srcFile} — ${stderr || err.message}`)
            reject(new Error('文档转换失败（soffice）'))
            return
          }
          resolve()
        }
      )
    })
  }
}
