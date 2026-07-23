// REST 封装：统一 {ok,data|error} 解包；401 → 整页跳登录（cookie 由服务端管理）
import type { ApiResult } from '../../shared/protocol'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent('/')}`
    throw new Error('需要登录')
  }
  let parsed: ApiResult<T>
  try {
    parsed = (await res.json()) as ApiResult<T>
  } catch {
    throw new Error(`响应异常（HTTP ${res.status}）`)
  }
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.data
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}
