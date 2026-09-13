// REST 封装：统一 {ok,data|error} 解包；401 → 整页跳登录（cookie 由服务端管理）
import type { ApiResult, UiPrefs } from '../../shared/protocol'

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

// 对话模式显示开关 + 新建会话模式：服务端为 SoT（config.json 的 ui 段），localStorage 仅本地缓存。
// spawnMode 是 role/template 字符串，与布尔显示开关并存，故值类型放宽到字符串。
export const getUiPrefs = () => api.get<UiPrefs>('/api/ui/prefs')
export const putUiPrefs = (
  prefs: Partial<Record<keyof UiPrefs, boolean | null | ('role' | 'template')>>,
) => api.put<UiPrefs>('/api/ui/prefs', prefs)
