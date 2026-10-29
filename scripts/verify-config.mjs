import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8788')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || target.port === '8787') throw new Error('Configuration verification requires an isolated localhost Worker; the normal port 8787 is prohibited.')
const origin = target.origin
const endpoint = `${origin}/api/config`
let token = `mono_config_verify_${randomBytes(24).toString('hex')}`
let cookie = ''
let etag = ''
let config
let passed = 0
const objectKey = `verify-config-${randomUUID()}.txt`
const objectUrl = `${origin}/api/buckets/workspace/object?${new URLSearchParams({ key: objectKey })}`
let objectCreated = false
let shareId = ''
let previousToken = ''
let previousCookie = ''
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`) }
async function authenticated(url, init = {}) { return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'X-Mono-Client': 'web', ...init.headers } }) }
async function patch(body, expected = etag, init = {}) {
  return authenticated(endpoint, { method: 'PATCH', ...init, headers: { 'Content-Type': 'application/json', ...(expected ? { 'If-Match': expected } : {}), ...init.headers }, body: JSON.stringify(body) })
}
async function read() {
  const response = await authenticated(endpoint)
  assert.equal(response.status, 200)
  etag = response.headers.get('ETag')
  config = (await response.json()).config
  return config
}
async function cookieSession(value) { return fetch(`${origin}/api/session`, { headers: { Cookie: value } }).then(response => response.json()) }
const weakRevision = value => `W/${value.replace(/^W\//, '')}`
try {
  await check('Refuse to modify an existing workspace; initialize disposable empty storage', async () => {
    assert.deepEqual(await fetch(`${origin}/api/session`).then(response => response.json()), { authenticated: false })
    const status = await fetch(`${origin}/api/setup`).then(response => response.json())
    assert.deepEqual(Object.keys(status), ['setupRequired'])
    assert.equal(status.setupRequired, true, 'Use --persist-to with a NEW isolated storage directory; this script refuses existing configurations.')
    const setup = await authenticated(`${origin}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '配置验证工作空间', adminPath: '/console', apiToken: token }) })
    assert.equal(setup.status, 201)
    cookie = setup.headers.get('Set-Cookie').split(';')[0]
    await read()
    assert.equal(config.displayName, '配置验证工作空间')
    assert.equal(config.adminPath, '/console')
    assert.ok(etag)
    assert.deepEqual(Object.keys(config).sort(), ['adminPath', 'createdAt', 'displayName', 'loginRateLimit', 'updatedAt'])
    assert.deepEqual(config.loginRateLimit, { maxAttempts: 10, windowSeconds: 60 })
  })
  await check('Config reads and writes require authentication and mutation source marker', async () => {
    assert.equal((await fetch(endpoint)).status, 401)
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '未认证修改' }) })).status, 401)
    const response = await fetch(endpoint, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '缺少来源标记' }) })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'CSRF_PROTECTION')
    assert.equal((await authenticated(endpoint, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403)
    const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: target.origin, 'Access-Control-Request-Method': 'PATCH' } })
    assert.equal(preflight.status, 204)
    assert.ok(preflight.headers.get('Access-Control-Allow-Methods').includes('PATCH'))
  })
  await check('Reject invalid fields, reserved routes, short names and invalid tokens without changing stored settings', async () => {
    const original = { ...config }
    for (const body of [{}, { unexpected: true }, { apiTokenHash: 'x' }, { displayName: 42 }, { displayName: '一' }, { adminPath: '/api' }, { adminPath: '/assets' }, { adminPath: '/s' }, { adminPath: '/console//files' }, { adminPath: 4 }, { apiToken: null }, { apiToken: 'short' }, { apiToken: 'x'.repeat(257) }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body))
    }
    assert.deepEqual(await read(), original)
  })
  await check('Login rate policy is bounded, versioned and retained through later configuration edits', async () => {
    const original = { ...config.loginRateLimit }
    for (const loginRateLimit of [null, false, {}, { maxAttempts: 0, windowSeconds: 60 }, { maxAttempts: 101, windowSeconds: 60 }, { maxAttempts: 10, windowSeconds: 9 }, { maxAttempts: 10, windowSeconds: 3601 }, { maxAttempts: 10, windowSeconds: 60, enabled: false }]) {
      assert.equal((await patch({ loginRateLimit })).status, 400)
    }
    assert.deepEqual((await read()).loginRateLimit, original)
    const stale = etag
    const changed = await patch({ loginRateLimit: { maxAttempts: 7, windowSeconds: 45 } })
    assert.equal(changed.status, 200)
    const body = await changed.json()
    assert.equal(body.config.loginRateLimitVersion, undefined)
    await read()
    assert.deepEqual(config.loginRateLimit, { maxAttempts: 7, windowSeconds: 45 })
    assert.equal((await patch({ loginRateLimit: original }, stale)).status, 409)
    assert.deepEqual((await read()).loginRateLimit, { maxAttempts: 7, windowSeconds: 45 })
    assert.equal((await patch({ loginRateLimit: original })).status, 200)
    await read()
  })
  await check('Create a share before updating configuration', async () => {
    assert.equal((await authenticated(objectUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'configuration verification' })).status, 201)
    objectCreated = true
    const response = await authenticated(`${origin}/api/buckets/workspace/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: objectKey, expiresIn: 3600 }) })
    assert.equal(response.status, 201)
    shareId = (await response.json()).id
    assert.equal((await fetch(`${origin}/api/shares/${shareId}`)).status, 200)
  })
  await check('Persist name/path edits, preserve creation time, keep existing sessions and shares', async () => {
    const createdAt = config.createdAt
    const response = await patch({ displayName: '修改后的工作空间', adminPath: '/new-console' })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.apiToken, undefined)
    etag = response.headers.get('ETag')
    assert.ok(response.headers.get('Set-Cookie'))
    await read()
    assert.equal(config.createdAt, createdAt)
    assert.equal(config.displayName, '修改后的工作空间')
    assert.equal(config.adminPath, '/new-console')
    assert.equal((await cookieSession(cookie)).authenticated, true)
    assert.equal((await fetch(`${origin}/api/shares/${shareId}`)).status, 200)
    assert.equal((await fetch(`${origin}/console`, { redirect: 'manual' })).status, 404)
    assert.equal((await fetch(`${origin}/new-console`, { redirect: 'manual' })).status, 200)
    assert.equal((await fetch(`${origin}/`, { redirect: 'manual' })).status, 200)
  })
  await check('Public setup and session continue hiding private configuration', async () => {
    for (const path of ['/api/session', '/api/setup']) {
      const result = await fetch(`${origin}${path}`).then(response => response.json())
      assert.deepEqual(result, path === '/api/session' ? { authenticated: false } : { setupRequired: false })
    }
  })
  await check('Compression-weakened configuration revisions are accepted, while stale or malformed revisions cannot overwrite saved settings', async () => {
    const stale = etag
    const before = { ...config }
    const accepted = await patch({ displayName: '弱修订验证工作空间' }, weakRevision(etag))
    assert.equal(accepted.status, 200)
    assert.match(accepted.headers.get('Cache-Control') || '', /(?:^|,)\s*no-transform(?:,|$)/)
    const result = await accepted.json()
    assert.equal(result.apiToken, undefined)
    await read()
    assert.equal(config.displayName, '弱修订验证工作空间')
    assert.equal(config.createdAt, before.createdAt)
    assert.equal(config.adminPath, before.adminPath)
    const saved = { ...config }
    const savedRevision = etag
    for (const expected of [weakRevision(stale), 'W/*', `${etag}, ${etag}`]) {
      const rejected = await patch({ displayName: '不应覆盖的弱修订' }, expected)
      assert.equal(rejected.status, 409)
      assert.equal((await rejected.json()).error.code, 'CONFIG_CONFLICT')
    }
    assert.deepEqual(await read(), saved)
    assert.equal(etag, savedRevision)
  })
  await check('An omitted token stays unchanged; stale edits and concurrent saves cannot overwrite a newer revision', async () => {
    const stale = etag
    assert.equal((await patch({ displayName: '新的修订版本' })).status, 200)
    await read()
    const rejected = await patch({ displayName: '过期编辑' }, stale)
    assert.equal(rejected.status, 409)
    assert.equal((await rejected.json()).error.code, 'CONFIG_CONFLICT')
    assert.equal((await read()).displayName, '新的修订版本')
    const sameRevision = etag
    const responses = await Promise.all([patch({ displayName: '并发版本甲' }, sameRevision), patch({ displayName: '并发版本乙' }, sameRevision)])
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
    await read()
    assert.ok(['并发版本甲', '并发版本乙'].includes(config.displayName))
  })
  await check('Custom token rotation rejects old credentials and shares, while the saving browser receives a valid session', async () => {
    const oldToken = token
    const oldCookie = cookie
    previousToken = oldToken
    previousCookie = oldCookie
    const sameToken = await patch({ apiToken: token })
    assert.equal(sameToken.status, 400)
    assert.equal((await sameToken.json()).error.code, 'UNCHANGED_API_TOKEN')
    const next = `mono_rotated_verify_${randomBytes(24).toString('hex')}`
    const response = await patch({ apiToken: next })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.apiToken, next)
    assert.equal(result.config.apiTokenHash, undefined)
    cookie = response.headers.get('Set-Cookie').split(';')[0]
    token = next
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401)
    assert.equal((await cookieSession(oldCookie)).authenticated, false)
    assert.equal((await cookieSession(cookie)).authenticated, true)
    assert.equal((await fetch(`${origin}/api/shares/${shareId}`)).status, 404)
    await read()
  })
  await check('Reusing a historical token never revives old cookie sessions or old shares', async () => {
    const retiredCookie = cookie
    const response = await patch({ apiToken: previousToken })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.apiToken, previousToken)
    cookie = response.headers.get('Set-Cookie').split(';')[0]
    token = previousToken
    assert.equal((await cookieSession(cookie)).authenticated, true)
    assert.equal((await cookieSession(previousCookie)).authenticated, false)
    assert.equal((await cookieSession(retiredCookie)).authenticated, false)
    assert.equal((await fetch(`${origin}/api/shares/${shareId}`)).status, 404)
    await read()
  })
  await check('Empty token requests a random replacement; plaintext appears only in the rotation response', async () => {
    const oldToken = token
    const response = await patch({ apiToken: '' })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.match(result.apiToken, /^mono_[A-Za-z0-9_-]+$/)
    assert.ok(result.apiToken.length >= 24)
    assert.notEqual(result.apiToken, oldToken)
    cookie = response.headers.get('Set-Cookie').split(';')[0]
    token = result.apiToken
    assert.equal((await cookieSession(cookie)).authenticated, true)
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401)
    const reread = await authenticated(endpoint).then(response => response.json())
    assert.equal(reread.apiToken, undefined)
    assert.equal(reread.apiTokenHash, undefined)
    assert.equal(reread.config.apiToken, undefined)
    assert.equal(reread.config.apiTokenHash, undefined)
  })
  console.log(`${passed} configuration verification scenarios passed.`)
} finally {
  if (objectCreated) {
    const cleanup = await authenticated(objectUrl, { method: 'DELETE' })
    if (cleanup.status !== 204 && cleanup.status !== 404) throw new Error(`Failed to clean disposable object: ${cleanup.status}`)
  }
}
