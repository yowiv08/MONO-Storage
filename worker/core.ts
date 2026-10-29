export const SIMPLE_UPLOAD_LIMIT = 90 * 1024 * 1024
export const PART_SIZE = 10 * 1024 * 1024
export const MAX_OBJECT_SIZE = 5 * 1024 * 1024 * 1024 * 1024
export const FOLDER_CONTENT_TYPE = 'application/x-mono-directory'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function normalizeAdminPath(value: unknown): string {
  if (value === undefined || value === null || value === '') return '/admin'
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_ADMIN_PATH', '后台路径必须是以 / 开头的路径。')
  const path = value.trim().replace(/\/+$/, '')
  if (!/^\/[a-zA-Z0-9][a-zA-Z0-9/_-]{0,63}$/.test(path) || path.split('/').slice(1).some(segment => !segment) || /^\/(api|assets|s)(\/|$)/i.test(path)) {
    throw new ApiError(400, 'INVALID_ADMIN_PATH', '后台路径只能包含字母、数字、/、_ 和 -，且不能使用 /api、/assets 或 /s。')
  }
  return path
}

export function objectKey(value: unknown, options: { folder?: boolean } = {}): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 1024) {
    throw new ApiError(400, 'INVALID_KEY', '对象路径不能为空，且不能超过 1024 字节。')
  }
  if (value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, 'INVALID_KEY', '对象路径不能以 / 开头，也不能包含控制字符。')
  }
  if (options.folder && !value.endsWith('/')) {
    throw new ApiError(400, 'INVALID_KEY', '文件夹路径必须以 / 结尾。')
  }
  if (!options.folder && value.endsWith('/')) {
    throw new ApiError(400, 'INVALID_KEY', '文件路径不能以 / 结尾。')
  }
  const segments = value.replace(/\/$/, '').split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ApiError(400, 'INVALID_KEY', '对象路径不能包含空目录、. 或 ..。')
  }
  return value
}

export function prefixValue(value: string | null): string {
  if (!value) return ''
  if (value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > 1024) {
    throw new ApiError(400, 'INVALID_PREFIX', '无效的目录或搜索前缀。')
  }
  const segments = value.replace(/\/$/, '').split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ApiError(400, 'INVALID_PREFIX', '无效的目录或搜索前缀。')
  }
  return value
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(400, 'INVALID_PARAMETER', `参数必须是 ${min} 到 ${max} 之间的整数。`)
  }
  return number
}

export function downloadDisposition(key: string): string {
  const name = key.split('/').pop() || 'download'
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export type ResolvedRange = { offset: number; length: number }

export function resolveRange(value: string | null, size: number): ResolvedRange | undefined {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || size === 0) {
    throw new ApiError(416, 'INVALID_RANGE', '请求的文件范围无效。')
  }
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new ApiError(416, 'INVALID_RANGE', '请求的文件范围无效。')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw new ApiError(416, 'INVALID_RANGE', '请求的文件范围无效。')
    }
  }
  return { offset: start, length: end - start + 1 }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid encoding')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signPayload(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body))
  return `${body}.${base64url(new Uint8Array(signature))}`
}

export async function verifyPayload(token: string, secret: string, purpose: string): Promise<Record<string, unknown> | null> {
  try {
    if (token.length > 6000) return null
    const [body, signature, extra] = token.split('.')
    if (!body || !signature || extra) return null
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(signature), new TextEncoder().encode(body))
    if (!valid) return null
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)))
    if (!payload || payload.purpose !== purpose || typeof payload.exp !== 'number' || payload.exp <= Date.now() / 1000) return null
    return payload
  } catch {
    return null
  }
}

export async function equalSecrets(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(a)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(b)),
  ])
  const x = new Uint8Array(left)
  const y = new Uint8Array(right)
  let different = 0
  for (let index = 0; index < x.length; index++) different |= x[index] ^ y[index]
  return different === 0
}

export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}
