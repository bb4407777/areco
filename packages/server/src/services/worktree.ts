// git 工作区助手（认领制阶段二）：赢家获批后为 dispatch 开独立 worktree + 分支。
// 全部走 execFileSync 参数数组传参（不拼 shell 字符串，防路径/分支名注入）；
// 所有函数只动 areco 自己建的工作区（dispatch.worktree_path 记档为准），绝不碰用户主检出的分支与工作区。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** git 调用统一入口：返回 stdout；失败抛错（stderr 并进 message 供 note 如实呈现） */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string }
    const stderr = e.stderr ? String(e.stderr).trim() : ''
    throw new Error(stderr || e.message || 'git 调用失败')
  }
}

/** 净化成 git 目录/分支可用的 slug：小写、非 [a-z0-9] 折叠成单 '-'、去首尾 '-'、截断。
 *  中文等非 ASCII 会整体净化为空——调用方必须给 fallback（如 d<dispatchId> / m<deliveryId>）。 */
export function slugify(text: string, fallback: string, max = 24): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s || fallback
}

/** 校验路径是 git 仓（git rev-parse 成功）；绑定房间 repo 时用 */
export function isGitRepo(repoPath: string): boolean {
  try {
    git(['-C', repoPath, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

/** 工作区目录约定：repo 同级 <repo父目录>/<repo名>-wt/<slug>（不污染 repo 内部，多任务平铺） */
export function worktreeDirFor(repoPath: string, slug: string): string {
  const repo = path.resolve(repoPath)
  return path.join(path.dirname(repo), `${path.basename(repo)}-wt`, slug)
}

/**
 * 幂等开工作区：git worktree add <dir> -b <branch> HEAD。
 * 同一 dispatch 重复触发不报错——目录已存在且确是 worktree 直接复用；
 * 目录不在但分支已在（上次建了一半/手动清过目录）则不复用 -b，改为基于既有分支 add。
 * 返回工作区绝对路径；失败抛错（调用方记日志并在 note 里如实说明，不阻断放行）。
 */
export function ensureWorktree(repoPath: string, dir: string, branch: string): string {
  if (fs.existsSync(dir)) {
    git(['-C', dir, 'rev-parse', '--git-dir']) // 目录已存在但非法（非 worktree）时在这里抛错
    return dir
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const branchExists = git(['-C', repoPath, 'branch', '--list', branch]).length > 0
  if (branchExists) git(['-C', repoPath, 'worktree', 'add', dir, branch])
  else git(['-C', repoPath, 'worktree', 'add', dir, '-b', branch, 'HEAD'])
  return dir
}

export interface MergeCheckResult {
  clean: boolean
  conflicts: string[]
  message: string
}

/**
 * 合并干跑预检：git merge-tree --write-tree --name-only HEAD <branch>（需要 git ≥ 2.38）。
 * 只写不可达的 tree 对象到 object db，不动任何工作区/分支/索引——符合「干跑不改现场」。
 * 退出码 0=可干净合并；1=有冲突（--name-only 输出冲突文件名）；其它=命令本身失败。
 */
export function mergeCheck(repoPath: string, branch: string): MergeCheckResult {
  let out: string
  let code = 0
  try {
    out = execFileSync('git', ['-C', repoPath, 'merge-tree', '--write-tree', '--name-only', 'HEAD', branch], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    if (typeof e.status === 'number' && e.status === 1) {
      out = String(e.stdout ?? '')
      code = 1
    } else {
      const stderr = e.stderr ? String(e.stderr).trim() : ''
      return { clean: false, conflicts: [], message: `预检失败：${stderr || e.message || 'merge-tree 不可用（需 git ≥ 2.38）'}` }
    }
  }
  if (code === 0) return { clean: true, conflicts: [], message: '可干净合并' }
  // 输出首行是合并结果 tree 的 OID，其后每行一个冲突文件名（--name-only）
  const conflicts = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
  return { clean: false, conflicts, message: `有 ${conflicts.length} 个文件冲突` }
}

/**
 * 会话退出兜底提交：工作区有未提交改动（status --porcelain 非空）才 add -A + commit。
 * 返回 true=产生了兜底 commit；false=工作区干净无需提交。失败抛错由调用方记日志吞掉。
 */
export function wipCommit(worktreePath: string, message: string): boolean {
  if (!git(['-C', worktreePath, 'status', '--porcelain'])) return false
  git(['-C', worktreePath, 'add', '-A'])
  git(['-C', worktreePath, 'commit', '-m', message])
  return true
}
