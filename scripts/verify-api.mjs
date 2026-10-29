import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8789')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || target.port === '8787') throw new Error('API verification requires an isolated localhost Worker; the normal port 8787 is prohibited.')
const origin = target.origin
const name = process.env.MONO_BUCKET || 'workspace'
const base = `${origin}/api/buckets/${name}`
const root = `verify-${randomUUID()}/`
const apiToken = process.env.MONO_API_TOKEN || 'mono_local_verification_token_20261028'
const headers = { 'X-Mono-Client': 'web', Authorization: `Bearer ${apiToken}` }
const key = `${root}中文 + #?.txt`
const object = key => `${base}/object?${new URLSearchParams({ key })}`
const tracked = new Set()
const trackedFolders = new Set()
const sharedKeys = new Set()
let passed = 0
let sessionCookie = ''
let adminPath = ''
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`) }
async function call(path, init = {}) { return fetch(path, { ...init, headers: { ...headers, ...init.headers } }) }
async function storageTotals(prefix) {
  const seen = new Set()
  let cursor
  let objectCount = 0
  let totalBytes = 0
  for (let pages = 0; pages < 50; pages++) {
    const params = new URLSearchParams(prefix === undefined ? {} : { prefix })
    if (cursor) params.set('cursor', cursor)
    const response = await call(`${base}/stats${params.size ? `?${params}` : ''}`)
    assert.equal(response.status, 200)
    const page = await response.json()
    assert.deepEqual(Object.keys(page).sort(), ['cursor', 'objectCount', 'totalBytes', 'truncated'])
    assert.ok(Number.isSafeInteger(page.objectCount) && page.objectCount >= 0)
    assert.ok(Number.isSafeInteger(page.totalBytes) && page.totalBytes >= 0)
    assert.equal(typeof page.truncated, 'boolean')
    objectCount += page.objectCount
    totalBytes += page.totalBytes
    if (!page.truncated) {
      assert.equal(page.cursor, null)
      return { objectCount, totalBytes }
    }
    assert.ok(typeof page.cursor === 'string' && page.cursor && !seen.has(page.cursor), 'Statistics pagination must advance to a fresh cursor.')
    seen.add(page.cursor)
    cursor = page.cursor
  }
  assert.fail('Statistics pagination must finish within the isolated fixture bound.')
}
try {
  await check('First-run setup or existing configured workspace', async () => {
    assert.deepEqual(await fetch(`${origin}/api/session`).then(r => r.json()), { authenticated: false })
    const status = await fetch(`${origin}/api/setup`).then(r => r.json())
    assert.deepEqual(Object.keys(status), ['setupRequired'])
    if (status.setupRequired) {
      const setup = () => call(`${origin}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'MONO 本地测试', adminPath: '/console', apiToken }) })
      const results = await Promise.all([setup(), setup()])
      assert.deepEqual(results.map(response => response.status).sort(), [201, 409])
      const response = results.find(response => response.status === 201)
      const config = await response.json()
      assert.equal(config.apiToken, apiToken)
      assert.equal(config.configured, true)
      assert.equal(config.setupRequired, false)
      assert.equal(config.local, true)
      assert.equal(config.setupTokenRequired, false)
      assert.equal(config.adminPath, '/console')
      sessionCookie = response.headers.get('Set-Cookie').split(';')[0]
    }
    const buckets = await call(`${origin}/api/buckets`)
    assert.equal(buckets.status, 200, 'Existing workspace token differs. Set MONO_API_TOKEN to the token saved during setup.')
    adminPath = (await buckets.json()).config.adminPath
  })
  await check('Setup is locked and public session never exposes token', async () => {
    const repeat = await call(`${origin}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(repeat.status, 409)
    const status = await fetch(`${origin}/api/session`).then(r => r.json())
    assert.deepEqual(status, { authenticated: false })
    const publicSetup = await fetch(`${origin}/api/setup`).then(r => r.json())
    assert.deepEqual(publicSetup, { setupRequired: false })
    assert.deepEqual(await fetch(`${origin}/api/health`).then(r => r.json()), { ok: true })
    const invalid = await fetch(`${origin}/api/buckets`, { headers: { Authorization: 'Bearer invalid-token' } })
    assert.equal(invalid.status, 401)
  })
  await check('Panel only opens at its configured path; the public front never redirects there', async () => {
    const front = await fetch(`${origin}/`, { redirect: 'manual' })
    assert.equal(front.status, 200)
    assert.equal(front.headers.get('Location'), null)
    assert.ok(!(await front.text()).includes(adminPath))
    const panel = await fetch(`${origin}${adminPath}`, { redirect: 'manual' })
    assert.equal(panel.status, 200)
    assert.equal(panel.headers.get('Location'), null)
    for (const path of ['/admin', '/index.html', '/not-a-panel', `${adminPath}/`, `${adminPath}/anything`].filter(path => path !== adminPath)) {
      const result = await fetch(`${origin}${path}`, { redirect: 'manual' })
      assert.equal(result.status, 404, path)
      assert.equal(result.headers.get('Location'), null)
      assert.ok(!(await result.text()).includes(adminPath))
    }
  })
  await check('Login establishes a cookie session and logout expires it', async () => {
    const invalid = await call(`${origin}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'incorrect' }) })
    assert.equal(invalid.status, 401)
    const login = await call(`${origin}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: apiToken }) })
    assert.equal(login.status, 200)
    sessionCookie = login.headers.get('Set-Cookie').split(';')[0]
    const session = await fetch(`${origin}/api/session`, { headers: { Cookie: sessionCookie } }).then(r => r.json())
    assert.equal(session.authenticated, true)
    const logout = await fetch(`${origin}/api/session`, { method: 'DELETE', headers: { Cookie: sessionCookie, 'X-Mono-Client': 'web' } })
    assert.equal(logout.status, 200)
    assert.ok(logout.headers.get('Set-Cookie').includes('Max-Age=0'))
  })
  await check('System configuration is hidden and protected across object APIs', async () => {
    const systemKey = '_mono/system-config.json'
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const response = await call(object(systemKey), { method, ...(method === 'PUT' ? { body: '{}' } : {}) })
      assert.equal(response.status, 400)
    }
    const batch = await call(`${base}/objects`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [systemKey] }) })
    assert.equal(batch.status, 400)
    const multipart = await call(`${base}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: systemKey, size: 1 }) })
    assert.equal(multipart.status, 400)
    const folder = await call(`${base}/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '_mono/' }) })
    assert.equal(folder.status, 400)
    for (const params of [{}, { prefix: '_mono/', recursive: 'true' }]) {
      const listing = await call(`${base}/objects?${new URLSearchParams(params)}`).then(r => r.json())
      assert.ok(listing.objects.every(item => !item.key.startsWith('_mono/')))
      assert.ok(listing.folders.every(key => !key.startsWith('_mono/')))
    }
  })
  await check('Create directory marker', async () => {
    const result = await call(`${base}/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: root }) })
    assert.equal(result.status, 201)
  })
  await check('Upload Unicode object path and custom metadata', async () => {
    const result = await call(object(key), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Object-Meta-label': 'verification' }, body: 'hello-世界' })
    assert.equal(result.status, 201, await result.text())
    tracked.add(key)
  })
  await check('List objects and fetch metadata', async () => {
    const listing = await call(`${base}/objects?${new URLSearchParams({ prefix: root })}`).then(r => r.json())
    assert.equal(listing.objects[0].key, key)
    const result = await call(`${object(key)}&metadata=true`).then(r => r.json())
    assert.equal(result.size, Buffer.byteLength('hello-世界'))
    assert.equal(result.metadata.label, 'verification')
  })
  await check('Download exact content and range', async () => {
    const result = await call(object(key))
    assert.equal(await result.text(), 'hello-世界')
    const range = await call(object(key), { headers: { Range: 'bytes=0-4' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'hello')
    const invalid = await call(object(key), { headers: { Range: 'bytes=9999-' } })
    assert.equal(invalid.status, 416)
  })
  const shares = `${base}/shares?${new URLSearchParams({ key })}`
  const createShare = async (expiresIn = 3600, shareKey = key) => {
    const result = await call(`${base}/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: shareKey, expiresIn }) })
    assert.equal(result.status, 201, await result.clone().text())
    sharedKeys.add(shareKey)
    return result.json()
  }
  await check('Sharing requires authentication and validates files, reserved paths and durations', async () => {
    const denied = await fetch(`${base}/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mono-Client': 'web' }, body: JSON.stringify({ key }) })
    assert.equal(denied.status, 401)
    for (const [shareKey, expiresIn, expected] of [[key, 0, 400], ['_mono/system-config.json', 3600, 400], [root + 'missing.txt', 3600, 404]]) {
      const result = await call(`${base}/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: shareKey, expiresIn }) })
      assert.equal(result.status, expected)
    }
    assert.equal((await call(shares).then(r => r.json())).share, null)
  })
  await check('Anonymous share page, metadata, Unicode download, HEAD and Range', async () => {
    const share = await createShare()
    assert.match(share.id, /^[a-f0-9]{32}$/)
    assert.equal((await call(shares).then(r => r.json())).share.id, share.id)
    const page = await fetch(`${origin}${share.url}`, { redirect: 'manual' })
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('Location'), null)
    const info = await fetch(`${origin}/api/shares/${share.id}`).then(r => r.json())
    assert.equal(info.object.key, '中文 + #?.txt')
    assert.deepEqual(info.object.metadata, {})
    assert.equal(info.adminPath, undefined)
    assert.equal(info.bucket, undefined)
    assert.equal(await fetch(`${origin}${info.downloadUrl}`).then(r => r.text()), 'hello-世界')
    const head = await fetch(`${origin}${info.downloadUrl}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.ok(head.headers.get('Content-Disposition').includes("filename*=UTF-8''"))
    assert.ok(head.headers.get('Cache-Control').includes('no-store'))
    const range = await fetch(`${origin}${info.previewUrl}`, { headers: { Range: 'bytes=0-4' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'hello')
    assert.equal((await fetch(`${origin}/s/${'0'.repeat(32)}/file`)).status, 404)
    assert.equal((await fetch(`${origin}/api/buckets`, { headers: { Authorization: `Bearer ${share.id}` } })).status, 401)
  })
  await check('New share links invalidate earlier links; permanent links can be revoked', async () => {
    const old = (await call(shares).then(r => r.json())).share
    const permanent = await createShare(null)
    assert.equal(permanent.expiresAt, null)
    assert.equal((await fetch(`${origin}/api/shares/${old.id}`)).status, 404)
    assert.equal((await fetch(`${origin}${permanent.url}/file`)).status, 200)
    assert.equal((await call(shares, { method: 'DELETE' })).status, 204)
    assert.equal((await call(shares).then(r => r.json())).share, null)
    assert.equal((await fetch(`${origin}/api/shares/${permanent.id}`)).status, 404)
    assert.equal((await fetch(`${origin}${permanent.url}/file`, { headers: { 'If-None-Match': '*' } })).status, 404)
  })
  await check('Expired links deny both metadata and file access', async () => {
    const share = await createShare(1)
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(share.expiresAt) - Date.now()) + 30))
    assert.equal((await fetch(`${origin}/api/shares/${share.id}`)).status, 404)
    assert.equal((await fetch(`${origin}${share.url}/file`)).status, 404)
    assert.equal((await call(shares).then(r => r.json())).share, null)
  })
  await check('Overwriting even identical bytes invalidates the old file share', async () => {
    const share = await createShare()
    assert.equal((await call(`${object(key)}&overwrite=true`, { method: 'PUT', body: 'hello-世界' })).status, 201)
    assert.equal((await fetch(`${origin}${share.url}/file`)).status, 404)
    assert.equal((await call(shares).then(r => r.json())).share, null)
  })
  await check('Reject duplicate upload, allow explicit overwrite', async () => {
    const duplicate = await call(object(key), { method: 'PUT', body: 'wrong' })
    assert.equal(duplicate.status, 409)
    const replacement = await call(`${object(key)}&overwrite=true`, { method: 'PUT', body: 'replaced' })
    assert.equal(replacement.status, 201)
    assert.equal(await call(object(key)).then(r => r.text()), 'replaced')
  })
  await check('Conditional replacement and cache validation', async () => {
    const head = await call(object(key), { method: 'HEAD' })
    const etag = head.headers.get('ETag')
    assert.equal(head.status, 200)
    const unchanged = await call(object(key), { headers: { 'If-None-Match': etag } })
    assert.equal(unchanged.status, 304)
    const incorrect = await call(`${object(key)}&overwrite=true`, { method: 'PUT', headers: { 'If-Match': 'incorrect-etag' }, body: 'bad' })
    assert.equal(incorrect.status, 409)
  })
  await check('Reject invalid paths and nonempty folder deletion', async () => {
    const invalid = await call(object(`${root}../invalid.txt`), { method: 'PUT', body: 'bad' })
    assert.equal(invalid.status, 400)
    const folder = await call(`${base}/folders?${new URLSearchParams({ key: root })}`, { method: 'DELETE' })
    assert.equal(folder.status, 409)
  })
  await check('Pagination and recursive prefix search', async () => {
    for (const suffix of ['a.txt', 'b.txt', 'nested/c.txt']) {
      const itemKey = root + suffix
      assert.equal((await call(object(itemKey), { method: 'PUT', body: suffix })).status, 201)
      tracked.add(itemKey)
    }
    const result = await call(`${base}/objects?${new URLSearchParams({ prefix: root, limit: '2', recursive: 'true' })}`).then(r => r.json())
    assert.equal(result.truncated, true)
    assert.ok(result.cursor)
    const next = await call(`${base}/objects?${new URLSearchParams({ prefix: root, limit: '2', recursive: 'true', cursor: result.cursor })}`).then(r => r.json())
    assert.ok(next.objects.length)
  })
  await check('Directory statistics include nested files, omit markers and exclude adjacent directory names', async () => {
    const directory = `${root}目录 + #?/`
    const nested = `${directory}深层/`
    const adjacent = `${root}目录 + #?-副本/`
    const empty = `${root}空目录/`
    for (const folder of [directory, nested, adjacent, empty]) {
      const response = await call(`${base}/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: folder }) })
      assert.equal(response.status, 201)
      trackedFolders.add(folder)
    }
    const fixtures = new Map([
      [`${directory}readme.txt`, '目录内容'],
      [`${nested}报告.bin`, Buffer.from([0, 1, 2, 255])],
      [`${nested}zero.bin`, Buffer.alloc(0)],
      [`${adjacent}outside.txt`, 'outside-directory'],
    ])
    for (const [fixtureKey, body] of fixtures) {
      const response = await call(object(fixtureKey), { method: 'PUT', body })
      assert.equal(response.status, 201)
      tracked.add(fixtureKey)
    }
    assert.deepEqual(await storageTotals(directory), { objectCount: 3, totalBytes: Buffer.byteLength('目录内容') + 4 })
    assert.deepEqual(await storageTotals(nested), { objectCount: 2, totalBytes: 4 })
    assert.deepEqual(await storageTotals(adjacent), { objectCount: 1, totalBytes: Buffer.byteLength('outside-directory') })
    assert.deepEqual(await storageTotals(empty), { objectCount: 0, totalBytes: 0 })
    assert.deepEqual(await storageTotals(`${root}missing/`), { objectCount: 0, totalBytes: 0 })
    assert.deepEqual(await storageTotals('_mono/'), { objectCount: 0, totalBytes: 0 })
    let expectedBytes = 0
    for (const fixtureKey of tracked) {
      const response = await call(`${object(fixtureKey)}&metadata=true`)
      assert.equal(response.status, 200)
      expectedBytes += (await response.json()).size
    }
    assert.deepEqual(await storageTotals(root), { objectCount: tracked.size, totalBytes: expectedBytes })
  })
  await check('Omitted and empty statistics prefixes preserve whole-bucket totals', async () => {
    const wholeBucket = await storageTotals()
    assert.deepEqual(await storageTotals(''), wholeBucket)
    const directory = await storageTotals(root)
    assert.ok(wholeBucket.objectCount >= directory.objectCount && wholeBucket.totalBytes >= directory.totalBytes)
  })
  await check('Statistics reject malformed directory prefixes and ambiguous queries', async () => {
    for (const prefix of [`/${root}`, `${root}../`, `${root}./`, `${root}bad\npath/`]) {
      assert.equal((await call(`${base}/stats?${new URLSearchParams({ prefix })}`)).status, 400)
    }
    for (const query of [`prefix=${encodeURIComponent(root)}&prefix=`, 'cursor=one&cursor=two', `prefix=${encodeURIComponent(root)}&limit=10`]) {
      assert.equal((await call(`${base}/stats?${query}`)).status, 400)
    }
  })
  await check('Multipart upload stores all bytes', async () => {
    const multipartKey = root + 'multipart.bin'
    const first = Buffer.alloc(5 * 1024 * 1024, 37)
    const second = Buffer.from('final-part')
    const start = await call(`${base}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: multipartKey, size: first.length + second.length }) })
    assert.equal(start.status, 201)
    const { uploadToken } = await start.json()
    const parts = []
    for (const [index, body] of [first, second].entries()) {
      const part = await call(`${base}/uploads/part?partNumber=${index + 1}`, { method: 'PUT', headers: { 'X-Upload-Token': uploadToken }, body })
      assert.equal(part.status, 200, await part.clone().text())
      parts.push(await part.json())
    }
    const completed = await call(`${base}/uploads/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadToken, parts }) })
    assert.equal(completed.status, 201, await completed.clone().text())
    tracked.add(multipartKey)
    const bytes = Buffer.from(await call(object(multipartKey)).then(r => r.arrayBuffer()))
    assert.deepEqual(bytes, Buffer.concat([first, second]))
  })
  await check('Multipart abort and capability validation', async () => {
    const response = await call(`${base}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: root + 'abort.bin', size: 1 }) })
    const { uploadToken } = await response.json()
    const invalid = await call(`${base}/uploads/part?partNumber=1`, { method: 'PUT', headers: { 'X-Upload-Token': uploadToken + 'x' }, body: 'x' })
    assert.equal(invalid.status, 400)
    const aborted = await call(`${base}/uploads/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadToken }) })
    assert.equal(aborted.status, 204)
  })
  await check('CORS and browser mutation source protection', async () => {
    const denied = await call(`${base}/objects`, { headers: { Origin: 'https://untrusted.example' } })
    assert.equal(denied.status, 403)
    const mutation = await fetch(object(root + 'csrf.txt'), { method: 'PUT', headers: { Cookie: sessionCookie }, body: 'x' })
    assert.equal(mutation.status, 403)
  })
  await check('Delete object batch and empty directory', async () => {
    const share = await createShare()
    const result = await call(`${base}/objects`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [...tracked] }) })
    assert.equal(result.status, 200)
    tracked.clear()
    for (const folderKey of [...trackedFolders].sort((a, b) => b.length - a.length)) {
      assert.equal((await call(`${base}/folders?${new URLSearchParams({ key: folderKey })}`, { method: 'DELETE' })).status, 204)
      trackedFolders.delete(folderKey)
    }
    const folder = await call(`${base}/folders?${new URLSearchParams({ key: root })}`, { method: 'DELETE' })
    assert.equal(folder.status, 204)
    assert.equal((await call(object(key))).status, 404)
    assert.equal((await fetch(`${origin}${share.url}/file`)).status, 404)
    assert.equal((await call(object(key), { method: 'PUT', body: 'replaced' })).status, 201)
    tracked.add(key)
    assert.equal((await fetch(`${origin}${share.url}/file`)).status, 404)
  })
  console.log(`\n${passed} API verification scenarios passed.`)
} finally {
  for (const shareKey of sharedKeys) await call(`${base}/shares?${new URLSearchParams({ key: shareKey })}`, { method: 'DELETE' })
  if (tracked.size) await call(`${base}/objects`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [...tracked] }) })
  for (const folderKey of [...trackedFolders].sort((a, b) => b.length - a.length)) await call(`${base}/folders?${new URLSearchParams({ key: folderKey })}`, { method: 'DELETE' })
  await call(`${base}/folders?${new URLSearchParams({ key: root })}`, { method: 'DELETE' })
}
