export interface Bucket {
  name: string
  description: string
}

export interface StoredObject {
  key: string
  size: number
  etag: string
  uploaded: string
  contentType: string
  metadata: Record<string, string>
}

export interface SessionState {
  authenticated: boolean
  configured?: boolean
  setupRequired?: boolean
  setupTokenRequired?: boolean
  adminPath?: string | null
  displayName?: string | null
  local?: boolean
}

export interface Listing {
  objects: StoredObject[]
  folders: string[]
  cursor: string | null
  truncated: boolean
  prefix: string
}

export interface BucketStatsPage {
  objectCount: number
  totalBytes: number
  cursor: string | null
  truncated: boolean
}

export class StorageError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter: number | null = null) { super(message) }
}

export async function api<T>(path: string, init: RequestInit = {}, onResponse?: (response: Response) => void): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('X-Mono-Client', 'web')
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (!response.ok) {
    let code = 'REQUEST_FAILED'
    let message = `请求失败（${response.status}）`
    try {
      const body = await response.json()
      code = body.error?.code || code
      message = body.error?.message || message
    } catch { }
    if (response.status === 401) window.dispatchEvent(new Event('mono:unauthorized'))
    const delay = Number(response.headers.get('Retry-After'))
    const retryAfter = Number.isSafeInteger(delay) && delay > 0 ? delay : null
    throw new StorageError(response.status, code, message, retryAfter)
  }
  onResponse?.(response)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
