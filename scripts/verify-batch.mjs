import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8797')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || !target.port || target.port === '8787') throw new Error('Batch verification requires an isolated localhost Worker; the ordinary development port 8787 is prohibited.')
const origin = target.origin
const administrator = process.env.MONO_API_TOKEN || `mono_batch_verify_${randomBytes(24).toString('hex')}`
const bucket = process.env.MONO_BUCKET || 'workspace'
const otherBucket = process.env.MONO_OTHER_BUCKET || 'archive'
assert.ok(bucket !== otherBucket && [bucket, otherBucket].every(name => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)))
const prefix = `verify-batch-${randomUUID()}/`
const targetKey = `${prefix}中文 + #?.txt`
const siblingKey = `${prefix}nested/中文 + #?.txt`
const longKey = `${prefix}${'segment/'.repeat(70)}long.txt`
const fixtureBytes = randomBytes(4097)
const privateMarker = `authorized-fixture-${randomUUID()}`
const fixtures = new Map([
  [targetKey, { name: `${prefix}中文 + #%3F.txt`, bytes: Buffer.from(`${privateMarker}\nUTF-8 中文内容 + #?`) }],
  [siblingKey, { name: `${prefix}nested/中文 + #%3F.txt`, bytes: Buffer.from('nested file with the same basename') }],
  [`${prefix}empty.txt`, { name: `${prefix}empty.txt`, bytes: Buffer.alloc(0) }],
  [`${prefix}binary.bin`, { name: `${prefix}binary.bin`, bytes: fixtureBytes }],
  [`${prefix}a?.txt`, { name: `${prefix}a%3F.txt`, bytes: Buffer.from('question filename') }],
  [`${prefix}a%3F.txt`, { name: `${prefix}a%253F.txt`, bytes: Buffer.from('literal percent filename') }],
  [`${prefix}C:\\drive.txt`, { name: `${prefix}C%3A%5Cdrive.txt`, bytes: Buffer.from('literal backslash and drive punctuation') }],
  [`${prefix}CON.txt`, { name: `${prefix}%43ON.txt`, bytes: Buffer.from('reserved Windows name') }],
  [`${prefix}trailing. `, { name: `${prefix}trailing%2E%20`, bytes: Buffer.from('trailing punctuation') }],
  [longKey, { name: longKey, bytes: Buffer.from('deep relative path') }],
])
const archiveKey = `${prefix}other-bucket.txt`
const files = new Map([[bucket, new Set()], [otherBucket, new Set()]])
const tokens = []
let cookie = ''
let registryETag = ''
let initialized = false
let passed = 0
const path = (name, resource) => `/api/buckets/${encodeURIComponent(name)}/${resource}`
const object = (key, name = bucket) => `${path(name, 'object')}?${new URLSearchParams({ key })}`
const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

async function call(route, credential = administrator, init = {}, web = true) {
  const destination = new URL(route, origin)
  assert.equal(destination.origin, origin, 'Every request must remain inside the isolated localhost instance.')
  const headers = new Headers(init.headers)
  if (web) headers.set('X-Mono-Client', 'web')
  if (credential === 'cookie') headers.set('Cookie', cookie)
  else if (credential !== null) headers.set('Authorization', `Bearer ${credential}`)
  return fetch(destination, { ...init, headers, redirect: 'manual', signal: init.signal || AbortSignal.timeout(30_000) })
}

function chunkedJson(route, value, credential = 'cookie') {
  const destination = new URL(route, origin)
  assert.equal(destination.origin, origin, 'Chunked requests stay inside the isolated localhost instance.')
  const body = Buffer.from(JSON.stringify(value))
  const headers = { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', 'X-Mono-Client': 'web' }
  if (credential === 'cookie') headers.Cookie = cookie
  else if (credential !== null) headers.Authorization = `Bearer ${credential}`
  return new Promise((resolve, reject) => {
    const request = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, { method: 'POST', headers }, response => {
      const received = []
      response.on('data', chunk => received.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('The server disconnected before returning its complete JSON error.')))
      response.on('end', () => {
        try {
          assert.equal(response.complete, true, 'Chunked errors must include a complete HTTP response.')
          const returnedHeaders = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach(item => returnedHeaders.append(name, item))
            else if (value !== undefined) returnedHeaders.set(name, value)
          }
          resolve(new Response(Buffer.concat(received), { status: response.statusCode, headers: returnedHeaders }))
        } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('Chunked request timed out.')))
    assert.equal(request.getHeader('Content-Length'), undefined)
    for (let offset = 0; offset < body.length; offset += 64 * 1024) request.write(body.subarray(offset, Math.min(offset + 64 * 1024, body.length)))
    request.end()
  })
}

async function expect(response, status, label = 'Batch HTTP request') {
  if (response.status !== status) {
    let code = ''
    try { code = (await response.clone().json()).error?.code || '' } catch {}
    assert.fail(`${label}: expected ${status}, received ${response.status}${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`)
  }
  return response
}

async function denied(response, status, code) {
  await expect(response, status)
  assert.match(response.headers.get('Content-Type') || '', /application\/json/)
  const text = await response.text()
  const body = JSON.parse(text)
  assert.ok(body.error?.code)
  if (code) assert.equal(body.error.code, code)
  for (const value of [administrator, cookie, privateMarker, ...tokens.map(token => token.secret)].filter(Boolean)) assert.ok(!text.includes(value), 'Rejected requests must not disclose file contents or credentials.')
  assert.doesNotMatch(text, /"(?:tokenHash|apiTokenHash|credentialVersion|adminPath|displayName)"\s*:/)
  assert.match(response.headers.get('Cache-Control') || '', /no-store/)
}

async function check(label, run) { await run(); passed++; console.log(`PASS ${label}`) }

async function registry() {
  const response = await expect(await call('/api/tokens', 'cookie'), 200)
  registryETag = response.headers.get('ETag')
  assert.ok(registryETag)
  return (await response.json()).tokens
}

async function createToken(name, scope, permissions) {
  const response = await expect(await call('/api/tokens', 'cookie', { method: 'POST', ...json({ name: `Batch ${name}`, scope, permissions }), headers: { 'Content-Type': 'application/json', 'If-Match': registryETag } }), 201)
  registryETag = response.headers.get('ETag')
  const result = await response.json()
  assert.equal(typeof result.secret, 'string')
  assert.equal(result.token.tokenHash, undefined)
  const token = { ...result.token, secret: result.secret }
  tokens.push(token)
  return token
}

async function put(key, bytes, name = bucket) {
  await expect(await call(object(key, name), 'cookie', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }), 201)
  files.get(name).add(key)
}

function archive(keys, credential = administrator, name = bucket, init = {}) {
  return call(path(name, 'archive'), credential, { method: 'POST', ...json({ keys }), ...init })
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntries(bytes) {
  assert.ok(bytes.length >= 22)
  const endOffset = bytes.length - 22
  assert.equal(bytes.readUInt32LE(endOffset), 0x06054b50, 'The complete ZIP must end with its central-directory record.')
  assert.equal(bytes.readUInt16LE(endOffset + 4), 0)
  assert.equal(bytes.readUInt16LE(endOffset + 6), 0)
  const count = bytes.readUInt16LE(endOffset + 10)
  assert.equal(bytes.readUInt16LE(endOffset + 8), count)
  assert.equal(bytes.readUInt16LE(endOffset + 20), 0)
  const centralSize = bytes.readUInt32LE(endOffset + 12)
  const centralOffset = bytes.readUInt32LE(endOffset + 16)
  assert.equal(centralOffset + centralSize, endOffset)
  const entries = new Map()
  let offset = centralOffset
  let nextLocalOffset = 0
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50)
    const flags = bytes.readUInt16LE(offset + 8)
    assert.equal(flags & 0x0808, 0x0808, 'UTF-8 paths and streamed data descriptors must be declared.')
    assert.equal(bytes.readUInt16LE(offset + 10), 0, 'STORE entries keep the original bytes.')
    const checksum = bytes.readUInt32LE(offset + 16)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    assert.equal(compressedSize, size)
    const nameSize = bytes.readUInt16LE(offset + 28)
    const extraSize = bytes.readUInt16LE(offset + 30)
    const commentSize = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    assert.equal(localOffset, nextLocalOffset)
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    assert.ok(!entries.has(name), 'Entries must never replace each other.')
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !/[<>:"|?*\x00-\x1f\x7f]/.test(name))
    assert.ok(name.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment)), 'ZIP paths remain safe relative file paths.')
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50)
    assert.equal(bytes.readUInt16LE(localOffset + 6), flags)
    assert.equal(bytes.readUInt16LE(localOffset + 8), 0)
    const localNameSize = bytes.readUInt16LE(localOffset + 26)
    const localExtraSize = bytes.readUInt16LE(localOffset + 28)
    assert.deepEqual(bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize), nameBytes)
    const dataOffset = localOffset + 30 + localNameSize + localExtraSize
    const data = bytes.subarray(dataOffset, dataOffset + size)
    const descriptorOffset = dataOffset + size
    assert.equal(bytes.readUInt32LE(descriptorOffset), 0x08074b50)
    assert.equal(bytes.readUInt32LE(descriptorOffset + 4), checksum)
    assert.equal(bytes.readUInt32LE(descriptorOffset + 8), compressedSize)
    assert.equal(bytes.readUInt32LE(descriptorOffset + 12), size)
    assert.equal(crc32(data), checksum, 'An independently computed CRC32 must match every file.')
    entries.set(name, Buffer.from(data))
    nextLocalOffset = descriptorOffset + 16
    offset += 46 + nameSize + extraSize + commentSize
  }
  assert.equal(nextLocalOffset, centralOffset)
  assert.equal(offset, endOffset)
  assert.equal(entries.size, count)
  return entries
}

async function zip(response, expected) {
  await expect(response, 200)
  assert.match(response.headers.get('Content-Type') || '', /application\/zip/)
  assert.match(response.headers.get('Content-Disposition') || '', /attachment.*\.zip/i)
  assert.match(response.headers.get('Cache-Control') || '', /private/)
  assert.match(response.headers.get('Cache-Control') || '', /no-store/)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = zipEntries(bytes)
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort())
  for (const [name, content] of expected) assert.deepEqual(actual.get(name), content)
}

const allExpected = new Map([...fixtures.values()].map(file => [file.name, file.bytes]))
const exactExpected = new Map([[fixtures.get(targetKey).name, fixtures.get(targetKey).bytes]])
let reader, writer, exactReader, globalReader

try {
  await check('Only an isolated local installation is initialized and all fixtures and grants are tracked', async () => {
    assert.deepEqual(await (await expect(await call('/api/session', null), 200)).json(), { authenticated: false })
    const status = await (await expect(await call('/api/setup', null), 200)).json()
    assert.deepEqual(Object.keys(status), ['setupRequired'])
    if (status.setupRequired) {
      const response = await expect(await call('/api/setup', null, { method: 'POST', ...json({ displayName: 'Batch isolated workspace', adminPath: '/batch-console', apiToken: administrator }) }), 201)
      cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
      initialized = true
      const body = await response.json()
      assert.equal(body.setupTokenRequired, false)
      assert.equal(body.setupRequired, false)
    } else {
      assert.equal(process.env.MONO_BATCH_TEST_ISOLATED, 'true', 'Existing data requires an explicitly disposable instance.')
      assert.ok(process.env.MONO_API_TOKEN, 'An existing isolated instance requires its administrator credential.')
      const response = await expect(await call('/api/session', null, { method: 'POST', ...json({ token: administrator }) }), 200)
      cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
      initialized = true
    }
    assert.ok(cookie)
    const session = await (await expect(await call('/api/session', 'cookie'), 200)).json()
    assert.equal(session.local, true, 'Use LOCAL_DEVELOPMENT=true and a local Wrangler instance.')
    const known = (await (await expect(await call('/api/buckets', 'cookie'), 200)).json()).buckets.map(item => item.name)
    assert.ok(known.includes(bucket) && known.includes(otherBucket), 'Bind two separate local buckets before verification.')
    await registry()
    for (const [key, fixture] of fixtures) await put(key, fixture.bytes)
    await put(archiveKey, Buffer.from('other bucket fixture'), otherBucket)
    reader = await createToken('bucket read', { type: 'bucket', bucket }, ['read'])
    writer = await createToken('bucket write', { type: 'bucket', bucket }, ['write'])
    exactReader = await createToken('exact read', { type: 'file', bucket, key: targetKey }, ['read'])
    globalReader = await createToken('global read', { type: 'all' }, ['read'])
  })

  await check('Administrator and Cookie ZIP downloads preserve complete UTF-8 content and safe relative directories', async () => {
    await zip(await archive([...fixtures.keys()]), allExpected)
    await zip(await archive([...fixtures.keys()], 'cookie'), allExpected)
  })

  await check('Read grants can archive their scope, while writes and other buckets cannot expand access', async () => {
    await zip(await archive([...fixtures.keys()], reader.secret), allExpected)
    await denied(await archive([targetKey], writer.secret), 403, 'TOKEN_PERMISSION_DENIED')
    await denied(await archive([archiveKey], reader.secret, otherBucket), 403, 'TOKEN_SCOPE_DENIED')
    await zip(await archive([targetKey], globalReader.secret), exactExpected)
    await zip(await archive([archiveKey], globalReader.secret, otherBucket), new Map([[archiveKey, Buffer.from('other bucket fixture')]]))
  })

  await check('Exact-file grants only archive their bound file and reject every mixed or alternate scope before content reads', async () => {
    await zip(await archive([targetKey], exactReader.secret), exactExpected)
    await zip(await archive([targetKey, targetKey], exactReader.secret), exactExpected)
    for (const keys of [[siblingKey], [targetKey, siblingKey], [targetKey, `${prefix}missing.txt`], [`${targetKey}.bak`], [`${targetKey}/child.txt`]]) await denied(await archive(keys, exactReader.secret), 403, 'TOKEN_SCOPE_DENIED')
    await denied(await archive([archiveKey], exactReader.secret, otherBucket), 403, 'TOKEN_SCOPE_DENIED')
  })

  await check('Archive authentication keeps Cookie source protection and never falls back from an invalid Bearer', async () => {
    await denied(await archive([targetKey], null), 401)
    await denied(await archive([targetKey], 'invalid-batch-credential', bucket, { headers: { 'Content-Type': 'application/json', Cookie: cookie } }), 401)
    await denied(await call(path(bucket, 'archive'), 'cookie', { method: 'POST', ...json({ keys: [targetKey] }) }, false), 403)
    await denied(await archive([targetKey], 'cookie', bucket, { headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' } }), 403, 'ORIGIN_NOT_ALLOWED')
  })

  await check('Archive schemas reject ambiguous fields, invalid keys and over-limit requests without partial ZIP responses', async () => {
    for (const body of [{}, { keys: [] }, { keys: 'file.txt' }, { keys: [null] }, { keys: [123] }, { keys: [targetKey], extra: true }, { keys: Array.from({ length: 501 }, () => targetKey) }]) await denied(await call(path(bucket, 'archive'), 'cookie', { method: 'POST', ...json(body) }), 400)
    for (const key of ['../file.txt', '/file.txt', 'a//file.txt', 'a/./file.txt', 'a/../file.txt', '_mono/system-config.json', `${prefix}directory/`, 'x'.repeat(1025)]) await denied(await archive([key], 'cookie'), 400)
    for (const body of ['[1,2]', 'null', '{broken']) await denied(await call(path(bucket, 'archive'), 'cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 400, 'INVALID_JSON')
    await denied(await call(`${path(bucket, 'archive')}?extra=true`, 'cookie', { method: 'POST', ...json({ keys: [targetKey] }) }), 400, 'INVALID_ARCHIVE_QUERY')
    const oversized = JSON.stringify({ keys: [targetKey], padding: 'x'.repeat(1024 * 1024) })
    await denied(await call(path(bucket, 'archive'), 'cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversized }), 413, 'BODY_TOO_LARGE')
    await denied(await chunkedJson(path(bucket, 'archive'), { keys: [targetKey], padding: 'x'.repeat(1024 * 1024) }), 413, 'BODY_TOO_LARGE')
  })

  await check('Archive body size allows valid selections beyond 32 KiB while ordinary API JSON keeps its smaller limit', async () => {
    const keys = Array.from({ length: 90 }, () => longKey)
    assert.ok(Buffer.byteLength(JSON.stringify({ keys })) > 32 * 1024)
    await zip(await archive(keys, 'cookie'), new Map([[longKey, fixtures.get(longKey).bytes]]))
    await denied(await call(path(bucket, 'folders'), 'cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: `${prefix}not-created/`, padding: 'x'.repeat(33 * 1024) }) }), 413, 'BODY_TOO_LARGE')
    await denied(await chunkedJson(path(bucket, 'folders'), { key: `${prefix}not-created/`, padding: 'x'.repeat(33 * 1024) }), 413, 'BODY_TOO_LARGE')
  })

  await check('Missing objects and incompatible extraction paths cannot produce a seemingly successful archive', async () => {
    await denied(await archive([targetKey, `${prefix}missing.txt`], 'cookie'), 404, 'OBJECT_NOT_FOUND')
    for (const keys of [[`${prefix}Case.txt`, `${prefix}case.txt`], [`${prefix}é.txt`, `${prefix}e\u0301.txt`], [`${prefix}collision`, `${prefix}collision/child.txt`]]) await denied(await archive(keys, 'cookie'), 400, 'ARCHIVE_NAME_CONFLICT')
    await denied(await archive([`${prefix}invalid-\ud800.txt`], 'cookie'), 400, 'UNSAFE_ARCHIVE_PATH')
    for (const [key, fixture] of fixtures) {
      const response = await expect(await call(object(key), 'cookie'), 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes, 'Downloads and rejected archive requests must leave original files intact.')
    }
  })

  await check('Bulk-delete requests retain the 100-key limit and rejected batches leave their target files present', async () => {
    await denied(await call(path(bucket, 'objects'), 'cookie', { method: 'DELETE', ...json({ keys: Array.from({ length: 101 }, (_, index) => index ? `${prefix}not-created-${index}.txt` : targetKey) }) }), 400, 'INVALID_KEYS')
    const response = await expect(await call(object(targetKey), 'cookie'), 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtures.get(targetKey).bytes)
    await denied(await call(path(bucket, 'objects'), reader.secret, { method: 'DELETE', ...json({ keys: [targetKey] }) }), 403, 'TOKEN_PERMISSION_DENIED')
  })

  console.log(`\n${passed} batch verification scenarios passed.`)
} finally {
  let leftovers = 0
  if (initialized) {
    for (const [name, keys] of files) {
      const tracked = [...keys]
      for (let start = 0; start < tracked.length; start += 100) {
        const response = await call(path(name, 'objects'), 'cookie', { method: 'DELETE', ...json({ keys: tracked.slice(start, start + 100) }) }).catch(() => null)
        if (response?.status !== 200) leftovers++
      }
    }
    if (tokens.length) {
      await registry().catch(() => { registryETag = ''; leftovers++ })
      for (const token of tokens) {
        const response = await call(`/api/tokens/${token.id}`, 'cookie', { method: 'DELETE', headers: { 'If-Match': registryETag } }).catch(() => null)
        if (response?.status === 204) registryETag = response.headers.get('ETag') || ''
        else leftovers++
      }
    }
  }
  console.log(leftovers ? `Cleanup: ${leftovers} tracked operations remain only in the disposable instance.` : 'Cleanup: tracked files and active grants removed; installation state and revoked records remain only in the disposable instance.')
  if (leftovers) process.exitCode = 1
}
