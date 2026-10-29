import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

// 仅支持绑定两个本地 R2 桶的隔离 Worker，禁止使用开发端口 8787。
const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8790')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || target.port === '8787') {
  throw new Error('Token verification requires an isolated localhost Worker; the normal port 8787 is prohibited.')
}
const origin = target.origin
const isolated = process.env.MONO_TOKEN_TEST_ISOLATED === 'true'
const primaryToken = process.env.MONO_API_TOKEN || 'mono_token_permissions_verification_20261029_local_only'
let administrator = primaryToken
let cookie = ''
let registryETag = ''
let initializedHere = false
let originalPolicy = null
let passed = 0
const bucket = process.env.MONO_BUCKET || 'workspace'
const otherBucket = process.env.MONO_OTHER_BUCKET || 'archive'
const root = `verify-tokens-${randomUUID()}/`
const targetKey = `${root}目标 + #?.txt`
const siblingKey = `${targetKey}.bak`
const childKey = `${targetKey}/child.txt`
const otherKey = `${root}private-other.txt`
const archiveKey = `${root}archive-only.txt`
const content = 'authorized-target-content'
const privateContent = `private-sibling-${randomUUID()}`
const files = new Map([[bucket, new Set()], [otherBucket, new Set()]])
const folders = new Map([[bucket, new Set()], [otherBucket, new Set()]])
const tokens = new Map()
const shares = new Set()
const uploads = []
const allPermissions = ['read', 'write', 'delete', 'create_folder', 'delete_folder', 'share']
const filePermissions = ['read', 'write', 'delete', 'share']
const bucketScope = { type: 'bucket', bucket }
const fileScope = key => ({ type: 'file', bucket, key })
const path = (name, resource) => `/api/buckets/${encodeURIComponent(name)}/${resource}`
const object = (key, name = bucket, extra = {}) => `${path(name, 'object')}?${new URLSearchParams({ key, ...extra })}`
const listing = (name = bucket, extra = {}) => `${path(name, 'objects')}?${new URLSearchParams(extra)}`
const folder = (key, name = bucket) => `${path(name, 'folders')}?${new URLSearchParams({ key })}`
const sharePath = key => `${path(bucket, 'shares')}?${new URLSearchParams({ key })}`
const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
const weakRevision = value => `W/${value.replace(/^W\//, '')}`

async function call(route, token = administrator, init = {}) {
  const destination = new URL(route, origin)
  assert.equal(destination.origin, origin, 'Verification must never follow requests outside its localhost instance.')
  const headers = new Headers(init.headers)
  headers.set('X-Mono-Client', 'web')
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  return fetch(destination, { ...init, headers, redirect: 'manual' })
}

async function expect(response, status, label = '') {
  if (response.status !== status) {
    let code = ''
    try { code = (await response.clone().json()).error?.code || '' } catch {}
    assert.fail(`${label || 'HTTP check'}: expected ${status}, received ${response.status}${code ? ` (${code})` : ''}`)
  }
  return response
}

async function deny(response, status = 403, label = '') {
  await expect(response, status, label)
  if (response.body && (response.headers.get('Content-Type') || '').includes('application/json')) {
    const result = await response.clone().json()
    assert.ok(result.error?.code)
    assert.equal(result.config, undefined)
    assert.equal(result.secret, undefined)
    assert.equal(result.tokenHash, undefined)
  }
}

function noSecrets(info) {
  for (const field of ['secret', 'tokenHash', 'apiTokenHash', 'credentialVersion', 'revoked', 'apiToken']) assert.equal(info[field], undefined, `${field} must not be returned in a token-management response.`)
}

async function registry() {
  const response = await expect(await call('/api/tokens'), 200)
  registryETag = response.headers.get('ETag')
  assert.ok(registryETag, 'Token writes need a revision returned by the API.')
  const result = await response.json()
  noSecrets(result)
  assert.ok(Array.isArray(result.tokens))
  result.tokens.forEach(noSecrets)
  return result.tokens
}

async function createToken(name, scope, permissions, extra = {}) {
  const response = await expect(await call('/api/tokens', administrator, { method: 'POST', ...json({ name, scope, permissions, ...extra }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 201, `Create ${name}`)
  registryETag = response.headers.get('ETag')
  assert.ok(registryETag)
  const result = await response.json()
  noSecrets(result.token)
  assert.match(result.token.id, /^[a-f0-9]{32}$/)
  assert.equal(typeof result.secret, 'string')
  assert.ok(result.secret.length >= 24)
  const token = { ...result.token, secret: result.secret }
  tokens.set(token.id, token)
  return token
}

async function editToken(token, update) {
  const response = await expect(await call(`/api/tokens/${token.id}`, administrator, { method: 'PATCH', ...json(update), headers: { ...json({}).headers, 'If-Match': registryETag } }), 200, `Edit ${token.name}`)
  registryETag = response.headers.get('ETag')
  const result = await response.json()
  noSecrets(result.token)
  assert.equal(result.secret, undefined)
  assert.equal(result.token.id, token.id)
  assert.deepEqual(result.token.scope, token.scope)
  Object.assign(token, result.token)
  return token
}

async function revokeToken(token) {
  const response = await expect(await call(`/api/tokens/${token.id}`, administrator, { method: 'DELETE', headers: { 'If-Match': registryETag } }), 204, `Revoke ${token.name}`)
  registryETag = response.headers.get('ETag')
}

async function put(key, bytes, token = administrator, name = bucket, overwrite = false) {
  const response = await expect(await call(object(key, name, overwrite ? { overwrite: 'true' } : {}), token, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: bytes }), 201, 'Upload permitted object')
  files.get(name).add(key)
  return response
}

async function assertContent(key, expected, name = bucket) {
  const response = await expect(await call(object(key, name)), 200, 'Read back independently as administrator')
  assert.equal(await response.text(), expected)
}

async function createFolder(key, token = administrator, name = bucket) {
  const response = await expect(await call(path(name, 'folders'), token, { method: 'POST', ...json({ key }) }), 201)
  folders.get(name).add(key)
  return response
}

async function beginUpload(token, key, size = 11, overwrite = false, name = bucket) {
  const response = await expect(await call(path(name, 'uploads'), token.secret, { method: 'POST', ...json({ key, size, overwrite, contentType: 'application/octet-stream' }) }), 201, 'Start permitted multipart upload')
  const upload = { ...(await response.json()), token, bucket: name, key, finished: false }
  assert.ok(upload.uploadToken)
  uploads.push(upload)
  return upload
}

function uploadPart(upload, token = upload.token.secret, bytes = 'elevenbytes', name = upload.bucket) {
  return call(`${path(name, 'uploads/part')}?partNumber=1`, token, { method: 'PUT', headers: { 'X-Upload-Token': upload.uploadToken }, body: bytes })
}

function uploadComplete(upload, parts, token = upload.token.secret, name = upload.bucket) {
  return call(path(name, 'uploads/complete'), token, { method: 'POST', ...json({ uploadToken: upload.uploadToken, parts }) })
}

function uploadAbort(upload, token = upload.token.secret, name = upload.bucket) {
  return call(path(name, 'uploads/abort'), token, { method: 'POST', ...json({ uploadToken: upload.uploadToken }) })
}

async function check(label, run) {
  await run()
  passed++
  console.log(`PASS ${label}`)
}

let readToken, writeToken, readWriteToken, deleteToken, createFolderToken, deleteFolderToken, shareToken, readShareToken, globalAll, bucketAll, fileRead, fileWrite, fileAll

try {
  await check('Only disposable localhost storage is initialized, with two bound buckets and a valid administrator session', async () => {
    const publicSession = await expect(await call('/api/session', null), 200)
    assert.deepEqual(await publicSession.json(), { authenticated: false })
    const statusResponse = await expect(await call('/api/setup', null), 200)
    const status = await statusResponse.json()
    assert.deepEqual(Object.keys(status), ['setupRequired'])
    if (status.setupRequired) {
      const response = await expect(await call('/api/setup', null, { method: 'POST', ...json({ displayName: 'Token 权限隔离验证', adminPath: '/console', apiToken: administrator }) }), 201)
      cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
      initializedHere = true
    } else {
      assert.equal(isolated, true, 'An existing workspace is refused unless MONO_TOKEN_TEST_ISOLATED=true explicitly identifies a disposable instance.')
      const response = await expect(await call('/api/session', null, { method: 'POST', ...json({ token: administrator }) }), 200, 'Use MONO_API_TOKEN for an existing disposable instance')
      cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
    }
    assert.ok(cookie)
    const administratorSession = await expect(await call('/api/session'), 200)
    assert.equal((await administratorSession.json()).local, true, 'Use wrangler --local with LOCAL_DEVELOPMENT=true.')
    const configResponse = await expect(await call('/api/config'), 200)
    originalPolicy = (await configResponse.json()).config.loginRateLimit
    await expect(await call('/api/config', administrator, { method: 'PATCH', ...json({ loginRateLimit: { maxAttempts: 100, windowSeconds: 10 } }), headers: { 'Content-Type': 'application/json', 'If-Match': configResponse.headers.get('ETag') } }), 200)
    const result = await expect(await call('/api/buckets'), 200)
    const known = (await result.json()).buckets.map(item => item.name)
    assert.ok(bucket !== otherBucket && known.includes(bucket) && known.includes(otherBucket), 'Bind two separate local buckets (workspace and archive) before running these tests.')
    await registry()
    await put(targetKey, content)
    await put(siblingKey, privateContent)
    await put(childKey, privateContent)
    await put(otherKey, privateContent)
    await put(archiveKey, privateContent, administrator, otherBucket)
    const anonymous = await call('/api/tokens', null)
    await deny(anonymous, 401)
  })

  await check('Create independent operation grants and scopes; registry responses never expose stored secret material', async () => {
    readToken = await createToken('只读', { type: 'all' }, ['read'])
    writeToken = await createToken('只写', { type: 'all' }, ['write'])
    readWriteToken = await createToken('读写', { type: 'all' }, ['read', 'write'])
    deleteToken = await createToken('仅删除文件', { type: 'all' }, ['delete'])
    createFolderToken = await createToken('仅创建目录', { type: 'all' }, ['create_folder'])
    deleteFolderToken = await createToken('仅删除目录', { type: 'all' }, ['delete_folder'])
    shareToken = await createToken('仅管理分享', { type: 'all' }, ['share'])
    readShareToken = await createToken('读取与分享', { type: 'all' }, ['read', 'share'])
    globalAll = await createToken('全范围存储权限', { type: 'all' }, allPermissions)
    bucketAll = await createToken('指定桶全部存储权限', bucketScope, allPermissions)
    fileRead = await createToken('指定文件读取', fileScope(targetKey), ['read'])
    fileWrite = await createToken('指定文件写入', fileScope(targetKey), ['write'])
    fileAll = await createToken('指定文件全部权限', fileScope(targetKey), filePermissions)
    const listed = await registry()
    for (const created of tokens.values()) assert.ok(listed.some(item => item.id === created.id))
    const filteredResponse = await expect(await call(`/api/tokens?${new URLSearchParams({ bucket, key: targetKey })}`), 200)
    assert.ok(filteredResponse.headers.get('ETag'))
    const filtered = (await filteredResponse.json()).tokens
    assert.deepEqual(filtered.map(item => item.id).sort(), [fileRead.id, fileWrite.id, fileAll.id].sort(), 'A file token panel must exclude broader global and bucket grants.')
    filtered.forEach(noSecrets)
  })

  await check('Read grant permits content, HEAD, metadata, range and listing, while all mutations are denied without side effects', async () => {
    await expect(await call(object(targetKey), readToken.secret), 200)
    await expect(await call(object(targetKey), readToken.secret, { method: 'HEAD' }), 200)
    const metadata = await expect(await call(object(targetKey, bucket, { metadata: 'true' }), readToken.secret), 200)
    assert.equal((await metadata.json()).key, targetKey)
    await expect(await call(listing(bucket, { prefix: root }), readToken.secret), 200)
    const range = await expect(await call(object(targetKey), readToken.secret, { headers: { Range: 'bytes=0-9' } }), 206)
    assert.equal(await range.text(), content.slice(0, 10))
    for (const [route, init] of [[object(targetKey, bucket, { overwrite: 'true' }), { method: 'PUT', body: 'forbidden' }], [object(targetKey), { method: 'DELETE' }], [path(bucket, 'folders'), { method: 'POST', ...json({ key: `${root}read-folder/` }) }], [folder(`${root}read-folder/`), { method: 'DELETE' }], [path(bucket, 'shares'), { method: 'POST', ...json({ key: targetKey }) }], [path(bucket, 'uploads'), { method: 'POST', ...json({ key: `${root}read-upload.bin`, size: 1 }) }]]) await deny(await call(route, readToken.secret, init))
    await assertContent(targetKey, content)
    await expect(await call(object(`${root}read-upload.bin`)), 404)
  })

  await check('Write is not read or delete; a read-write grant still lacks directory and delete authority', async () => {
    const key = `${root}write-only.txt`
    await put(key, 'write-one', writeToken.secret)
    await put(key, 'write-two', writeToken.secret, bucket, true)
    await assertContent(key, 'write-two')
    for (const [route, init] of [[object(key), {}], [object(key), { method: 'HEAD' }], [object(key, bucket, { metadata: 'true' }), {}], [listing(bucket, { prefix: root }), {}], [object(key), { method: 'DELETE' }], [path(bucket, 'folders'), { method: 'POST', ...json({ key: `${root}write-folder/` }) }], [folder(`${root}write-folder/`), { method: 'DELETE' }]]) await deny(await call(route, writeToken.secret, init))
    await put(`${root}read-write.txt`, 'combined', readWriteToken.secret)
    await expect(await call(object(`${root}read-write.txt`), readWriteToken.secret), 200)
    await deny(await call(object(`${root}read-write.txt`), readWriteToken.secret, { method: 'DELETE' }))
    await deny(await call(path(bucket, 'folders'), readWriteToken.secret, { method: 'POST', ...json({ key: `${root}read-write-folder/` }) }))
  })

  await check('Delete, create-folder and delete-folder are three independent capabilities', async () => {
    const deletedKey = `${root}delete-only.txt`
    await put(deletedKey, 'delete fixture')
    await expect(await call(object(deletedKey), deleteToken.secret, { method: 'DELETE' }), 204)
    await expect(await call(object(deletedKey)), 404)
    await deny(await call(object(targetKey), deleteToken.secret))
    await deny(await call(object(`${root}delete-write.txt`), deleteToken.secret, { method: 'PUT', body: 'denied' }))
    await deny(await call(folder(`${root}empty/`), deleteToken.secret, { method: 'DELETE' }))
    const directory = `${root}created-directory/`
    await createFolder(directory, createFolderToken.secret)
    await deny(await call(folder(directory), createFolderToken.secret, { method: 'DELETE' }))
    await deny(await call(object(targetKey), createFolderToken.secret, { method: 'DELETE' }))
    await deny(await call(object(targetKey), createFolderToken.secret))
    await deny(await call(object(`${directory}file.txt`), createFolderToken.secret, { method: 'PUT', body: 'denied' }))
    await expect(await call(folder(directory), deleteFolderToken.secret, { method: 'DELETE' }), 204)
    await deny(await call(path(bucket, 'folders'), deleteFolderToken.secret, { method: 'POST', ...json({ key: directory }) }))
    await deny(await call(object(targetKey), deleteFolderToken.secret, { method: 'DELETE' }))
    await deny(await call(object(targetKey), deleteFolderToken.secret))
    const occupied = `${root}nonempty/`
    await createFolder(occupied)
    await put(`${occupied}inside.txt`, 'must survive directory removal')
    await expect(await call(folder(occupied), deleteFolderToken.secret, { method: 'DELETE' }), 409)
    await assertContent(`${occupied}inside.txt`, 'must survive directory removal')
  })

  await check('Sharing requires both read and share to create, and share management alone does not grant file reads', async () => {
    await deny(await call(path(bucket, 'shares'), readToken.secret, { method: 'POST', ...json({ key: targetKey, expiresIn: 3600 }) }))
    await deny(await call(path(bucket, 'shares'), shareToken.secret, { method: 'POST', ...json({ key: targetKey, expiresIn: 3600 }) }))
    const response = await expect(await call(path(bucket, 'shares'), readShareToken.secret, { method: 'POST', ...json({ key: targetKey, expiresIn: 3600 }) }), 201)
    const shared = await response.json()
    shares.add(targetKey)
    await expect(await call(`/api/shares/${shared.id}`, null), 200)
    await deny(await call(sharePath(targetKey), readToken.secret))
    await deny(await call(sharePath(targetKey), readToken.secret, { method: 'DELETE' }))
    await expect(await call(sharePath(targetKey), shareToken.secret), 200)
    await deny(await call(object(targetKey), shareToken.secret))
    await expect(await call(sharePath(targetKey), shareToken.secret, { method: 'DELETE' }), 204)
    await expect(await call(`/api/shares/${shared.id}`, null), 404)
  })

  await check('ALL covers storage operations across bound buckets but never gives configuration, registry or console-login authority', async () => {
    await expect(await call(object(archiveKey, otherBucket), globalAll.secret), 200)
    const key = `${root}global-all.txt`
    await put(key, 'all permissions', globalAll.secret, otherBucket)
    await expect(await call(object(key, otherBucket), globalAll.secret, { method: 'DELETE' }), 204)
    const directory = `${root}global-all/`
    await createFolder(directory, globalAll.secret, otherBucket)
    await expect(await call(folder(directory, otherBucket), globalAll.secret, { method: 'DELETE' }), 204)
    for (const [route, init] of [['/api/config', {}], ['/api/config', { method: 'PATCH', ...json({ displayName: 'unauthorized' }) }], ['/api/tokens', {}], ['/api/tokens', { method: 'POST', ...json({ name: 'elevate', scope: { type: 'all' }, permissions: allPermissions }) }], [`/api/tokens/${readToken.id}`, { method: 'PATCH', ...json({ permissions: allPermissions }) }], [`/api/tokens/${readToken.id}`, { method: 'DELETE' }]]) await deny(await call(route, globalAll.secret, init))
    for (const route of ['/api/session', '/api/setup']) {
      const state = await expect(await call(route, globalAll.secret), 200)
      const body = await state.json()
      assert.deepEqual(body, route === '/api/session' ? { authenticated: false } : { setupRequired: false })
      noSecrets(body)
    }
    const login = await call('/api/session', globalAll.secret, { method: 'POST', ...json({ token: globalAll.secret }) })
    await deny(login, 401)
    assert.equal(login.headers.get('Set-Cookie'), null)
    await expect(await call('/api/setup', globalAll.secret, { method: 'POST', ...json({ apiToken: globalAll.secret, adminPath: '/takeover' }) }), 409)
    const visible = await expect(await call('/api/buckets', globalAll.secret), 200)
    const result = await visible.json()
    assert.equal(result.config, undefined)
    assert.ok(result.buckets.some(item => item.name === bucket) && result.buckets.some(item => item.name === otherBucket))
  })

  await check('Bucket grants cannot enumerate or mutate another real bucket, and immutable scope cannot be broadened', async () => {
    const response = await expect(await call('/api/buckets', bucketAll.secret), 200)
    const visible = await response.json()
    assert.deepEqual(visible.buckets.map(item => item.name), [bucket])
    assert.equal(visible.config, undefined)
    for (const [route, init] of [[listing(otherBucket), {}], [object(archiveKey, otherBucket), {}], [object(archiveKey, otherBucket), { method: 'HEAD' }], [object(archiveKey, otherBucket, { metadata: 'true' }), {}], [object(archiveKey, otherBucket, { overwrite: 'true' }), { method: 'PUT', body: 'denied' }], [object(archiveKey, otherBucket), { method: 'DELETE' }], [path(otherBucket, 'objects'), { method: 'DELETE', ...json({ keys: [archiveKey] }) }], [path(otherBucket, 'folders'), { method: 'POST', ...json({ key: `${root}forbidden/` }) }], [folder(`${root}forbidden/`, otherBucket), { method: 'DELETE' }], [path(otherBucket, 'shares'), { method: 'POST', ...json({ key: archiveKey }) }], [path(otherBucket, 'uploads'), { method: 'POST', ...json({ key: `${root}forbidden.bin`, size: 1 }) }]]) await deny(await call(route, bucketAll.secret, init))
    await assertContent(archiveKey, privateContent, otherBucket)
    await expect(await call(`/api/tokens/${bucketAll.id}`, administrator, { method: 'PATCH', ...json({ scope: { type: 'all' } }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 400)
    await put(`${root}bucket-allowed.txt`, 'within scope', bucketAll.secret)
    await expect(await call(object(`${root}bucket-allowed.txt`), bucketAll.secret, { method: 'DELETE' }), 204)
  })

  await check('File read lists only the exact allowed object and never leaks sibling prefixes, metadata, HEAD or another bucket', async () => {
    const adminPage = await expect(await call(listing(bucket, { prefix: root, recursive: 'true', limit: '1' })), 200)
    const cursor = (await adminPage.json()).cursor
    assert.ok(cursor)
    for (const params of [{}, { prefix: root }, { prefix: targetKey }, { prefix: root, recursive: 'true', limit: '1', cursor }]) {
      const response = await expect(await call(listing(bucket, params), fileRead.secret), 200)
      const result = await response.json()
      assert.deepEqual(result.objects.map(item => item.key), [targetKey])
      assert.deepEqual(result.folders, [])
      assert.equal(result.cursor, null)
      assert.equal(result.truncated, false)
      assert.ok(!JSON.stringify(result).includes(privateContent))
    }
    const siblingListing = await expect(await call(listing(bucket, { prefix: siblingKey }), fileRead.secret), 200)
    assert.deepEqual((await siblingListing.json()).objects, [])
    for (const deniedKey of [siblingKey, childKey, otherKey]) {
      for (const params of [{}, { metadata: 'true' }]) await deny(await call(object(deniedKey, bucket, params), fileRead.secret))
      await deny(await call(object(deniedKey), fileRead.secret, { method: 'HEAD' }))
      await deny(await call(object(deniedKey), fileRead.secret, { method: 'DELETE' }))
    }
    const visible = await expect(await call('/api/buckets', fileRead.secret), 200)
    assert.deepEqual((await visible.json()).buckets.map(item => item.name), [bucket])
    await deny(await call(object(archiveKey, otherBucket), fileRead.secret))
    await deny(await call(object(targetKey, bucket, { overwrite: 'true' }), fileRead.secret, { method: 'PUT', body: 'denied' }))
  })

  await check('Anonymous public sharing stays usable, while an explicit bearer still obeys exact file and read permissions', async () => {
    const create = async key => {
      const response = await expect(await call(path(bucket, 'shares'), administrator, { method: 'POST', ...json({ key, expiresIn: 3600 }) }), 201)
      shares.add(key)
      return response.json()
    }
    const targetShare = await create(targetKey)
    const siblingShare = await create(siblingKey)
    const archiveResponse = await expect(await call(path(otherBucket, 'shares'), administrator, { method: 'POST', ...json({ key: archiveKey, expiresIn: 3600 }) }), 201)
    const archiveShare = await archiveResponse.json()
    for (const route of [`/api/shares/${siblingShare.id}`, siblingShare.url, `${siblingShare.url}/file`]) {
      await expect(await call(route, null), 200)
      await deny(await call(route, fileRead.secret))
      await deny(await call(route, 'invalid-public-share-bearer', { headers: { Cookie: cookie } }), 401)
    }
    await expect(await call(`${siblingShare.url}/file`, null, { method: 'HEAD' }), 200)
    await deny(await call(`${siblingShare.url}/file`, fileRead.secret, { method: 'HEAD' }))
    for (const route of [`/api/shares/${targetShare.id}`, targetShare.url, `${targetShare.url}/file`]) {
      await expect(await call(route, fileRead.secret), 200)
      await deny(await call(route, fileWrite.secret))
    }
    await expect(await call(`${targetShare.url}/file`, fileRead.secret, { method: 'HEAD' }), 200)
    for (const route of [`/api/shares/${archiveShare.id}`, archiveShare.url, `${archiveShare.url}/file`]) {
      await expect(await call(route, null), 200)
      await deny(await call(route, bucketAll.secret))
    }
    await expect(await call(`${path(otherBucket, 'shares')}?${new URLSearchParams({ key: archiveKey })}`, administrator, { method: 'DELETE' }), 204)
  })

  await check('File write and file ALL stay within one key; mixed-key batch deletion is denied atomically', async () => {
    await put(targetKey, 'file-write-content', fileWrite.secret, bucket, true)
    await deny(await call(object(targetKey), fileWrite.secret))
    await deny(await call(object(targetKey), fileWrite.secret, { method: 'HEAD' }))
    await deny(await call(listing(bucket), fileWrite.secret))
    await deny(await call(object(targetKey), fileWrite.secret, { method: 'DELETE' }))
    await deny(await call(object(siblingKey, bucket, { overwrite: 'true' }), fileWrite.secret, { method: 'PUT', body: 'denied' }))
    await deny(await call(path(bucket, 'folders'), fileAll.secret, { method: 'POST', ...json({ key: `${root}file-folder/` }) }))
    await deny(await call(folder(`${root}file-folder/`), fileAll.secret, { method: 'DELETE' }))
    await deny(await call(path(bucket, 'objects'), fileAll.secret, { method: 'DELETE', ...json({ keys: [targetKey, siblingKey] }) }))
    await assertContent(targetKey, 'file-write-content')
    await assertContent(siblingKey, privateContent)
    await expect(await call(object(targetKey), fileAll.secret), 200)
    await put(targetKey, content, fileAll.secret, bucket, true)
    await expect(await call(path(bucket, 'objects'), fileAll.secret, { method: 'DELETE', ...json({ keys: [targetKey] }) }), 200)
    await expect(await call(object(targetKey)), 404)
    await put(targetKey, content)
    for (const permissions of [['create_folder'], ['read', 'delete_folder']]) await expect(await call('/api/tokens', administrator, { method: 'POST', ...json({ name: 'invalid file directory grant', scope: fileScope(targetKey), permissions }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 400)
  })

  await check('Compression-weakened registry revisions work for create, edit and revoke, while stale or malformed headers cannot bypass concurrency checks', async () => {
    const stale = registryETag
    registryETag = weakRevision(registryETag)
    const probe = await createToken('weak revision probe', fileScope(targetKey), ['read'])
    const before = await registry()
    const savedRevision = registryETag
    const rejectedMutations = [
      ['/api/tokens', { method: 'POST', ...json({ name: 'stale weak creation', scope: fileScope(targetKey), permissions: ['read'] }) }],
      [`/api/tokens/${probe.id}`, { method: 'PATCH', ...json({ enabled: false }) }],
      [`/api/tokens/${probe.id}`, { method: 'DELETE' }],
    ]
    for (const [route, init] of rejectedMutations) {
      const rejected = await expect(await call(route, administrator, { ...init, headers: { ...init.headers, 'If-Match': weakRevision(stale) } }), 409)
      assert.equal((await rejected.json()).error.code, 'TOKEN_CONFLICT')
    }
    for (const expected of ['W/*', `${registryETag}, ${registryETag}`]) {
      const rejected = await expect(await call(`/api/tokens/${probe.id}`, administrator, { method: 'PATCH', ...json({ enabled: false }), headers: { ...json({}).headers, 'If-Match': expected } }), 409)
      assert.equal((await rejected.json()).error.code, 'TOKEN_CONFLICT')
    }
    assert.deepEqual(await registry(), before)
    assert.equal(registryETag, savedRevision)
    await expect(await call(object(targetKey), probe.secret), 200)
    registryETag = weakRevision(registryETag)
    await editToken(probe, { name: 'weak revision edited' })
    registryETag = weakRevision(registryETag)
    await revokeToken(probe)
    await deny(await call(object(targetKey), probe.secret), 401)
    assert.ok(!(await registry()).some(item => item.id === probe.id))
  })

  await check('Registry mutations use optimistic concurrency; stale creates, edits and revocations have no effect', async () => {
    const stale = registryETag
    const probe = await createToken('revision probe', fileScope(targetKey), ['read'])
    for (const [route, init] of [['/api/tokens', { method: 'POST', ...json({ name: 'stale creation', scope: { type: 'all' }, permissions: ['read'] }) }], [`/api/tokens/${probe.id}`, { method: 'PATCH', ...json({ enabled: false }) }], [`/api/tokens/${probe.id}`, { method: 'DELETE' }]]) {
      const response = await expect(await call(route, administrator, { ...init, headers: { ...init.headers, 'If-Match': stale } }), 409)
      assert.equal((await response.json()).error.code, 'TOKEN_CONFLICT')
    }
    await expect(await call(object(targetKey), probe.secret), 200)
    const before = await registry()
    assert.ok(!before.some(item => item.name === 'stale creation'))
    const etag = registryETag
    const responses = await Promise.all(['race-a', 'race-b'].map(name => call('/api/tokens', administrator, { method: 'POST', ...json({ name: `${name}-${root}`, scope: fileScope(targetKey), permissions: ['read'] }), headers: { ...json({}).headers, 'If-Match': etag } })))
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409])
    const winner = responses.find(response => response.status === 201)
    const created = await winner.json()
    tokens.set(created.token.id, { ...created.token, secret: created.secret })
    const loser = responses.find(response => response.status === 409)
    assert.equal((await loser.json()).error.code, 'TOKEN_CONFLICT')
    const after = await registry()
    assert.equal(after.length, before.length + 1)
  })

  await check('A supplied bearer never falls back to an administrator cookie, and cookie writes still enforce CSRF protection', async () => {
    await deny(await call('/api/config', 'invalid-bearer', { headers: { Cookie: cookie } }), 401)
    await deny(await call('/api/config', globalAll.secret, { headers: { Cookie: cookie } }))
    await deny(await call(object(targetKey), writeToken.secret, { headers: { Cookie: cookie } }))
    const malformed = await fetch(`${origin}/api/config`, { headers: { Authorization: 'Basic invalid', Cookie: cookie }, redirect: 'manual' })
    await deny(malformed, 401)
    const noMarker = await fetch(`${origin}/api/tokens`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'csrf', scope: { type: 'all' }, permissions: ['read'] }), redirect: 'manual' })
    await deny(noMarker)
    assert.equal((await noMarker.json()).error.code, 'CSRF_PROTECTION')
    await expect(await call('/api/tokens', null, { headers: { Cookie: cookie } }), 200)
    const untrusted = await call('/api/tokens', administrator, { headers: { Origin: 'https://untrusted.invalid' } })
    await deny(untrusted)
  })

  await check('Permission edits, disable and enable apply to the same secret immediately, while scope remains immutable', async () => {
    const token = await createToken('editable capability', fileScope(targetKey), ['read'])
    await deny(await call(object(targetKey, bucket, { overwrite: 'true' }), token.secret, { method: 'PUT', body: 'no write' }))
    await editToken(token, { permissions: ['read', 'write'], name: 'edited capability' })
    await put(targetKey, 'edited permissions', token.secret, bucket, true)
    await editToken(token, { permissions: ['read'] })
    await deny(await call(object(targetKey, bucket, { overwrite: 'true' }), token.secret, { method: 'PUT', body: 'denied again' }))
    await editToken(token, { enabled: false })
    await deny(await call(object(targetKey), token.secret), 401)
    await deny(await call(object(targetKey), token.secret, { headers: { Cookie: cookie } }), 401)
    await editToken(token, { enabled: true })
    await expect(await call(object(targetKey), token.secret), 200)
    await put(targetKey, content, administrator, bucket, true)
  })

  await check('Revocation is permanent and duplicate secrets cannot revive a used capability or collide with the administrator', async () => {
    const secret = `mono_duplicate_${randomBytes(24).toString('hex')}`
    const token = await createToken('duplicate guard', fileScope(targetKey), ['read'], { token: secret })
    for (const reused of [secret, administrator]) {
      const response = await expect(await call('/api/tokens', administrator, { method: 'POST', ...json({ name: 'duplicate attempt', scope: { type: 'all' }, permissions: allPermissions, token: reused }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 400)
      assert.equal((await response.json()).error.code, 'TOKEN_ALREADY_USED')
    }
    await revokeToken(token)
    await deny(await call(object(targetKey), secret), 401)
    await expect(await call(`/api/tokens/${token.id}`, administrator, { method: 'PATCH', ...json({ enabled: true }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 404)
    const repeated = await expect(await call('/api/tokens', administrator, { method: 'POST', ...json({ name: 'revival attempt', scope: fileScope(targetKey), permissions: ['read'], token: secret }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 400)
    assert.equal((await repeated.json()).error.code, 'TOKEN_ALREADY_USED')
    assert.ok(!(await registry()).some(item => item.id === token.id))
  })

  await check('Expiration denies immediately at the configured deadline and cannot fall back to a browser session', async () => {
    const expiresAt = new Date(Date.now() + 1200).toISOString()
    const token = await createToken('short expiry', fileScope(targetKey), ['read'], { expiresAt })
    await expect(await call(object(targetKey), token.secret), 200)
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 25))
    await deny(await call(object(targetKey), token.secret), 401)
    await deny(await call(object(targetKey), token.secret, { headers: { Cookie: cookie } }), 401)
    await editToken(token, { expiresAt: null })
    await expect(await call(object(targetKey), token.secret), 200)
    await revokeToken(token)
  })

  await check('Multipart credentials bind their owner at part, complete and abort; another writer cannot use them', async () => {
    const owner = await createToken('multipart owner', bucketScope, ['write'])
    const peer = await createToken('multipart peer', bucketScope, ['write'])
    const upload = await beginUpload(owner, `${root}multipart-owner.bin`)
    const part = await expect(await uploadPart(upload), 200)
    const parts = [await part.json()]
    for (const response of [await uploadPart(upload, peer.secret), await uploadComplete(upload, parts, peer.secret), await uploadAbort(upload, peer.secret)]) {
      await deny(response)
      assert.equal((await response.json()).error.code, 'UPLOAD_TOKEN_DENIED')
    }
    for (const response of [await uploadPart(upload, owner.secret, 'elevenbytes', otherBucket), await uploadComplete(upload, parts, owner.secret, otherBucket), await uploadAbort(upload, owner.secret, otherBucket)]) await deny(response)
    await expect(await uploadAbort(upload), 204)
    upload.finished = true
    await expect(await call(object(upload.key)), 404)
    await deny(await call(path(bucket, 'uploads'), readToken.secret, { method: 'POST', ...json({ key: upload.key, size: 11 }) }))
  })

  await check('File multipart uploads cannot target siblings; extra key fields cannot redirect an authorized upload', async () => {
    await deny(await call(path(bucket, 'uploads'), fileWrite.secret, { method: 'POST', ...json({ key: siblingKey, size: 11, overwrite: true }) }))
    const bytes = 'single-file-multipart'
    const upload = await beginUpload(fileWrite, targetKey, Buffer.byteLength(bytes), true)
    const part = await expect(await call(`${path(bucket, 'uploads/part')}?${new URLSearchParams({ partNumber: '1', key: siblingKey })}`, fileWrite.secret, { method: 'PUT', headers: { 'X-Upload-Token': upload.uploadToken }, body: bytes }), 200)
    const completed = await expect(await call(path(bucket, 'uploads/complete'), fileWrite.secret, { method: 'POST', ...json({ uploadToken: upload.uploadToken, key: siblingKey, parts: [await part.json()] }) }), 201)
    assert.equal((await completed.json()).key, targetKey)
    upload.finished = true
    await assertContent(targetKey, bytes)
    await assertContent(siblingKey, privateContent)
    await put(targetKey, content, administrator, bucket, true)
  })

  await check('Removing write permission invalidates every stage of an existing upload, and restoring it cannot revive old credentials', async () => {
    const token = await createToken('mutable upload', fileScope(`${root}mutable-upload.bin`), ['write'])
    const upload = await beginUpload(token, token.scope.key)
    const part = await expect(await uploadPart(upload), 200)
    const parts = [await part.json()]
    await editToken(token, { permissions: ['read'] })
    for (const response of [await uploadPart(upload), await uploadComplete(upload, parts), await uploadAbort(upload)]) await deny(response)
    await editToken(token, { permissions: ['write'] })
    for (const response of [await uploadPart(upload), await uploadComplete(upload, parts), await uploadAbort(upload)]) await deny(response)
    await expect(await call(object(upload.key)), 404)
  })

  await check('Disabled or revoked owners cannot use pending multipart credentials, even after another token obtains the same permissions', async () => {
    const token = await createToken('disabled upload', bucketScope, ['write'])
    const upload = await beginUpload(token, `${root}disabled-upload.bin`)
    const parts = [await (await expect(await uploadPart(upload), 200)).json()]
    await editToken(token, { enabled: false })
    for (const response of [await uploadPart(upload), await uploadComplete(upload, parts), await uploadAbort(upload)]) await deny(response, 401)
    await editToken(token, { enabled: true })
    for (const response of [await uploadPart(upload), await uploadComplete(upload, parts), await uploadAbort(upload)]) await deny(response)
    await revokeToken(token)
    for (const response of [await uploadPart(upload), await uploadComplete(upload, parts), await uploadAbort(upload)]) await deny(response, 401)
    await expect(await call(object(upload.key)), 404)
  })

  await check('Renaming keeps an upload usable, while changing its expiry invalidates the existing generation', async () => {
    const token = await createToken('rename upload', bucketScope, ['write'])
    const bytes = 'elevenbytes'
    const upload = await beginUpload(token, `${root}rename-upload.bin`, Buffer.byteLength(bytes))
    await editToken(token, { name: 'renamed upload' })
    const parts = [await (await expect(await uploadPart(upload, token.secret, bytes), 200)).json()]
    await expect(await uploadComplete(upload, parts), 201)
    upload.finished = true
    files.get(bucket).add(upload.key)
    await assertContent(upload.key, bytes)
    const expiring = await beginUpload(token, `${root}expiry-upload.bin`)
    const expiryParts = [await (await expect(await uploadPart(expiring), 200)).json()]
    const expiresAt = new Date(Date.now() + 1200).toISOString()
    await editToken(token, { expiresAt })
    await deny(await uploadComplete(expiring, expiryParts))
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 25))
    for (const response of [await uploadPart(expiring), await uploadComplete(expiring, expiryParts), await uploadAbort(expiring)]) await deny(response, 401)
    await expect(await call(object(expiring.key)), 404)
  })

  await check('Managed tokens cannot access protected system objects through read, write, delete, batch or upload routes', async () => {
    const systemKey = '_mono/system-config.json'
    for (const [route, init] of [[object(systemKey), {}], [object(systemKey), { method: 'HEAD' }], [object(systemKey), { method: 'PUT', body: '{}' }], [object(systemKey), { method: 'DELETE' }], [path(bucket, 'objects'), { method: 'DELETE', ...json({ keys: [targetKey, systemKey] }) }], [path(bucket, 'uploads'), { method: 'POST', ...json({ key: systemKey, size: 1 }) }]]) await expect(await call(route, globalAll.secret, init), 400)
    const response = await expect(await call(listing(bucket, { prefix: '_mono/', recursive: 'true' }), globalAll.secret), 200)
    assert.deepEqual((await response.json()).objects, [])
    await assertContent(targetKey, content)
  })

  await check('Administrator rotation invalidates all managed tokens, old sessions and pending uploads permanently', async () => {
    assert.ok(initializedHere || isolated, 'Rotation is only authorized for this disposable instance.')
    const owner = await createToken('rotation upload', bucketScope, ['write'])
    const pending = await beginUpload(owner, `${root}rotation-upload.bin`)
    const oldCookie = cookie
    const oldAdministrator = administrator
    const config = await expect(await call('/api/config'), 200)
    const etag = config.headers.get('ETag')
    const replacement = `mono_rotated_${randomBytes(24).toString('hex')}`
    const rotation = await expect(await call('/api/config', administrator, { method: 'PATCH', ...json({ apiToken: replacement }), headers: { ...json({}).headers, 'If-Match': etag } }), 200)
    administrator = replacement
    cookie = rotation.headers.get('Set-Cookie')?.split(';')[0] || ''
    assert.ok(cookie)
    await deny(await call('/api/tokens', oldAdministrator), 401)
    const session = await expect(await call('/api/session', null, { headers: { Cookie: oldCookie } }), 200)
    assert.equal((await session.json()).authenticated, false)
    for (const token of [globalAll, bucketAll, fileRead, fileWrite, fileAll, owner]) await deny(await call(object(targetKey), token.secret), 401)
    await deny(await uploadPart(pending), 401)
    assert.deepEqual(await registry(), [])
    const revived = await expect(await call('/api/tokens', administrator, { method: 'POST', ...json({ name: 'post-rotation reuse', scope: { type: 'all' }, permissions: ['read'], token: fileRead.secret }), headers: { ...json({}).headers, 'If-Match': registryETag } }), 400)
    assert.equal((await revived.json()).error.code, 'TOKEN_ALREADY_USED')
    const currentConfig = await expect(await call('/api/config'), 200)
    const restore = await expect(await call('/api/config', administrator, { method: 'PATCH', ...json({ apiToken: primaryToken }), headers: { ...json({}).headers, 'If-Match': currentConfig.headers.get('ETag') } }), 200)
    administrator = primaryToken
    cookie = restore.headers.get('Set-Cookie')?.split(';')[0] || ''
    await deny(await call(object(targetKey), fileRead.secret), 401)
    const oldSession = await expect(await call('/api/session', null, { headers: { Cookie: oldCookie } }), 200)
    assert.equal((await oldSession.json()).authenticated, false, 'Choosing the previous administrator secret must not revive old session generations.')
    await registry()
    const fresh = await createToken('fresh after rotation', fileScope(targetKey), ['read'])
    await expect(await call(object(targetKey), fresh.secret), 200)
    await revokeToken(fresh)
  })

  console.log(`\n${passed} token-permission API verification scenarios passed.`)
} finally {
  let leftovers = 0
  for (const upload of uploads.filter(item => !item.finished)) {
    const response = await uploadAbort(upload).catch(() => null)
    if (response?.status === 204) upload.finished = true
    else leftovers++
  }
  // 失效的凭据版本无法中止其创建的分片上传。
  for (const key of shares) await call(sharePath(key), administrator, { method: 'DELETE' }).catch(() => null)
  for (const [name, keys] of files) {
    if (keys.size) await call(path(name, 'objects'), administrator, { method: 'DELETE', ...json({ keys: [...keys] }) }).catch(() => null)
  }
  for (const [name, keys] of folders) {
    for (const key of [...keys].sort((a, b) => b.length - a.length)) await call(folder(key, name), administrator, { method: 'DELETE' }).catch(() => null)
  }
  const active = await registry().catch(() => [])
  for (const token of active.filter(item => tokens.has(item.id))) await revokeToken(token).catch(() => null)
  if (administrator !== primaryToken && (initializedHere || isolated)) {
    const config = await call('/api/config').catch(() => null)
    if (config?.ok) {
      const restored = await call('/api/config', administrator, { method: 'PATCH', ...json({ apiToken: primaryToken }), headers: { ...json({}).headers, 'If-Match': config.headers.get('ETag') } }).catch(() => null)
      if (restored?.ok) administrator = primaryToken
    }
  }
  if (originalPolicy) {
    const configResponse = await call('/api/config', null, { headers: { Cookie: cookie } }).catch(() => null)
    if (configResponse?.ok) {
      const restored = await call('/api/config', null, { method: 'PATCH', ...json({ loginRateLimit: originalPolicy }), headers: { Cookie: cookie, 'Content-Type': 'application/json', 'If-Match': configResponse.headers.get('ETag') } }).catch(() => null)
      if (!restored?.ok) throw new Error('Failed to restore the isolated token-verification login policy.')
    } else throw new Error('Failed to read the isolated token-verification configuration for policy cleanup.')
  }
  if (leftovers) console.log(`Cleanup: ${leftovers} invalidated multipart sessions remain only in the disposable storage directory; remove that directory after stopping the test Worker.`)
}
