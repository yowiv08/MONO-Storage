export type LoginRateLimit = { maxAttempts: number; windowSeconds: number }

export const LOGIN_RATE_LIMIT_MIN_ATTEMPTS = 1
export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 100
export const LOGIN_RATE_LIMIT_MIN_WINDOW_SECONDS = 10
export const LOGIN_RATE_LIMIT_MAX_WINDOW_SECONDS = 3600

export const DEFAULT_LOGIN_RATE_LIMIT: Readonly<LoginRateLimit> = Object.freeze({ maxAttempts: 10, windowSeconds: 60 })

export function normalizeLoginRateLimit(value: unknown): LoginRateLimit {
  if (value === undefined) return { ...DEFAULT_LOGIN_RATE_LIMIT }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RangeError('登录限速配置无效。')
  const fields = Object.keys(value)
  const policy = value as Record<string, unknown>
  if (fields.length !== 2 || !fields.includes('maxAttempts') || !fields.includes('windowSeconds') ||
    typeof policy.maxAttempts !== 'number' || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < LOGIN_RATE_LIMIT_MIN_ATTEMPTS || policy.maxAttempts > LOGIN_RATE_LIMIT_MAX_ATTEMPTS ||
    typeof policy.windowSeconds !== 'number' || !Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < LOGIN_RATE_LIMIT_MIN_WINDOW_SECONDS || policy.windowSeconds > LOGIN_RATE_LIMIT_MAX_WINDOW_SECONDS) {
    throw new RangeError('登录限速次数必须是 1 到 100 的整数，时间窗口必须是 10 到 3600 秒的整数。')
  }
  return { maxAttempts: policy.maxAttempts, windowSeconds: policy.windowSeconds }
}
