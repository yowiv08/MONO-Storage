import { normalizeLoginRateLimit, LOGIN_RATE_LIMIT_MAX_WINDOW_SECONDS, type LoginRateLimit } from '../shared/login-rate-limit.ts'
import { ApiError, hashSecret } from './core.ts'

const INTERNAL_URL = 'https://login-rate-limit.internal/check'
const BODY_LIMIT = 1024
const UNAVAILABLE_MESSAGE = '暂时无法处理此请求，请稍后再试。'
const RETENTION_MILLISECONDS = LOGIN_RATE_LIMIT_MAX_WINDOW_SECONDS * 1000

type LimitRequest = { policy: LoginRateLimit; version: number; consume: boolean }
type LimitDecision = { allowed: boolean; retryAfter: number }
type PolicyRow = { version: number; max_attempts: number; window_seconds: number }

export class LoginRateLimitError extends ApiError {
  retryAfter: number
  constructor(status: 429 | 503, code: string, message: string, retryAfter: number) {
    super(status, code, message)
    this.name = 'LoginRateLimitError'
    this.retryAfter = retryAfter
  }
}

function unavailable(): LoginRateLimitError {
  return new LoginRateLimitError(503, 'AUTH_RATE_LIMIT_UNAVAILABLE', UNAVAILABLE_MESSAGE, 60)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function smallJson(message: Request | Response): Promise<unknown> {
  const contentLength = message.headers.get('Content-Length')
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > BODY_LIMIT)) throw unavailable()
  if (!message.body) throw unavailable()
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > BODY_LIMIT) {
        await reader.cancel().catch(() => undefined)
        throw unavailable()
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
}

function limitRequest(value: unknown): LimitRequest {
  if (!record(value)) throw unavailable()
  const fields = Object.keys(value)
  if (fields.length < 2 || fields.length > 3 || fields.some(field => !['policy', 'version', 'consume'].includes(field)) || !Object.hasOwn(value, 'policy') || !Object.hasOwn(value, 'version') || value.policy === undefined || !validVersion(value.version) || Object.hasOwn(value, 'consume') && typeof value.consume !== 'boolean') throw unavailable()
  return { policy: normalizeLoginRateLimit(value.policy), version: value.version, consume: Object.hasOwn(value, 'consume') ? value.consume as boolean : true }
}

function normalizedIp(value: string | null): string | null {
  if (!value || value.length > 45 || value !== value.trim()) return null
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const parts = value.split('.').map(Number)
    return parts.every(part => part <= 255) ? parts.join('.') : null
  }
  if (!value.includes(':') || !/^[a-fA-F0-9:.]+$/.test(value)) return null
  try {
    const host = new URL(`http://[${value}]/`).hostname
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1).toLowerCase() : null
  } catch { return null }
}

function requestActor(request: Request, local: boolean): string {
  if (local) return 'local'
  const runtime = request.cf as { colo?: unknown } | undefined
  if (!runtime || typeof runtime.colo !== 'string' || !/^[a-zA-Z0-9]{3,16}$/.test(runtime.colo)) return 'unknown'
  return normalizedIp(request.headers.get('CF-Connecting-IP')) || 'unknown'
}

export async function enforceLoginRateLimit(
  request: Request,
  namespace: DurableObjectNamespace | undefined,
  policy: LoginRateLimit,
  version: number,
  purpose: 'login' | 'setup',
  local: boolean,
  consume = true,
): Promise<void> {
  try {
    if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function' || !validVersion(version) || !['login', 'setup'].includes(purpose) || typeof consume !== 'boolean') throw unavailable()
    const body = { policy: normalizeLoginRateLimit(policy), version, consume }
    const actor = await hashSecret(`${purpose}\n${requestActor(request, local)}`)
    const stub = namespace.get(namespace.idFromName(`${purpose}:${actor}`))
    const response = await stub.fetch(new Request(INTERNAL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
    if (response.status !== 200) throw unavailable()
    const decision = await smallJson(response)
    if (!record(decision) || Object.keys(decision).length !== 2 || typeof decision.allowed !== 'boolean' || typeof decision.retryAfter !== 'number' || !Number.isSafeInteger(decision.retryAfter) ||
      (decision.allowed ? decision.retryAfter !== 0 : decision.retryAfter < 1 || decision.retryAfter > LOGIN_RATE_LIMIT_MAX_WINDOW_SECONDS)) throw unavailable()
    if (!decision.allowed) throw new LoginRateLimitError(429, 'LOGIN_RATE_LIMITED', '尝试过于频繁，请稍后再试。', decision.retryAfter)
  } catch (error) {
    if (error instanceof LoginRateLimitError) throw error
    throw unavailable()
  }
}

export class LoginRateLimiter {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
    state.storage.transactionSync(() => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS login_rate_limit_policy (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 0),
          max_attempts INTEGER NOT NULL CHECK (typeof(max_attempts) = 'integer' AND max_attempts BETWEEN 1 AND 100),
          window_seconds INTEGER NOT NULL CHECK (typeof(window_seconds) = 'integer' AND window_seconds BETWEEN 10 AND 3600)
        );
        CREATE TABLE IF NOT EXISTS login_rate_limit_attempts (
          id INTEGER PRIMARY KEY,
          accepted_at INTEGER NOT NULL CHECK (typeof(accepted_at) = 'integer' AND accepted_at >= 0)
        );
        CREATE INDEX IF NOT EXISTS login_rate_limit_attempts_time ON login_rate_limit_attempts(accepted_at);
      `)
    })
  }

  private storedPolicy(incoming: LimitRequest): LoginRateLimit {
    const rows = this.state.storage.sql.exec<PolicyRow>('SELECT version, max_attempts, window_seconds FROM login_rate_limit_policy WHERE id = 1').toArray()
    if (rows.length > 1) throw unavailable()
    const previous = rows[0]
    if (previous) {
      if (!validVersion(previous.version)) throw unavailable()
      const policy = normalizeLoginRateLimit({ maxAttempts: previous.max_attempts, windowSeconds: previous.window_seconds })
      if (incoming.version < previous.version) return policy
      if (incoming.version === previous.version) {
        if (policy.maxAttempts !== incoming.policy.maxAttempts || policy.windowSeconds !== incoming.policy.windowSeconds) throw unavailable()
        return policy
      }
    } else {
      const count = this.state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').one().count
      if (count !== 0) throw unavailable()
    }
    this.state.storage.sql.exec('INSERT OR REPLACE INTO login_rate_limit_policy (id, version, max_attempts, window_seconds) VALUES (1, ?, ?, ?)', incoming.version, incoming.policy.maxAttempts, incoming.policy.windowSeconds)
    return incoming.policy
  }

  private cleanupTime(): number | null {
    const oldest = this.state.storage.sql.exec<{ oldest: number | null }>('SELECT MIN(accepted_at) AS oldest FROM login_rate_limit_attempts').one().oldest
    if (oldest === null) return null
    if (!validVersion(oldest) || !Number.isSafeInteger(oldest + RETENTION_MILLISECONDS)) throw unavailable()
    return oldest + RETENTION_MILLISECONDS
  }

  private decide(incoming: LimitRequest): LimitDecision & { cleanupAt: number | null } {
    return this.state.storage.transactionSync(() => {
      const policy = this.storedPolicy(incoming)
      const latest = this.state.storage.sql.exec<{ latest: number | null }>('SELECT MAX(accepted_at) AS latest FROM login_rate_limit_attempts').one().latest
      if (latest !== null && !validVersion(latest)) throw unavailable()
      const clock = Date.now()
      if (!validVersion(clock)) throw unavailable()
      const now = Math.max(clock, latest ?? 0)
      this.state.storage.sql.exec('DELETE FROM login_rate_limit_attempts WHERE accepted_at <= ?', now - RETENTION_MILLISECONDS)
      const cutoff = now - policy.windowSeconds * 1000
      const count = this.state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM login_rate_limit_attempts WHERE accepted_at > ?', cutoff).one().count
      if (!validVersion(count)) throw unavailable()
      if (count >= policy.maxAttempts) {
        // A reduced limit may require several accepted attempts to expire before another is allowed.
        const timestamp = this.state.storage.sql.exec<{ accepted_at: number }>('SELECT accepted_at FROM login_rate_limit_attempts WHERE accepted_at > ? ORDER BY accepted_at, id LIMIT 1 OFFSET ?', cutoff, count - policy.maxAttempts).one().accepted_at
        if (!validVersion(timestamp)) throw unavailable()
        const retryAfter = Math.max(1, Math.ceil((timestamp + policy.windowSeconds * 1000 - now) / 1000))
        if (retryAfter > LOGIN_RATE_LIMIT_MAX_WINDOW_SECONDS) throw unavailable()
        return { allowed: false, retryAfter, cleanupAt: null }
      }
      if (!incoming.consume) return { allowed: true, retryAfter: 0, cleanupAt: null }
      this.state.storage.sql.exec('INSERT INTO login_rate_limit_attempts (accepted_at) VALUES (?)', now)
      return { allowed: true, retryAfter: 0, cleanupAt: this.cleanupTime() }
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST' || request.url !== INTERNAL_URL || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) throw unavailable()
      const incoming = limitRequest(await smallJson(request))
      const { allowed, retryAfter, cleanupAt } = this.decide(incoming)
      if (cleanupAt !== null) await this.state.storage.setAlarm(cleanupAt)
      return Response.json({ allowed, retryAfter }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return Response.json({ error: { code: 'AUTH_RATE_LIMIT_UNAVAILABLE', message: UNAVAILABLE_MESSAGE } }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } })
    }
  }

  async alarm(): Promise<void> {
    const cleanupAt = this.state.storage.transactionSync(() => {
      const now = Date.now()
      if (!validVersion(now)) throw unavailable()
      this.state.storage.sql.exec('DELETE FROM login_rate_limit_attempts WHERE accepted_at <= ?', now - RETENTION_MILLISECONDS)
      return this.cleanupTime()
    })
    if (cleanupAt !== null) await this.state.storage.setAlarm(cleanupAt)
  }
}
