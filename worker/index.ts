import { ApiError, SIMPLE_UPLOAD_LIMIT, PART_SIZE, MAX_OBJECT_SIZE, FOLDER_CONTENT_TYPE, objectKey, prefixValue, boundedInteger, signPayload, verifyPayload, equalSecrets, hashSecret, normalizeAdminPath } from './core'
import { objectResponse } from './objects'
import { createShare, currentShare, resolveShare, revokeShare, shareInfo } from './shares'
import { accessTokenInfo, assertTokenBucket, assertTokenPermission, createAccessToken, revokeAccessToken, tokenIsActive, updateAccessToken, validateTokenRegistry, type StoredAccessToken } from './access-tokens'
import type { TokenPermission } from '../shared/token-permissions'
import { mcpConnectionGuide, mcpInstructions } from '../shared/mcp-guide.ts'
import { handleMcp } from './mcp.ts'
import { statsCursor, storageStatsPage } from './storage-stats.ts'
import { DEFAULT_LOGIN_RATE_LIMIT, normalizeLoginRateLimit, type LoginRateLimit } from '../shared/login-rate-limit.ts'
import { enforceLoginRateLimit, LoginRateLimitError } from './login-rate-limit.ts'
import { listActiveSharesPage } from './share-list.ts'
import { archiveKeys, archiveResponse } from './archive.ts'
import { MAX_ARCHIVE_REQUEST_BYTES } from '../shared/batch-files.ts'

export { LoginRateLimiter } from './login-rate-limit.ts'

interface Env {
  ASSETS: Fetcher
  STORAGE: R2Bucket
  LOGIN_RATE_LIMITER?: DurableObjectNamespace
  STORAGE_BUCKETS?: string
  SESSION_SECRET?: string
  CORS_ORIGINS?: string
  LOCAL_DEVELOPMENT?: string
  [key: string]: unknown
}

type BucketConfig = { name: string; binding: string; description: string }
type StoredConfig = {
  version: 1
  adminPath: string
  displayName: string
  apiTokenHash: string
  credentialVersion?: string
  apiTokens?: StoredAccessToken[]
  loginRateLimit?: LoginRateLimit
  loginRateLimitVersion?: number
  createdAt: string
  updatedAt: string
}
type ConfigSnapshot = StoredConfig & { etag: string }
type Principal = { type: 'admin'; id: 'admin'; fingerprint: string } | { type: 'token'; id: string; fingerprint: string; token: StoredAccessToken }

const SESSION_SECONDS = 12 * 60 * 60
const SYSTEM_CONFIG_KEY = '_mono/system-config.json'
const SYSTEM_PREFIX = '_mono/'
const LOCAL_SESSION_SECRET = 'mono-local-session-secret-change-this-in-production-2026'
const encoder = new TextEncoder()

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers)
  result.set('Content-Type', 'application/json; charset=utf-8')
  result.set('Cache-Control', 'no-store, no-transform')
  return new Response(JSON.stringify(data), { status, headers: result })
}

function localMode(env: Env, url: URL): boolean {
  return env.LOCAL_DEVELOPMENT === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function buckets(env: Env): BucketConfig[] {
  let config: unknown
  try {
    config = JSON.parse(env.STORAGE_BUCKETS || '[{"name":"workspace","binding":"STORAGE","description":"默认存储桶"}]')
  } catch {
    throw new ApiError(503, 'INVALID_CONFIGURATION', '存储桶配置无效。')
  }
  if (!Array.isArray(config) || !config.length || config.some(item => !item || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(item.name) || typeof item.binding !== 'string')) {
    throw new ApiError(503, 'INVALID_CONFIGURATION', '存储桶配置无效。')
  }
  const seen = new Set<string>()
  return config.map(item => {
    if (seen.has(item.name)) throw new ApiError(503, 'INVALID_CONFIGURATION', '存储桶名称不能重复。')
    seen.add(item.name)
    return { name: item.name, binding: item.binding, description: typeof item.description === 'string' ? item.description : '' }
  })
}

function getBucket(env: Env, name: string): R2Bucket {
  const config = buckets(env).find(item => item.name === name)
  const bucket = config ? env[config.binding] as R2Bucket | undefined : undefined
  if (!bucket || typeof bucket.list !== 'function') throw new ApiError(404, 'BUCKET_NOT_FOUND', '存储桶不存在或尚未绑定。')
  return bucket
}

function primaryBucket(env: Env): R2Bucket {
  return getBucket(env, buckets(env)[0].name)
}

async function readStoredConfig(env: Env): Promise<ConfigSnapshot | null> {
  const object = await primaryBucket(env).get(SYSTEM_CONFIG_KEY)
  if (!object) return null
  try {
    const value = JSON.parse(await object.text()) as Partial<StoredConfig>
    if (value.version !== 1 || typeof value.adminPath !== 'string' || normalizeAdminPath(value.adminPath) !== value.adminPath || typeof value.displayName !== 'string' || value.displayName.length < 2 || typeof value.apiTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.apiTokenHash)) throw new Error('Invalid configuration')
    if (value.credentialVersion !== undefined && (typeof value.credentialVersion !== 'string' || !/^[a-f0-9]{32}$/.test(value.credentialVersion))) throw new Error('Invalid credential version')
    const apiTokens = validateTokenRegistry(value.apiTokens)
    const loginRateLimit = normalizeLoginRateLimit(value.loginRateLimit)
    if (value.loginRateLimitVersion !== undefined && (!Number.isSafeInteger(value.loginRateLimitVersion) || value.loginRateLimitVersion < 0)) throw new Error('Invalid login rate limit version')
    return { version: 1, adminPath: value.adminPath, displayName: value.displayName, apiTokenHash: value.apiTokenHash, ...(value.credentialVersion === undefined ? {} : { credentialVersion: value.credentialVersion }), ...(value.apiTokens === undefined ? {} : { apiTokens }), loginRateLimit, loginRateLimitVersion: value.loginRateLimitVersion ?? 0, createdAt: String(value.createdAt || ''), updatedAt: String(value.updatedAt || ''), etag: object.etag }
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后再试。')
  }
}

async function writeInitialConfig(env: Env, config: StoredConfig): Promise<void> {
  const result = await primaryBucket(env).put(SYSTEM_CONFIG_KEY, JSON.stringify(config), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } })
  if (!result) throw new ApiError(409, 'ALREADY_CONFIGURED', '该存储空间已经完成初始化。')
}

function randomApiToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `mono_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

function signingSecret(env: Env, url: URL): string {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET
  if (localMode(env, url)) return LOCAL_SESSION_SECRET
  throw new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后再试。')
}

async function requireConfiguration(env: Env): Promise<ConfigSnapshot> {
  const config = await readStoredConfig(env)
  if (!config) throw new ApiError(428, 'SETUP_REQUIRED', '请先完成首次安装配置。')
  return config
}

async function authenticationConfig(env: Env): Promise<ConfigSnapshot | null> {
  try { return await readStoredConfig(env) } catch { return null }
}

function hasCredentials(request: Request): boolean {
  return request.headers.has('Authorization') || Boolean(request.headers.get('Cookie')?.split(';').some(value => value.trim().startsWith('mono_session=')))
}

function isSystemKey(key: string): boolean {
  return key === SYSTEM_PREFIX.slice(0, -1) || key.startsWith(SYSTEM_PREFIX)
}

function publicObjectKey(value: unknown, options: { folder?: boolean } = {}): string {
  const key = objectKey(value, options)
  if (isSystemKey(key)) throw new ApiError(400, 'RESERVED_KEY', '该对象路径由系统保留。')
  return key
}

function configFingerprint(config: StoredConfig): string {
  // Credential generations invalidate previous sessions and shares.
  return config.credentialVersion || config.apiTokenHash
}

function configInfo(config: StoredConfig) {
  return { displayName: config.displayName, adminPath: config.adminPath, createdAt: config.createdAt, updatedAt: config.updatedAt, loginRateLimit: normalizeLoginRateLimit(config.loginRateLimit) }
}

function setupStatus(env: Env, url: URL, config: StoredConfig | null, authenticated = false) {
  return {
    configured: Boolean(config),
    setupRequired: !config,
    setupTokenRequired: false,
    adminPath: authenticated ? config?.adminPath || null : null,
    displayName: authenticated ? config?.displayName || null : null,
    local: localMode(env, url),
  }
}

function serializeObject(item: R2Object) {
  return {
    key: item.key,
    size: item.size,
    etag: item.etag,
    uploaded: item.uploaded.toISOString(),
    contentType: item.httpMetadata?.contentType || 'application/octet-stream',
    metadata: item.customMetadata || {},
  }
}

async function readJson(request: Request, maxBytes = 32 * 1024): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length') || 0) > maxBytes) {
    throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大。')
  }
  let text = ''
  if (request.body) {
    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    let length = 0
    const abort = () => { void reader.cancel().catch(() => undefined) }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        if (request.signal.aborted) throw new DOMException('请求已取消。', 'AbortError')
        const chunk = await reader.read()
        if (request.signal.aborted) throw new DOMException('请求已取消。', 'AbortError')
        if (chunk.done) { text += decoder.decode(); break }
        length += chunk.value.byteLength
        if (length > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大。')
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      request.signal.removeEventListener('abort', abort)
      reader.releaseLock()
    }
  }
  if (encoder.encode(text).length > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大。')
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求体必须是有效的 JSON 对象。')
  }
}

function allowedOrigin(request: Request, env: Env, url: URL): string | null {
  const origin = request.headers.get('Origin')
  if (!origin) return null
  if (origin === url.origin) return origin
  if (env.LOCAL_DEVELOPMENT === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) return origin
  const configured = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  if (configured.includes(origin)) return origin
  throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '该网站无权访问此 API。')
}

async function authenticatePrincipal(request: Request, env: Env, url: URL, config?: StoredConfig | null): Promise<Principal | null> {
  const current = config === undefined ? await readStoredConfig(env) : config
  if (!current) return null
  const authorization = request.headers.get('Authorization')
  if (authorization !== null) {
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    const tokenHash = candidate.length >= 24 && candidate.length <= 256 ? await hashSecret(candidate) : null
    const administrator = tokenHash !== null && await equalSecrets(tokenHash, current.apiTokenHash)
    const token = tokenHash === null ? undefined : current.apiTokens?.find(item => item.tokenHash === tokenHash && tokenIsActive(item))
    await enforceLoginRateLimit(request, env.LOGIN_RATE_LIMITER, current.loginRateLimit || DEFAULT_LOGIN_RATE_LIMIT, current.loginRateLimitVersion ?? 0, 'login', localMode(env, url), !administrator && !token)
    if (administrator) return { type: 'admin', id: 'admin', fingerprint: configFingerprint(current) }
    return token ? { type: 'token', id: token.id, fingerprint: `${configFingerprint(current)}:${token.credentialVersion}`, token } : null
  }
  const cookie = request.headers.get('Cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith('mono_session='))?.slice('mono_session='.length)
  if (!cookie) return null
  const payload = await verifyPayload(cookie, signingSecret(env, url), 'session')
  return payload?.fingerprint === configFingerprint(current) ? { type: 'admin', id: 'admin', fingerprint: configFingerprint(current) } : null
}

async function authenticate(request: Request, env: Env, url: URL, config?: StoredConfig | null): Promise<boolean> {
  return (await authenticatePrincipal(request, env, url, config))?.type === 'admin'
}

function requireAdministrator(principal: Principal): void {
  if (principal.type !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', '此操作仅允许存储管理员执行。')
}

function authorize(principal: Principal, permission: TokenPermission, name: string, key?: string, folder = false): void {
  if (principal.type === 'token') assertTokenPermission(principal.token, permission, name, key, folder)
}

function configValue(config: ConfigSnapshot): StoredConfig {
  const { etag: _etag, ...value } = config
  return value
}

function matchesRevision(value: string | null, etag: string): boolean {
  if (value === null) return true
  const revision = value.trim()
  if (revision === '*') return true
  // Strong and weak ETags identify the same application revision.
  const match = /^(?:W\/)?"([^"\x00-\x20\x7f]+)"$/.exec(revision)
  return match !== null && match[1] === etag
}

function assertRegistryRevision(request: Request, config: ConfigSnapshot): void {
  const expected = request.headers.get('If-Match')
  if (!matchesRevision(expected, config.etag)) throw new ApiError(409, 'TOKEN_CONFLICT', 'Token 配置已被其他窗口修改，请刷新后重试。')
}

async function saveTokenRegistry(env: Env, config: ConfigSnapshot, registry: StoredAccessToken[]): Promise<string> {
  const next: StoredConfig = { ...configValue(config), apiTokens: registry, updatedAt: new Date().toISOString() }
  const saved = await primaryBucket(env).put(SYSTEM_CONFIG_KEY, JSON.stringify(next), { onlyIf: { etagMatches: config.etag }, httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } })
  if (!saved) throw new ApiError(409, 'TOKEN_CONFLICT', 'Token 配置已被其他窗口修改，请刷新后重试。')
  return saved.etag
}

function assertMutation(request: Request): void {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !request.headers.get('Authorization')?.startsWith('Bearer ') && request.headers.get('X-Mono-Client') !== 'web') {
    throw new ApiError(403, 'CSRF_PROTECTION', '缺少请求来源标记。API 调用请使用 Bearer Token。')
  }
}

function cookieValue(value: string, seconds: number, url: URL): string {
  return `mono_session=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${seconds}${url.protocol === 'https:' ? '; Secure' : ''}`
}

function metadataFromBody(body: Record<string, unknown>): Record<string, string> {
  if (body.metadata === undefined) return {}
  if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) throw new ApiError(400, 'INVALID_METADATA', 'metadata 必须是字符串键值对象。')
  const entries = Object.entries(body.metadata)
  if (entries.length > 30 || entries.some(([key, value]) => !key || key.length > 128 || typeof value !== 'string' || value.length > 1024) || encoder.encode(JSON.stringify(body.metadata)).length > 1900) {
    throw new ApiError(400, 'INVALID_METADATA', '自定义元数据过大，或包含无效的值。')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function contentType(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'application/octet-stream'
  if (value.length > 256 || /[\r\n\x00]/.test(value)) throw new ApiError(400, 'INVALID_CONTENT_TYPE', '无效的 Content-Type。')
  return value
}

async function signedUpload(request: Request, env: Env, url: URL, body: Record<string, unknown>, name: string, principal: Principal): Promise<{ uploadId: string; key: string }> {
  if (typeof body.uploadToken !== 'string') throw new ApiError(400, 'INVALID_UPLOAD', '缺少分片上传凭证。')
  const secret = signingSecret(env, url)
  const payload = await verifyPayload(body.uploadToken, secret, 'upload')
  if (!payload || payload.bucket !== name || typeof payload.key !== 'string' || typeof payload.uploadId !== 'string') throw new ApiError(400, 'INVALID_UPLOAD', '分片上传凭证无效或已过期。')
  if (payload.principal !== principal.id || payload.fingerprint !== principal.fingerprint) throw new ApiError(403, 'UPLOAD_TOKEN_DENIED', '此分片上传凭证不属于当前 Token，或权限已发生变化。')
  const key = publicObjectKey(payload.key)
  authorize(principal, 'write', name, key)
  return { key, uploadId: payload.uploadId }
}

async function publicShare(env: Env, id: string, request?: Request, url?: URL) {
  const config = await readStoredConfig(env)
  if (!config) throw new ApiError(404, 'SHARE_UNAVAILABLE', '分享不存在、已过期或已被取消。')
  let principal: Principal | null = null
  if (request?.headers.has('Authorization')) {
    principal = await authenticatePrincipal(request, env, url || new URL(request.url), config)
    if (!principal) throw new ApiError(401, 'UNAUTHORIZED', '访问 Token 无效、已停用或已过期。')
  }
  const result = await resolveShare(primaryBucket(env), id, configFingerprint(config), name => getBucket(env, name))
  if (principal) authorize(principal, 'read', result.share.bucket, result.share.key)
  return result
}

function notFound(): Response {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;background:#fafafa;color:#222;font:16px system-ui;text-align:center}h1{font-size:48px;margin:0}p{color:#555}</style><h1>404</h1><p>页面不存在</p></html>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } })
}

async function appPage(request: Request, env: Env): Promise<Response> {
  const assetUrl = new URL('/', request.url)
  const response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }))
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  return new Response(response.body, { status: response.status, headers })
}

async function page(request: Request, env: Env, url: URL): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return notFound()
  if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.svg') return env.ASSETS.fetch(request)
  const shared = /^\/s\/([a-f0-9]{32})(\/file)?$/.exec(url.pathname)
  if (shared) {
    const { share, bucket } = await publicShare(env, shared[1], request, url)
    return shared[2] ? objectResponse(request, bucket, share.key, url.searchParams.get('download') === 'true', share.objectVersion) : appPage(request, env)
  }
  const config = await readStoredConfig(env)
  if (url.pathname !== '/' && (!config || url.pathname !== config.adminPath)) return notFound()
  return appPage(request, env)
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname
  if (path === '/api/health' && ['GET', 'HEAD'].includes(request.method)) return json({ ok: true })
  if (path === '/api/session' && request.method === 'GET') {
    if (!hasCredentials(request)) return json({ authenticated: false })
    const config = await authenticationConfig(env)
    const authenticated = await authenticate(request, env, url, config)
    return json(authenticated ? { ...setupStatus(env, url, config, true), authenticated: true } : { authenticated: false })
  }
  if (path === '/api/session' && request.method === 'POST') {
    assertMutation(request)
    const config = await authenticationConfig(env)
    await enforceLoginRateLimit(request, env.LOGIN_RATE_LIMITER, config?.loginRateLimit || DEFAULT_LOGIN_RATE_LIMIT, config?.loginRateLimitVersion ?? 0, 'login', localMode(env, url))
    const body = await readJson(request)
    if (!config || typeof body.token !== 'string' || body.token.length < 24 || body.token.length > 256 || !await equalSecrets(await hashSecret(body.token), config.apiTokenHash)) throw new ApiError(401, 'INVALID_TOKEN', '访问密钥不正确。')
    const token = await signPayload({ purpose: 'session', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, fingerprint: configFingerprint(config) }, signingSecret(env, url))
    return json({ ...setupStatus(env, url, config, true), authenticated: true }, 200, { 'Set-Cookie': cookieValue(token, SESSION_SECONDS, url) })
  }
  if (path === '/api/session' && request.method === 'DELETE') {
    assertMutation(request)
    return json({ authenticated: false }, 200, { 'Set-Cookie': cookieValue('', 0, url) })
  }
  if (path === '/api/setup' && request.method === 'GET') {
    return json({ setupRequired: !await primaryBucket(env).head(SYSTEM_CONFIG_KEY) })
  }
  if (path === '/api/setup' && request.method === 'POST') {
    assertMutation(request)
    await enforceLoginRateLimit(request, env.LOGIN_RATE_LIMITER, { maxAttempts: 3, windowSeconds: 60 }, 0, 'setup', localMode(env, url))
    if (await primaryBucket(env).head(SYSTEM_CONFIG_KEY)) throw new ApiError(409, 'ALREADY_CONFIGURED', '该存储空间已经完成初始化。')
    signingSecret(env, url)
    const body = await readJson(request)
    const adminPath = normalizeAdminPath(body.adminPath)
    if (adminPath === '/mcp') throw new ApiError(400, 'INVALID_ADMIN_PATH', '后台入口不能使用 MCP 接口路径 /mcp。')
    const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim().slice(0, 80) : 'MONO Storage'
    if (displayName.length < 2) throw new ApiError(400, 'INVALID_DISPLAY_NAME', '显示名称至少需要 2 个字符。')
    const apiToken = typeof body.apiToken === 'string' && body.apiToken.trim() ? body.apiToken.trim() : randomApiToken()
    if (apiToken.length < 24 || apiToken.length > 256) throw new ApiError(400, 'INVALID_API_TOKEN', 'API Token 长度必须在 24 到 256 个字符之间。')
    const now = new Date().toISOString()
    const config: StoredConfig = { version: 1, adminPath, displayName, apiTokenHash: await hashSecret(apiToken), credentialVersion: crypto.randomUUID().replaceAll('-', ''), loginRateLimit: { ...DEFAULT_LOGIN_RATE_LIMIT }, loginRateLimitVersion: 0, createdAt: now, updatedAt: now }
    await writeInitialConfig(env, config)
    const session = await signPayload({ purpose: 'session', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, fingerprint: configFingerprint(config) }, signingSecret(env, url))
    return json({ ...setupStatus(env, url, config, true), authenticated: true, apiToken }, 201, { 'Set-Cookie': cookieValue(session, SESSION_SECONDS, url) })
  }
  const shareMatch = /^\/api\/shares\/([a-f0-9]{32})$/.exec(path)
  if (shareMatch && request.method === 'GET') {
    const { share, head } = await publicShare(env, shareMatch[1], request, url)
    return json({ object: { ...serializeObject(head), key: share.key.split('/').pop(), metadata: {} }, expiresAt: share.expiresAt, previewUrl: `/s/${share.id}/file`, downloadUrl: `/s/${share.id}/file?download=true` })
  }
  if (!hasCredentials(request)) throw new ApiError(401, 'UNAUTHORIZED', '需要有效的访问凭据。')
  const config = await authenticationConfig(env)
  if (!config) throw new ApiError(401, 'UNAUTHORIZED', '需要有效的访问凭据。')
  const principal = await authenticatePrincipal(request, env, url, config)
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', '请先登录，或使用 Bearer Token 调用 API。')
  assertMutation(request)
  if (path === '/api/mcp/guide' && ['GET', 'HEAD'].includes(request.method)) {
    const guide = principal.type === 'admin' ? mcpConnectionGuide() : mcpInstructions(principal.token.scope, principal.token.permissions)
    return new Response(request.method === 'HEAD' ? null : guide, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'Content-Disposition': 'attachment; filename="mono-mcp-guide.md"', 'X-Robots-Tag': 'noindex, nofollow' } })
  }
  if (path === '/api/panel' && request.method === 'GET') {
    requireAdministrator(principal)
    const manifest = await env.ASSETS.fetch(new Request(new URL('/api/panel-assets/manifest.json', url)))
    if (!manifest.ok) throw new ApiError(503, 'SERVICE_UNAVAILABLE', '后台暂时不可用。')
    const { entry } = await manifest.json() as { entry?: unknown }
    if (typeof entry !== 'string' || !/^\/api\/panel-assets\/console-[a-zA-Z0-9_-]+\.js$/.test(entry)) throw new ApiError(503, 'SERVICE_UNAVAILABLE', '后台暂时不可用。')
    return json({ entry })
  }
  if (path.startsWith('/api/panel-assets/') && ['GET', 'HEAD'].includes(request.method)) {
    requireAdministrator(principal)
    if (!/^\/api\/panel-assets\/[a-zA-Z0-9_-]+\.(?:js|css|json)$/.test(path)) throw new ApiError(404, 'NOT_FOUND', '页面不存在。')
    const asset = await env.ASSETS.fetch(request)
    const headers = new Headers(asset.headers)
    headers.set('Cache-Control', 'private, no-store, no-transform')
    headers.set('X-Robots-Tag', 'noindex, nofollow')
    return new Response(asset.body, { status: asset.status, headers })
  }
  if (path === '/api/shares' && request.method === 'GET') {
    requireAdministrator(principal)
    if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) throw new ApiError(400, 'INVALID_SHARES_QUERY', '分享链接列表只接受 cursor 分页参数。')
    return json(await listActiveSharesPage(primaryBucket(env), name => getBucket(env, name), buckets(env).map(bucket => bucket.name), configFingerprint(config), url.searchParams.get('cursor') || undefined))
  }
  if (path === '/api/config' && request.method === 'GET') {
    requireAdministrator(principal)
    return json({ config: configInfo(config) }, 200, { ETag: `"${config.etag}"` })
  }
  if (path === '/api/config' && request.method === 'PATCH') {
    requireAdministrator(principal)
    const body = await readJson(request)
    const fields = Object.keys(body)
    if (!fields.length || fields.some(field => !['displayName', 'adminPath', 'apiToken', 'loginRateLimit'].includes(field))) throw new ApiError(400, 'INVALID_CONFIG_UPDATE', '配置包含不支持的字段。')
    const expectedEtag = request.headers.get('If-Match')
    if (!matchesRevision(expectedEtag, config.etag)) throw new ApiError(409, 'CONFIG_CONFLICT', '配置已被其他窗口修改，请刷新后重试。')
    let displayName = config.displayName
    if ('displayName' in body) {
      if (typeof body.displayName !== 'string') throw new ApiError(400, 'INVALID_DISPLAY_NAME', '显示名称必须是文本。')
      displayName = body.displayName.trim() ? body.displayName.trim().slice(0, 80) : 'MONO Storage'
      if (displayName.length < 2) throw new ApiError(400, 'INVALID_DISPLAY_NAME', '显示名称至少需要 2 个字符。')
    }
    const adminPath = 'adminPath' in body ? normalizeAdminPath(body.adminPath) : config.adminPath
    if ('adminPath' in body && adminPath === '/mcp') throw new ApiError(400, 'INVALID_ADMIN_PATH', '后台入口不能使用 MCP 接口路径 /mcp。')
    let apiToken: string | undefined
    let loginRateLimit = normalizeLoginRateLimit(config.loginRateLimit)
    if ('loginRateLimit' in body) {
      try { loginRateLimit = normalizeLoginRateLimit(body.loginRateLimit) }
      catch { throw new ApiError(400, 'INVALID_LOGIN_RATE_LIMIT', '登录限速次数必须是 1 到 100 的整数，时间窗口必须是 10 到 3600 秒的整数。') }
    }
    const rateLimitChanged = loginRateLimit.maxAttempts !== config.loginRateLimit?.maxAttempts || loginRateLimit.windowSeconds !== config.loginRateLimit?.windowSeconds
    const loginRateLimitVersion = (config.loginRateLimitVersion ?? 0) + Number(rateLimitChanged)
    if (!Number.isSafeInteger(loginRateLimitVersion)) throw new ApiError(503, 'SERVICE_UNAVAILABLE', '暂时无法保存配置。')
    if ('apiToken' in body) {
      if (typeof body.apiToken !== 'string') throw new ApiError(400, 'INVALID_API_TOKEN', 'API Token 必须是文本。')
      apiToken = body.apiToken.trim() || randomApiToken()
      if (apiToken.length < 24 || apiToken.length > 256) throw new ApiError(400, 'INVALID_API_TOKEN', 'API Token 长度必须在 24 到 256 个字符之间。')
      const candidateHash = await hashSecret(apiToken)
      if (await equalSecrets(candidateHash, config.apiTokenHash)) throw new ApiError(400, 'UNCHANGED_API_TOKEN', '新 Token 与当前 Token 相同，请使用不同的密钥或自动生成。')
      if (config.apiTokens?.some(token => token.tokenHash === candidateHash)) throw new ApiError(400, 'TOKEN_ALREADY_USED', '此 Token 已被 API 授权使用，请设置不同的管理员密钥。')
    }
    const next: StoredConfig = {
      version: 1, displayName, adminPath,
      loginRateLimit, loginRateLimitVersion,
      apiTokenHash: apiToken === undefined ? config.apiTokenHash : await hashSecret(apiToken),
      ...(apiToken === undefined ? config.credentialVersion === undefined ? {} : { credentialVersion: config.credentialVersion } : { credentialVersion: crypto.randomUUID().replaceAll('-', '') }),
      ...(config.apiTokens === undefined ? {} : { apiTokens: apiToken === undefined ? config.apiTokens : config.apiTokens.map(revokeAccessToken) }),
      createdAt: config.createdAt,
      updatedAt: new Date().toISOString(),
    }
    const session = await signPayload({ purpose: 'session', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, fingerprint: configFingerprint(next) }, signingSecret(env, url))
    const saved = await primaryBucket(env).put(SYSTEM_CONFIG_KEY, JSON.stringify(next), { onlyIf: { etagMatches: config.etag }, httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } })
    if (!saved) throw new ApiError(409, 'CONFIG_CONFLICT', '配置已被其他窗口修改，请刷新后重试。')
    return json({ config: configInfo(next), ...(apiToken === undefined ? {} : { apiToken }) }, 200, { ETag: `"${saved.etag}"`, 'Set-Cookie': cookieValue(session, SESSION_SECONDS, url) })
  }
  const tokenMatch = /^\/api\/tokens(?:\/([a-f0-9]{32}))?$/.exec(path)
  if (tokenMatch) {
    requireAdministrator(principal)
    const registry = config.apiTokens || []
    const id = tokenMatch[1]
    if (!id && request.method === 'GET') {
      const bucketName = url.searchParams.get('bucket')
      const key = url.searchParams.get('key')
      if (key !== null && !bucketName) throw new ApiError(400, 'INVALID_TOKEN_SCOPE', '按文件筛选 Token 时必须提供存储桶。')
      if (bucketName !== null && !buckets(env).some(bucket => bucket.name === bucketName)) throw new ApiError(400, 'INVALID_TOKEN_SCOPE', '存储桶不存在。')
      const object = key === null ? null : publicObjectKey(key)
      const selected = registry.filter(token => !token.revoked && (object !== null ? token.scope.type === 'file' && token.scope.bucket === bucketName && token.scope.key === object : bucketName === null || token.scope.type === 'all' || token.scope.bucket === bucketName))
      return json({ tokens: selected.map(accessTokenInfo) }, 200, { ETag: `"${config.etag}"` })
    }
    if (!id && request.method === 'POST') {
      assertRegistryRevision(request, config)
      const created = await createAccessToken(await readJson(request), buckets(env).map(bucket => bucket.name), registry, config.apiTokenHash)
      const etag = await saveTokenRegistry(env, config, [...registry, created.token])
      return json({ token: accessTokenInfo(created.token), secret: created.secret }, 201, { ETag: `"${etag}"` })
    }
    const current = id ? registry.find(token => token.id === id && !token.revoked) : null
    if (id && !current) throw new ApiError(404, 'TOKEN_NOT_FOUND', 'Token 不存在或已撤销。')
    if (current && request.method === 'PATCH') {
      assertRegistryRevision(request, config)
      const next = updateAccessToken(current, await readJson(request))
      const etag = await saveTokenRegistry(env, config, registry.map(token => token.id === id ? next : token))
      return json({ token: accessTokenInfo(next) }, 200, { ETag: `"${etag}"` })
    }
    if (current && request.method === 'DELETE') {
      assertRegistryRevision(request, config)
      const etag = await saveTokenRegistry(env, config, registry.map(token => token.id === id ? revokeAccessToken(token) : token))
      return new Response(null, { status: 204, headers: { ETag: `"${etag}"`, 'Cache-Control': 'no-store' } })
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口不支持该请求方法。')
  }
  if (path === '/api/buckets' && request.method === 'GET') {
    const visible = buckets(env).filter(bucket => principal.type === 'admin' || principal.token.scope.type === 'all' || principal.token.scope.bucket === bucket.name)
    return json({ buckets: visible.map(bucket => ({ name: bucket.name, description: bucket.description })), capabilities: { simpleUploadLimit: SIMPLE_UPLOAD_LIMIT, partSize: PART_SIZE, maxObjectSize: MAX_OBJECT_SIZE }, ...(principal.type === 'admin' ? { config: { adminPath: config.adminPath, displayName: config.displayName } } : {}) })
  }
  const match = /^\/api\/buckets\/([a-z0-9_-]+)\/(objects|object|folders|uploads|shares|stats|archive)(?:\/(part|complete|abort))?$/.exec(path)
  if (!match) throw new ApiError(404, 'NOT_FOUND', 'API 路径不存在。')
  const [, name, resource, action] = match
  if (principal.type === 'token') assertTokenBucket(principal.token, name)
  const bucket = getBucket(env, name)

  if (resource === 'archive' && !action && request.method === 'POST') {
    if (url.searchParams.size) throw new ApiError(400, 'INVALID_ARCHIVE_QUERY', '打包下载只接受 JSON 文件列表。')
    const keys = archiveKeys(await readJson(request, MAX_ARCHIVE_REQUEST_BYTES), value => publicObjectKey(value))
    for (const key of keys) authorize(principal, 'read', name, key)
    return archiveResponse(bucket, keys, name, request.signal)
  }

  if (resource === 'stats' && !action && request.method === 'GET') {
    const exactFile = principal.type === 'token' && principal.token.scope.type === 'file' ? principal.token.scope.key : undefined
    authorize(principal, 'read', name, exactFile)
    if ([...url.searchParams.keys()].some(key => key !== 'cursor' && key !== 'prefix') || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('prefix').length > 1) throw new ApiError(400, 'INVALID_STATS_QUERY', '存储统计只接受 prefix 和 cursor 参数。')
    return json(await storageStatsPage(bucket, statsCursor(url.searchParams.get('cursor')), exactFile, prefixValue(url.searchParams.get('prefix'))))
  }

  if (resource === 'shares' && !action) {
    if (request.method === 'POST') {
      const body = await readJson(request)
      const key = publicObjectKey(body.key)
      authorize(principal, 'share', name, key)
      authorize(principal, 'read', name, key)
      const head = await bucket.head(key)
      if (!head) throw new ApiError(404, 'OBJECT_NOT_FOUND', '文件不存在。')
      const share = await createShare(primaryBucket(env), name, key, head, configFingerprint(config), body.expiresIn)
      return json(shareInfo(share), 201)
    }
    const key = publicObjectKey(url.searchParams.get('key'))
    if (request.method === 'GET') {
      authorize(principal, 'share', name, key)
      const head = await bucket.head(key)
      const share = head ? await currentShare(primaryBucket(env), name, key, head, configFingerprint(config)) : null
      return json({ share: share ? shareInfo(share) : null })
    }
    if (request.method === 'DELETE') {
      authorize(principal, 'share', name, key)
      await revokeShare(primaryBucket(env), name, key)
      return new Response(null, { status: 204 })
    }
  }

  if (resource === 'objects' && !action && request.method === 'GET') {
    const prefix = prefixValue(url.searchParams.get('prefix'))
    const recursive = url.searchParams.get('recursive') === 'true'
    const limit = boundedInteger(url.searchParams.get('limit'), 100, 1, 1000)
    const cursor = url.searchParams.get('cursor') || undefined
    if (cursor && cursor.length > 4096) throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效。')
    if (principal.type === 'token' && principal.token.scope.type === 'file') {
      const key = principal.token.scope.key
      authorize(principal, 'read', name, key)
      const head = key.startsWith(prefix) ? await bucket.head(key) : null
      return json({ objects: head ? [serializeObject(head)] : [], folders: [], cursor: null, truncated: false, prefix })
    }
    authorize(principal, 'read', name)
    const result = await bucket.list({ prefix, cursor, limit, delimiter: recursive ? undefined : '/', include: ['httpMetadata', 'customMetadata'] })
    return json({ objects: result.objects.filter(item => !isSystemKey(item.key) && !item.key.endsWith('/')).map(serializeObject), folders: (result.delimitedPrefixes || []).filter(item => !isSystemKey(item)), cursor: result.truncated ? result.cursor : null, truncated: result.truncated, prefix })
  }

  if (resource === 'object' && !action) {
    const key = publicObjectKey(url.searchParams.get('key'))
    if (request.method === 'GET' || request.method === 'HEAD') {
      authorize(principal, 'read', name, key)
      if (url.searchParams.get('metadata') === 'true') {
        const head = await bucket.head(key)
        if (!head) throw new ApiError(404, 'OBJECT_NOT_FOUND', '文件不存在。')
        return json(serializeObject(head))
      }
      return objectResponse(request, bucket, key, url.searchParams.get('download') === 'true')
    }
    if (request.method === 'PUT') {
      authorize(principal, 'write', name, key)
      const length = request.headers.get('Content-Length')
      if (length && Number(length) > SIMPLE_UPLOAD_LIMIT) throw new ApiError(413, 'USE_MULTIPART', '大文件请使用分片上传 API。')
      const headers = new Headers(request.headers)
      const customMetadata: Record<string, string> = {}
      for (const [header, value] of headers) if (header.startsWith('x-object-meta-')) customMetadata[header.slice(14)] = value
      metadataFromBody({ metadata: customMetadata })
      const overwrite = url.searchParams.get('overwrite') === 'true'
      const expectedEtag = request.headers.get('If-Match')
      const onlyIf = expectedEtag ? { etagMatches: expectedEtag.replace(/^"|"$/g, '') } : overwrite ? undefined : { etagDoesNotMatch: '*' }
      const item = await bucket.put(key, request.body || new Uint8Array(), { httpMetadata: { contentType: contentType(request.headers.get('Content-Type')) }, customMetadata, onlyIf })
      if (!item) throw new ApiError(409, 'OBJECT_EXISTS', '同名文件已经存在。请选择覆盖或更换文件名。')
      return json(serializeObject(item), 201)
    }
    if (request.method === 'DELETE') {
      authorize(principal, 'delete', name, key)
      const existing = await bucket.head(key)
      if (!existing) throw new ApiError(404, 'OBJECT_NOT_FOUND', '文件不存在。')
      await bucket.delete(key)
      return new Response(null, { status: 204 })
    }
  }

  if (resource === 'folders' && !action) {
    if (request.method === 'POST') {
      const body = await readJson(request)
      const key = publicObjectKey(body.key, { folder: true })
      authorize(principal, 'create_folder', name, key, true)
      await bucket.put(key, new Uint8Array(), { httpMetadata: { contentType: FOLDER_CONTENT_TYPE } })
      return json({ key }, 201)
    }
    if (request.method === 'DELETE') {
      const key = publicObjectKey(url.searchParams.get('key'), { folder: true })
      authorize(principal, 'delete_folder', name, key, true)
      const contents = await bucket.list({ prefix: key, limit: 2 })
      if (contents.truncated || contents.objects.some(item => item.key !== key)) throw new ApiError(409, 'FOLDER_NOT_EMPTY', '请先删除文件夹中的文件，再删除文件夹。')
      await bucket.delete(key)
      return new Response(null, { status: 204 })
    }
  }

  if (resource === 'objects' && !action && request.method === 'DELETE') {
    const body = await readJson(request)
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 100) throw new ApiError(400, 'INVALID_KEYS', '每次可删除 1 到 100 个文件。')
    const keys = body.keys.map(key => publicObjectKey(key))
    for (const key of keys) authorize(principal, 'delete', name, key)
    await bucket.delete(keys)
    return json({ deleted: keys.length })
  }

  if (resource === 'uploads') {
    if (!action && request.method === 'POST') {
      const body = await readJson(request)
      const key = publicObjectKey(body.key)
      authorize(principal, 'write', name, key)
      if (body.overwrite !== true && await bucket.head(key)) throw new ApiError(409, 'OBJECT_EXISTS', '同名文件已经存在。')
      if (typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_OBJECT_SIZE) throw new ApiError(400, 'INVALID_SIZE', '文件大小无效。')
      const created = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: contentType(body.contentType) }, customMetadata: metadataFromBody(body) })
      const secret = signingSecret(env, url)
      const uploadToken = await signPayload({ purpose: 'upload', bucket: name, key, uploadId: created.uploadId, exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, size: body.size, principal: principal.id, fingerprint: principal.fingerprint }, secret)
      return json({ uploadToken, partSize: PART_SIZE, key }, 201)
    }
    if (action === 'part' && request.method === 'PUT') {
      const body = { uploadToken: request.headers.get('X-Upload-Token') }
      const upload = await signedUpload(request, env, url, body, name, principal)
      const partNumber = boundedInteger(url.searchParams.get('partNumber'), 0, 1, 10000)
      if (!request.body) throw new ApiError(400, 'EMPTY_PART', '分片内容不能为空。')
      if (Number(request.headers.get('Content-Length') || 0) > SIMPLE_UPLOAD_LIMIT) throw new ApiError(413, 'PART_TOO_LARGE', '每个分片不能超过 90 MiB。')
      const part = await bucket.resumeMultipartUpload(upload.key, upload.uploadId).uploadPart(partNumber, request.body)
      return json(part)
    }
    if (action === 'complete' && request.method === 'POST') {
      const body = await readJson(request)
      const upload = await signedUpload(request, env, url, body, name, principal)
      if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 10000) throw new ApiError(400, 'INVALID_PARTS', '分片列表无效。')
      const parts = body.parts.map((part, index) => {
        if (!part || part.partNumber !== index + 1 || typeof part.etag !== 'string' || part.etag.length > 256) throw new ApiError(400, 'INVALID_PARTS', '分片必须从 1 开始连续排序。')
        return { partNumber: part.partNumber as number, etag: part.etag as string }
      })
      const item = await bucket.resumeMultipartUpload(upload.key, upload.uploadId).complete(parts)
      return json(serializeObject(item), 201)
    }
    if (action === 'abort' && request.method === 'POST') {
      const body = await readJson(request)
      const upload = await signedUpload(request, env, url, body, name, principal)
      await bucket.resumeMultipartUpload(upload.key, upload.uploadId).abort()
      return new Response(null, { status: 204 })
    }
  }
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口不支持该请求方法。')
}

async function mcp(request: Request, env: Env, url: URL): Promise<Response> {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) throw new ApiError(401, 'UNAUTHORIZED', 'MCP 需要有效 API Token 的 Bearer 请求头。')
  const configuration = await authenticationConfig(env)
  if (!configuration) throw new ApiError(401, 'UNAUTHORIZED', '需要有效的访问凭据。')
  const principal = await authenticatePrincipal(request, env, url, configuration)
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', '访问 Token 无效、已停用或已过期。')
  if (principal.type !== 'token') throw new ApiError(403, 'MCP_API_TOKEN_REQUIRED', '请在后台创建独立的 API Token 用于 MCP。')
  return handleMcp(request, {
    origin: url.origin,
    scope: principal.token.scope,
    permissions: [...principal.token.permissions],
    expiresAt: principal.token.expiresAt,
    dispatch: async storageRequest => {
      const storageUrl = new URL(storageRequest.url)
      if (storageUrl.origin !== url.origin || !/^\/api\/buckets(?:$|\/[a-z0-9_-]+\/(?:objects|object|folders|uploads|shares|stats)(?:\/(?:part|complete|abort))?$)/.test(storageUrl.pathname)) throw new ApiError(403, 'MCP_ROUTE_DENIED', 'MCP 只允许调用本站存储 API。')
      const headers = new Headers(storageRequest.headers)
      headers.set('Authorization', authorization)
      headers.delete('Cookie')
      headers.delete('Origin')
      // Every operation enforces the current token permissions and storage scope.
      try { return await api(new Request(storageRequest, { headers }), env, storageUrl) }
      catch (error) {
        if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status)
        return json({ error: { code: 'STORAGE_ERROR', message: '存储操作失败。' } }, 500)
      }
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const isMcp = url.pathname === '/mcp'
    const isApi = url.pathname.startsWith('/api/') || isMcp
    let origin: string | null = null
    let response: Response
    try {
      if (!isApi) response = await page(request, env, url)
      else {
        origin = allowedOrigin(request, env, url)
        if (request.method === 'OPTIONS') {
          response = new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': isMcp ? 'POST, OPTIONS' : 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, Range, X-Mono-Client, X-Upload-Token, X-Object-Meta-Label, MCP-Protocol-Version, MCP-Session-Id', 'Access-Control-Max-Age': '600' } })
        } else response = isMcp ? await mcp(request, env, url) : await api(request, env, url)
      }
    } catch (error) {
      if (!isApi && error instanceof ApiError && error.status === 404) response = notFound()
      else if (error instanceof ApiError) response = json({ error: { code: error.code, message: error.message }, ...(error instanceof LoginRateLimitError ? { retryAfter: error.retryAfter } : {}) }, error.status, error instanceof LoginRateLimitError ? { 'Retry-After': String(error.retryAfter) } : undefined)
      else {
        console.error('Storage operation failed:', error instanceof Error ? error.message : 'Unknown error')
        response = json({ error: { code: 'STORAGE_ERROR', message: '存储操作失败，请稍后重试。' } }, 500)
      }
    }
    const headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'no-referrer')
    if (isMcp && response.status === 401) headers.set('WWW-Authenticate', 'Bearer realm="MONO MCP"')
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Access-Control-Allow-Credentials', 'true')
      headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Last-Modified, Retry-After')
      headers.append('Vary', 'Origin')
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
} satisfies ExportedHandler<Env>
