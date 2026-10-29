import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

// 仅支持全新本地隔离 Worker，禁止访问开发端口或远程站点。
const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8794')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || target.port === '8787') throw new Error('Security verification requires a fresh isolated localhost Worker; port 8787 is prohibited.')
const origin = target.origin
const administrator = process.env.MONO_API_TOKEN || `mono_security_${randomBytes(24).toString('hex')}`
const bucket = process.env.MONO_BUCKET || 'workspace'
assert.match(bucket, /^[a-z0-9][a-z0-9_-]{0,62}$/)
const prefix = `verify-security-${randomUUID()}/`
const privateName = `Security ${randomUUID()}`
const privatePath = `/security-${randomBytes(8).toString('hex')}`
const files = new Set()
const shareKeys = new Set()
const tokens = []
let cookie = ''
let configETag = ''
let registryETag = ''
let config
let originalPolicy
let passed = 0
let initialized = false
const fullPermissions = ['read', 'write', 'delete', 'create_folder', 'delete_folder', 'share']
const object = key => `/api/buckets/${bucket}/object?${new URLSearchParams({ key })}`
const sharePath = key => `/api/buckets/${bucket}/shares?${new URLSearchParams({ key })}`
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function call(route, auth = null, init = {}) {
  const url = new URL(route, origin)
  assert.equal(url.origin, origin, 'Security requests must remain inside the disposable localhost instance.')
  const headers = new Headers(init.headers)
  headers.set('X-Mono-Client', 'web')
  if (auth === 'cookie') headers.set('Cookie', cookie)
  else if (auth) headers.set('Authorization', `Bearer ${auth}`)
  return fetch(url, { ...init, headers, redirect: 'manual', signal: init.signal || AbortSignal.timeout(30_000) })
}

async function expect(response, status, label = 'Security request') {
  if (response.status !== status) {
    let code = ''
    try { code = (await response.clone().json()).error?.code || '' } catch {}
    assert.fail(`${label}: expected ${status}, received ${response.status}${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`)
  }
  return response
}

function privateAbsent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const privateValue of [administrator, cookie, privateName, privatePath, ...tokens.map(token => token.secret)].filter(Boolean)) assert.ok(!text.includes(privateValue), 'Anonymous and API-guide responses must not expose credentials or administrator settings.')
  assert.doesNotMatch(text, /INITIAL_SETUP_TOKEN|SESSION_SECRET|_mono\/system-config\.json|"(?:tokenHash|apiTokenHash|credentialVersion|loginRateLimitVersion|fingerprint)"\s*:/)
}

async function check(label, run) { await run(); passed++; console.log(`PASS ${label}`) }

async function readConfig() {
  const response = await expect(await call('/api/config', 'cookie'), 200)
  configETag = response.headers.get('ETag')
  assert.ok(configETag)
  const body = await response.json()
  config = body.config
  assert.equal(body.apiToken, undefined)
  assert.equal(config.loginRateLimitVersion, undefined)
  return config
}

async function patchPolicy(policy, revision = configETag, auth = 'cookie') {
  return call('/api/config', auth, { method: 'PATCH', ...json({ loginRateLimit: policy }), headers: { 'Content-Type': 'application/json', 'If-Match': revision } })
}

async function setPolicy(policy) {
  const response = await expect(await patchPolicy(policy), 200, 'Update isolated login policy')
  configETag = response.headers.get('ETag')
  await readConfig()
  assert.deepEqual(config.loginRateLimit, policy)
}

async function createToken(name, scope, permissions) {
  const listing = await expect(await call('/api/tokens', administrator), 200)
  registryETag = listing.headers.get('ETag')
  const response = await expect(await call('/api/tokens', administrator, { method: 'POST', ...json({ name, scope, permissions }), headers: { 'Content-Type': 'application/json', 'If-Match': registryETag } }), 201)
  registryETag = response.headers.get('ETag')
  const result = await response.json()
  const token = { ...result.token, secret: result.secret }
  tokens.push(token)
  return token
}

async function put(key, content = 'hello-世界', overwrite = false) {
  await expect(await call(`${object(key)}${overwrite ? '&overwrite=true' : ''}`, administrator, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Object-Meta-secret': 'private metadata' }, body: content }), 201)
  files.add(key)
}

async function createShare(key, expiresIn = null) {
  const response = await expect(await call(`/api/buckets/${bucket}/shares`, administrator, { method: 'POST', ...json({ key, expiresIn }) }), 201)
  shareKeys.add(key)
  return response.json()
}

async function login(token, headers = {}) { return call('/api/session', null, { method: 'POST', ...json({ token }), headers: { 'Content-Type': 'application/json', ...headers } }) }

async function limited(response, maxSeconds = 60) {
  await expect(response, 429, 'Rolling login or setup limit')
  const body = await response.json()
  assert.equal(body.error.code, 'LOGIN_RATE_LIMITED')
  assert.ok(Number.isInteger(body.retryAfter) && body.retryAfter >= 1 && body.retryAfter <= maxSeconds)
  assert.equal(response.headers.get('Retry-After'), String(body.retryAfter))
  assert.match(response.headers.get('Cache-Control') || '', /no-store/)
  assert.equal(response.headers.get('Set-Cookie'), null)
  privateAbsent(body)
  return body.retryAfter
}

async function directoryFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) result.push(...await directoryFiles(url))
    else result.push(url)
  }
  return result
}

let managed, exactToken, activeShare, replacementShare
let resumedAt = 0
let blockedRetry = 0

try {
  await check('Anonymous health, session and setup expose only their minimal contract before installation', async () => {
    assert.deepEqual(await (await expect(await call('/api/health'), 200)).json(), { ok: true })
    assert.deepEqual(await (await expect(await call('/api/session'), 200)).json(), { authenticated: false })
    assert.deepEqual(await (await expect(await call('/api/setup'), 200)).json(), { setupRequired: true }, 'Use a fresh dedicated persistence directory for security and rate-limit checks.')
    for (const route of ['/api/config', '/api/tokens', '/api/shares', '/api/panel', '/api/mcp/guide']) {
      const response = await expect(await call(route), 401)
      privateAbsent(await response.text())
    }
    await expect(await call('/api/mcp/guide', null, { method: 'HEAD' }), 401)
    const front = await expect(await call('/'), 200)
    privateAbsent(await front.text())
  })

  await check('One-time installation needs no setup key and the fixed setup budget rejects the fourth attempt', async () => {
    const response = await expect(await call('/api/setup', null, { method: 'POST', ...json({ displayName: privateName, adminPath: privatePath, apiToken: administrator }) }), 201)
    const body = await response.json()
    assert.equal(body.authenticated, true)
    assert.equal(body.local, true)
    assert.equal(body.setupTokenRequired, false)
    assert.equal(body.apiToken, administrator)
    cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
    assert.ok(cookie)
    initialized = true
    await readConfig()
    originalPolicy = { ...config.loginRateLimit }
    assert.deepEqual(originalPolicy, { maxAttempts: 10, windowSeconds: 60 })
    const repeats = await Promise.all([call('/api/setup', null, { method: 'POST', ...json({}) }), call('/api/setup', null, { method: 'POST', ...json({}) })])
    for (const repeat of repeats) { await expect(repeat, 409); privateAbsent(await repeat.text()) }
    await limited(await call('/api/setup', null, { method: 'POST', ...json({}) }))
    await setPolicy({ maxAttempts: 100, windowSeconds: 10 })
  })

  await check('Anonymous responses stay minimal after setup and explicit bad authorization cannot fall back to a cookie', async () => {
    assert.deepEqual(await (await expect(await call('/api/session'), 200)).json(), { authenticated: false })
    assert.deepEqual(await (await expect(await call('/api/setup'), 200)).json(), { setupRequired: false })
    assert.deepEqual(await (await expect(await call('/api/health'), 200)).json(), { ok: true })
    const invalid = await expect(await call('/api/session', 'invalid-bearer', { headers: { Cookie: cookie } }), 200)
    assert.deepEqual(await invalid.json(), { authenticated: false })
    managed = await createToken('Security storage grant', { type: 'all' }, fullPermissions)
    await expect(await call('/api/config', managed.secret), 403)
    await expect(await call('/api/tokens', managed.secret), 403)
    assert.deepEqual(await (await expect(await call('/api/session', managed.secret), 200)).json(), { authenticated: false })
    for (const route of ['/api/config', '/api/tokens', '/api/shares', '/api/panel', '/api/mcp/guide']) {
      const response = await expect(await call(route), 401)
      privateAbsent(await response.text())
    }
  })

  await check('Guide reads authenticate administrator sessions and return scope-specific instructions to API tokens', async () => {
    const key = `${prefix}active.txt`
    await put(key)
    exactToken = await createToken('Security exact read', { type: 'file', bucket, key }, ['read'])
    for (const auth of ['cookie', administrator]) {
      const response = await expect(await call('/api/mcp/guide', auth), 200)
      assert.match(response.headers.get('Content-Type') || '', /text\/markdown/)
      assert.match(response.headers.get('Cache-Control') || '', /no-store/)
      const text = await response.text()
      assert.match(text, /MCP 路径：\/mcp/)
      assert.ok(!text.includes(origin), 'Guides use relative paths instead of the connected origin.')
      privateAbsent(text)
    }
    const scoped = await expect(await call('/api/mcp/guide', exactToken.secret), 200)
    const text = await scoped.text()
    assert.ok(text.includes('单文件授权') && text.includes(key))
    assert.match(text, /MCP 路径：\/mcp/)
    assert.ok(!text.includes(origin), 'Scoped guides use relative paths instead of the connected origin.')
    privateAbsent(text)
    await expect(await call('/api/mcp/guide', 'invalid-bearer', { headers: { Cookie: cookie } }), 401)
    const head = await expect(await call('/api/mcp/guide', 'cookie', { method: 'HEAD' }), 200)
    assert.equal(await head.text(), '')
  })

  await check('Public JavaScript omits administrator/API implementations and every private asset requires administrator access', async () => {
    const publicFiles = await directoryFiles(new URL('../dist/assets/', import.meta.url))
    const javascript = publicFiles.filter(file => /\.(?:m?js)$/.test(file.pathname))
    assert.ok(javascript.length)
    const prohibited = /\/api\/(?:config|tokens)\b|mono_api_guide|mono_get_access_info|mcpServers|--data-binary|版本\s*1\.0\.0|INITIAL_SETUP_TOKEN|SESSION_SECRET/
    for (const file of javascript) {
      const source = await readFile(file, 'utf8')
      assert.doesNotMatch(source, prohibited, 'Public code must contain only sharing, login and minimal setup functionality.')
      const relative = file.pathname.slice(new URL('../dist/assets/', import.meta.url).pathname.length)
      const response = await expect(await call(`/assets/${relative}`), 200)
      assert.doesNotMatch(await response.text(), prohibited)
    }
    const privateBase = new URL('../dist/api/panel-assets/', import.meta.url)
    const privateFiles = await directoryFiles(privateBase)
    assert.ok(privateFiles.some(file => file.pathname.endsWith('.js')), 'The administrator implementation must be emitted separately.')
    const discovery = await expect(await call('/api/panel', 'cookie'), 200)
    const panel = await discovery.json()
    assert.deepEqual(Object.keys(panel), ['entry'])
    assert.match(panel.entry, /^\/api\/panel-assets\/console-[a-zA-Z0-9_-]+\.js$/)
    await expect(await call('/api/panel', managed.secret), 403)
    for (const file of privateFiles) {
      const relative = file.pathname.slice(privateBase.pathname.length)
      const route = `/api/panel-assets/${relative}`
      await expect(await call(route), 401)
      await expect(await call(route, managed.secret), 403)
      await expect(await call(route, 'invalid-bearer', { headers: { Cookie: cookie } }), 401)
      const privateResponse = await expect(await call(route, 'cookie'), 200)
      assert.match(privateResponse.headers.get('Cache-Control') || '', /no-store/)
      assert.deepEqual(Buffer.from(await privateResponse.arrayBuffer()), Buffer.from(await readFile(file)))
      for (const auth of ['cookie', administrator]) {
        const head = await expect(await call(route, auth, { method: 'HEAD' }), 200)
        assert.match(head.headers.get('Cache-Control') || '', /private/)
        assert.match(head.headers.get('Cache-Control') || '', /no-store/)
        assert.equal(await head.text(), '')
      }
      await expect(await call(route, null, { method: 'HEAD' }), 401)
      await expect(await call(route, managed.secret, { method: 'HEAD' }), 403)
      await expect(await call(route, 'invalid-bearer', { method: 'HEAD', headers: { Cookie: cookie } }), 401)
      for (const bypass of [`/private/${relative}`, `/assets/${relative}`]) await expect(await call(bypass), 404)
    }
    for (const bypass of ['/api/panel-assets/%2e%2e%2findex.html', '/api/panel-assets/%2e%2e%5cindex.html']) await expect(await call(bypass, 'cookie'), 404)
  })

  await check('Administrator share overview filters expired, revoked, overwritten, deleted and replaced links', async () => {
    activeShare = await createShare(`${prefix}active.txt`)
    const replacementKey = `${prefix}replacement.txt`
    await put(replacementKey)
    const replacedShare = await createShare(replacementKey)
    replacementShare = await createShare(replacementKey, 3600)
    const revokedKey = `${prefix}revoked.txt`
    await put(revokedKey)
    await createShare(revokedKey)
    await expect(await call(sharePath(revokedKey), administrator, { method: 'DELETE' }), 204)
    const overwrittenKey = `${prefix}overwritten.txt`
    await put(overwrittenKey)
    await createShare(overwrittenKey)
    await put(overwrittenKey, 'hello-世界', true)
    const deletedKey = `${prefix}deleted.txt`
    await put(deletedKey)
    await createShare(deletedKey)
    await expect(await call(object(deletedKey), administrator, { method: 'DELETE' }), 204)
    const expiredKey = `${prefix}expired.txt`
    await put(expiredKey)
    const expired = await createShare(expiredKey, 1)
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expired.expiresAt) - Date.now()) + 30))
    await expect(await call('/api/shares'), 401)
    await expect(await call('/api/shares', managed.secret), 403)
    const found = []
    const seen = new Set()
    let cursor
    for (let page = 0; page < 20; page++) {
      const response = await expect(await call(`/api/shares${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`, 'cookie'), 200)
      const body = await response.json()
      assert.deepEqual(Object.keys(body).sort(), ['cursor', 'shares', 'truncated'])
      for (const share of body.shares) {
        assert.deepEqual(Object.keys(share).sort(), ['bucket', 'contentType', 'createdAt', 'expiresAt', 'id', 'key', 'size', 'uploaded', 'url'])
        assert.ok(share.key.startsWith(prefix))
        assert.ok(!JSON.stringify(share).includes('private metadata'))
        found.push(share.id)
      }
      if (!body.truncated) { cursor = undefined; break }
      assert.ok(body.cursor && !seen.has(body.cursor))
      seen.add(body.cursor)
      cursor = body.cursor
    }
    assert.equal(cursor, undefined)
    assert.deepEqual(found.sort(), [activeShare.id, replacementShare.id].sort())
    assert.ok(!found.includes(replacedShare.id))
    await expect(await call('/api/shares?cursor=bad%0Anext', administrator), 400)
  })

  await check('Public share pages retain limited metadata, download, HEAD and Range with no authorization fallback', async () => {
    await expect(await call(activeShare.url), 200)
    const response = await expect(await call(`/api/shares/${activeShare.id}`), 200)
    const info = await response.json()
    assert.equal(info.object.key, 'active.txt')
    assert.deepEqual(info.object.metadata, {})
    assert.equal(info.bucket, undefined)
    assert.equal(info.adminPath, undefined)
    const head = await expect(await call(info.downloadUrl, null, { method: 'HEAD' }), 200)
    assert.equal(Number(head.headers.get('Content-Length')), Buffer.byteLength('hello-世界'))
    const range = await expect(await call(info.previewUrl, null, { headers: { Range: 'bytes=0-4' } }), 206)
    assert.equal(await range.text(), 'hello')
    await expect(await call(`/api/shares/${replacementShare.id}`, exactToken.secret), 403)
    await expect(await call(info.downloadUrl, 'invalid-bearer', { headers: { Cookie: cookie } }), 401)
    await expect(await call(`/api/shares/${'f'.repeat(32)}`), 404)
  })

  await check('Login policy changes are bounded, administrator-only, conditional and omit the internal version', async () => {
    await readConfig()
    await expect(await patchPolicy({ maxAttempts: 2, windowSeconds: 10 }, configETag, null), 401)
    await expect(await patchPolicy({ maxAttempts: 2, windowSeconds: 10 }, configETag, managed.secret), 403)
    const before = { ...config }
    for (const policy of [null, false, {}, { maxAttempts: 0, windowSeconds: 10 }, { maxAttempts: 101, windowSeconds: 10 }, { maxAttempts: 1.5, windowSeconds: 10 }, { maxAttempts: 2, windowSeconds: 9 }, { maxAttempts: 2, windowSeconds: 3601 }, { maxAttempts: 2, windowSeconds: 10, enabled: false }]) await expect(await patchPolicy(policy), 400)
    assert.deepEqual(await readConfig(), before)
    const stale = configETag
    await setPolicy({ maxAttempts: 4, windowSeconds: 10 })
    await expect(await patchPolicy({ maxAttempts: 100, windowSeconds: 60 }, stale), 409)
    assert.deepEqual((await readConfig()).loginRateLimit, { maxAttempts: 4, windowSeconds: 10 })
    const injectVersion = await call('/api/config', 'cookie', { method: 'PATCH', ...json({ loginRateLimitVersion: 0 }), headers: { 'Content-Type': 'application/json', 'If-Match': configETag } })
    await expect(injectVersion, 400)
    await new Promise(resolve => setTimeout(resolve, 10_100))
  })

  await check('Valid Bearer checks do not consume attempts while GET guesses, POST login and correct Bearer share the same blocking budget', async () => {
    for (let repeat = 0; repeat < 5; repeat++) {
      for (const route of ['/api/session', '/api/config', '/api/panel']) await expect(await call(route, administrator), 200)
      await expect(await call(object(`${prefix}active.txt`), exactToken.secret, { method: 'HEAD' }), 200)
    }
    const success = await expect(await login(administrator), 200)
    const state = await success.json()
    assert.equal(state.authenticated, true)
    assert.equal(state.apiToken, undefined)
    cookie = success.headers.get('Set-Cookie')?.split(';')[0] || cookie
    assert.deepEqual(await (await expect(await call('/api/session', 'incorrect-session-get'), 200)).json(), { authenticated: false })
    await expect(await login('incorrect-credential'), 401)
    await expect(await call('/api/config', 'incorrect-config-get'), 401)
    await limited(await call('/api/panel', 'incorrect-panel-get'), 10)
    for (const route of ['/api/session', '/api/config', '/api/panel']) await limited(await call(route, administrator), 10)
    await limited(await call(object(`${prefix}active.txt`), exactToken.secret), 10)
    const blockedHead = await expect(await call(object(`${prefix}active.txt`), exactToken.secret, { method: 'HEAD' }), 429)
    assert.ok(Number(blockedHead.headers.get('Retry-After')) >= 1 && Number(blockedHead.headers.get('Retry-After')) <= 10)
    assert.equal(await blockedHead.text(), '')
    await limited(await login(administrator, { 'X-Forwarded-For': '192.0.2.1' }), 10)
    await limited(await login(administrator, { 'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '203.0.113.2' }), 10)
    await limited(await call('/api/config', 'incorrect-spoofed-get', { headers: { 'CF-Connecting-IP': '198.51.100.4', 'X-Forwarded-For': '203.0.113.9' } }), 10)
    assert.equal((await (await expect(await call('/api/session', 'cookie'), 200)).json()).authenticated, true)
    await readConfig()
  })

  await check('Widening and tightening policies take effect without deleting accepted attempt history', async () => {
    await setPolicy({ maxAttempts: 5, windowSeconds: 10 })
    await expect(await login(administrator), 200)
    await limited(await login('incorrect-after-widening'), 10)
    await setPolicy({ maxAttempts: 1, windowSeconds: 10 })
    blockedRetry = await limited(await login(administrator), 10)
  })

  await check('The rolling deadline restores login access after the advertised retry interval', async () => {
    await new Promise(resolve => setTimeout(resolve, blockedRetry * 1000 + 100))
    const success = await expect(await login(administrator), 200)
    resumedAt = Date.now()
    cookie = success.headers.get('Set-Cookie')?.split(';')[0] || cookie
  })

  await check('Concurrent attempts atomically consume the remaining configured budget', async () => {
    await setPolicy({ maxAttempts: 4, windowSeconds: 10 })
    assert.ok(Date.now() - resumedAt < 5000, 'Concurrency verification must occur inside the active rolling window.')
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => login(`incorrect-parallel-${index}`)))
    assert.equal(responses.filter(response => response.status === 401).length, 3)
    assert.equal(responses.filter(response => response.status === 429).length, 5)
    for (const response of responses.filter(item => item.status === 429)) await limited(response, 10)
  })

  console.log(`\n${passed} security verification scenarios passed.`)
} finally {
  let leftovers = 0
  if (initialized) {
    if (originalPolicy) {
      try { await readConfig(); await setPolicy(originalPolicy) } catch { leftovers++ }
    }
    for (const key of shareKeys) {
      const response = await call(sharePath(key), 'cookie', { method: 'DELETE' }).catch(() => null)
      if (response?.status !== 204) leftovers++
    }
    if (files.size) {
      const response = await call(`/api/buckets/${bucket}/objects`, 'cookie', { method: 'DELETE', ...json({ keys: [...files] }) }).catch(() => null)
      if (!response?.ok) leftovers++
    }
    if (tokens.length) {
      const registry = await call('/api/tokens', 'cookie').catch(() => null)
      registryETag = registry?.headers.get('ETag') || ''
      for (const token of tokens) {
        const response = await call(`/api/tokens/${token.id}`, 'cookie', { method: 'DELETE', headers: { 'If-Match': registryETag } }).catch(() => null)
        if (response?.status === 204) registryETag = response.headers.get('ETag')
        else leftovers++
      }
    }
  }
  console.log(leftovers ? `Cleanup: ${leftovers} tracked operations remain in the disposable instance.` : 'Cleanup: original policy restored and tracked files, shares and active grants removed; rate counters and revoked records remain in the disposable instance.')
  if (leftovers) process.exitCode = 1
}
