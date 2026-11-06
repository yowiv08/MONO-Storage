import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8793')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.protocol !== 'http:' || !target.port || target.port === '8787' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Append verification requires a disposable localhost Worker outside port 8787.')
const administrator = process.env.MONO_API_TOKEN || `mono_append_${randomBytes(24).toString('hex')}`
const prefix = `verify-append-${randomUUID()}/`
const key = `${prefix}追加 + #?.md`
const files = new Set()
const tokens = []
const clients = []
let revision = ''
let initialized = false
let shareKey
let passed = 0
const resource = (name, params = {}) => `/api/buckets/workspace/${name}?${new URLSearchParams(params)}`
const object = (key, extra = {}) => resource('object', { key, ...extra })
const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

async function api(path, init = {}, token = administrator) {
  const url = new URL(path, target)
  assert.equal(url.origin, target.origin)
  const headers = new Headers(init.headers)
  headers.set('X-Mono-Client', 'web')
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
}
async function expect(response, status) {
  assert.equal(response.status, status, `Expected ${status}, received ${response.status}: ${response.ok ? '' : await response.clone().text()}`)
  return response
}
async function check(label, run) { await run(); console.log(`PASS ${label}`); passed++ }
async function read(key) { return Buffer.from(await (await expect(await api(object(key)), 200)).arrayBuffer()) }
async function put(key, body, headers = {}) {
  files.add(key)
  return expect(await api(object(key), { method: 'PUT', headers, body }), 201)
}
async function append(key, body, token = administrator, extra = {}, headers = {}) {
  return api(resource('object/append', { key, ...extra }), { method: 'POST', headers, body }, token)
}
async function setAppendLimit(value, status = 200, secret = administrator) {
  const current = await expect(await api('/api/config'), 200)
  revision = current.headers.get('ETag')
  const response = await expect(await api('/api/config', { method: 'PATCH', ...json({ appendMaxMiB: value }), headers: { 'Content-Type': 'application/json', 'If-Match': revision } }, secret), status)
  if (status === 200) revision = response.headers.get('ETag')
  return response
}
async function token(name, permissions, scope = { type: 'file', bucket: 'workspace', key }) {
  const response = await expect(await api('/api/tokens', { method: 'POST', ...json({ name, permissions, scope }), headers: { 'Content-Type': 'application/json', 'If-Match': revision } }), 201)
  revision = response.headers.get('ETag')
  const result = await response.json()
  tokens.push(result.token.id)
  return result.secret
}
async function client(secret) {
  const client = new Client({ name: 'mono-append-verification', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', target), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }))
  return client
}
async function tool(client, name, args, status) {
  const result = await client.callTool({ name, arguments: args })
  if (status) {
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent?.error?.status, status)
  } else assert.ok(!result.isError, JSON.stringify(result.structuredContent))
  return result.structuredContent
}

try {
  await check('Disposable local setup', async () => {
    const status = await (await api('/api/setup', {}, null)).json()
    if (status.setupRequired) await expect(await api('/api/setup', { method: 'POST', ...json({ displayName: 'Append verification', adminPath: '/append-verification', apiToken: administrator }) }, null), 201)
    else assert.ok(process.env.MONO_APPEND_TEST_ISOLATED === 'true' && process.env.MONO_API_TOKEN, 'Existing state must be explicitly disposable and supply its test credential.')
    initialized = true
    const session = await (await expect(await api('/api/session'), 200)).json()
    assert.equal(session.local, true)
    revision = (await expect(await api('/api/tokens'), 200)).headers.get('ETag')
  })
  const writer = await token('Append exact-file write', ['write'])
  const reader = await token('Append exact-file read', ['read'])
  const initial = Buffer.from('# 原文\r\n完整保留🙂\n')
  await put(key, initial, { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Object-Meta-Label': 'preserve-me' })

  await check('Write-only append preserves UTF-8 bytes, original metadata and exact newline behavior', async () => {
    const suffix = Buffer.from('追加中文🙂\r\nnext')
    const response = await expect(await append(key, suffix, writer, {}, { 'Content-Type': 'application/octet-stream', 'X-Object-Meta-Label': 'must-not-replace' }), 200)
    const result = await response.json()
    assert.equal(result.appendedBytes, suffix.length)
    assert.equal(result.size, initial.length + suffix.length)
    assert.equal(result.created, false)
    assert.equal(response.headers.get('ETag'), result.etag)
    assert.equal(result.metadata, undefined)
    assert.deepEqual(await read(key), Buffer.concat([initial, suffix]))
    const metadata = await (await api(object(key, { metadata: 'true' }))).json()
    assert.equal(metadata.contentType, 'text/markdown; charset=utf-8')
    assert.equal(metadata.metadata.label, 'preserve-me')
    await expect(await api(object(key), {}, writer), 403)
  })
  await check('Read-only, sibling, other bucket, system and directory writes are denied', async () => {
    await expect(await append(key, 'denied', reader), 403)
    await expect(await append(`${key}.bak`, 'denied', writer, { create: 'true' }), 403)
    await expect(await api(`/api/buckets/archive/object/append?${new URLSearchParams({ key, create: 'true' })}`, { method: 'POST', body: 'denied' }, writer), 403)
    await expect(await append('_mono/system-config.json', 'denied'), 400)
    await expect(await append(`${prefix}folder/`, 'denied'), 400)
    await expect(await append(key, 'denied', null), 401)
  })
  await check('Missing files require explicit create; create never replaces existing content', async () => {
    const missing = `${prefix}new.txt`
    await expect(await append(missing, 'first'), 404)
    files.add(missing)
    const result = await (await expect(await append(missing, 'first', administrator, { create: 'true' }, { 'Content-Type': 'text/plain' }), 201)).json()
    assert.equal(result.created, true)
    await expect(await append(missing, '+second', administrator, { create: 'true' }), 200)
    assert.equal((await read(missing)).toString(), 'first+second')
    await expect(await append(`${prefix}absent.txt`, 'bad', administrator, { create: 'true' }, { 'If-Match': 'stale' }), 409)
    await expect(await api(object(`${prefix}absent.txt`)), 404)
  })
  await check('Empty, malformed, ambiguous and unknown-length append requests do not mutate the file', async () => {
    const before = await read(key)
    await expect(await append(key, ''), 400)
    await expect(await append(key, 'bad', administrator, { overwrite: 'true' }), 400)
    await expect(await append(key, 'bad', administrator, { create: 'yes' }), 400)
    await expect(await append(key, 'bad', administrator, {}, { 'If-Match': '*' }), 400)
    await expect(await api(resource('object/append', { key }), { method: 'PUT', body: 'bad' }), 405)
    await expect(await api(resource('object/append', { key }), { method: 'POST', body: (async function* () { yield Buffer.from('chunked') })(), duplex: 'half' }), 411)
    assert.deepEqual(await read(key), before)
  })
  await check('Two callers sharing an ETag append exactly once; stale retries cannot duplicate content', async () => {
    const before = await read(key)
    const etag = (await api(object(key), { method: 'HEAD' })).headers.get('ETag')
    const suffix = 'conditional-once'
    const results = await Promise.all([append(key, suffix, writer, {}, { 'If-Match': etag }), append(key, suffix, writer, {}, { 'If-Match': etag })])
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409])
    assert.equal((await results.find(response => response.status === 409).json()).error.code, 'APPEND_CONFLICT')
    await expect(await append(key, suffix, writer, {}, { 'If-Match': etag }), 409)
    assert.deepEqual(await read(key), Buffer.concat([before, Buffer.from(suffix)]))
  })
  await check('Concurrent unconditional appends retain every successful chunk and reject conflicting attempts', async () => {
    const concurrent = `${prefix}concurrent.log`
    await put(concurrent, 'START\n')
    const chunks = Array.from({ length: 6 }, (_, index) => `${index}:` + String(index).repeat(256 * 1024) + '\n')
    const results = await Promise.all(chunks.map(chunk => append(concurrent, chunk)))
    for (const response of results) assert.ok([200, 409].includes(response.status), `Unexpected concurrent status ${response.status}`)
    const first = (await read(concurrent)).toString()
    assert.equal(first.length, 6 + chunks.reduce((sum, chunk, index) => sum + (results[index].status === 200 ? chunk.length : 0), 0))
    for (let index = 0; index < chunks.length; index++) {
      assert.equal(first.includes(chunks[index]), results[index].status === 200)
      if (results[index].status === 409) await expect(await append(concurrent, chunks[index]), 200)
    }
    const final = (await read(concurrent)).toString()
    assert.equal(final.length, 6 + chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    for (const chunk of chunks) assert.ok(final.includes(chunk))
  })
  await check('Appending invalidates old version-bound public shares', async () => {
    shareKey = key
    const share = await (await expect(await api(resource('shares'), { method: 'POST', ...json({ key, expiresIn: 3600 }) }), 201)).json()
    await expect(await api(`${share.url}/file`, {}, null), 200)
    await expect(await append(key, '\nnew version', writer), 200)
    await expect(await api(`${share.url}/file`, {}, null), 404)
  })
  await check('MCP exposes append only for write permission and appends text and Base64 on an exact-file grant', async () => {
    const writeClient = await client(writer)
    const readClient = await client(reader)
    const names = (await writeClient.listTools()).tools.map(item => item.name)
    assert.ok(names.includes('mono_append_text') && names.includes('mono_append_base64'))
    assert.ok(!(await readClient.listTools()).tools.some(item => item.name.startsWith('mono_append_')))
    const before = await read(key)
    const text = '\nMCP 追加🙂\n'
    const bytes = Buffer.from([0, 255, 1, 128])
    assert.equal((await tool(writeClient, 'mono_append_text', { content: text })).appendedBytes, Buffer.byteLength(text))
    await tool(writeClient, 'mono_append_base64', { content: bytes.toString('base64') })
    assert.deepEqual(await read(key), Buffer.concat([before, Buffer.from(text), bytes]))
    await tool(writeClient, 'mono_append_text', { key: `${key}.bak`, content: 'denied' }, 403)
    await tool(writeClient, 'mono_append_text', { content: 'stale', ifMatch: 'stale' }, 409)
    await tool(writeClient, 'mono_append_text', { content: '文'.repeat(400000) }, 413)
    const limits = (await tool(writeClient, 'mono_get_access_info', {})).limits
    assert.equal(limits.maxAppendBytes, 1024 * 1024)
    assert.equal(limits.maxAppendObjectBytes, 90 * 1024 * 1024)
  })
  await check('Streaming append reaches exactly 90 MiB and rejects any additional byte without mutation', async () => {
    const large = `${prefix}large.bin`
    const limit = 90 * 1024 * 1024
    await put(large, Buffer.alloc(limit - 5, 0x61))
    const result = await (await expect(await append(large, '12345'), 200)).json()
    assert.equal(result.size, limit)
    const end = await expect(await api(object(large), { headers: { Range: 'bytes=-8' } }), 206)
    assert.equal(await end.text(), 'aaa12345')
    await expect(await append(large, 'x'), 413)
    assert.equal((await api(object(large), { method: 'HEAD' })).headers.get('Content-Length'), String(limit))
    await setAppendLimit(128)
    assert.equal((await (await expect(await append(large, 'x'), 200)).json()).size, limit + 1)
    await setAppendLimit(90)
    await expect(await append(large, 'x'), 413)
    assert.equal((await api(object(large), { method: 'HEAD' })).headers.get('Content-Length'), String(limit + 1))
  })
  await check('Append settings validate bounds, require administrator access and update existing MCP clients immediately', async () => {
    for (const value of [null, 0, 5116, 1.5, '128']) await setAppendLimit(value, 400)
    await setAppendLimit(128, 403, writer)
    const configured = `${prefix}configured-limit.bin`
    await put(configured, Buffer.alloc(2 * 1024 * 1024 - 1, 0x62))
    revision = (await api('/api/tokens')).headers.get('ETag')
    const secret = await token('Configured append', ['write'], { type: 'file', bucket: 'workspace', key: configured })
    const sameClient = await client(secret)
    await setAppendLimit(1)
    await expect(await append(configured, 'x', secret), 413)
    await tool(sameClient, 'mono_append_text', { content: 'x' }, 413)
    assert.equal((await tool(sameClient, 'mono_get_access_info', {})).limits.maxAppendObjectBytes, 1024 * 1024)
    await setAppendLimit(2)
    assert.equal((await tool(sameClient, 'mono_append_text', { content: 'x' })).size, 2 * 1024 * 1024)
    await tool(sameClient, 'mono_append_text', { content: 'x' }, 413)
    await setAppendLimit(128)
    assert.equal((await (await api('/api/config')).json()).config.appendMaxMiB, 128)
    assert.equal((await (await api('/api/buckets', {}, secret)).json()).capabilities.appendMaxObjectBytes, 128 * 1024 * 1024)
    assert.equal((await tool(sameClient, 'mono_get_access_info', {})).limits.maxAppendObjectBytes, 128 * 1024 * 1024)
    assert.match((await tool(sameClient, 'mono_api_guide', {})).guide, /当前站点上限为 128 MiB/)
    assert.match(await (await api('/api/mcp/guide')).text(), /当前站点上限为 128 MiB/)
    await tool(sameClient, 'mono_append_text', { content: 'x' })
    await setAppendLimit(5115)
    assert.equal((await tool(sameClient, 'mono_get_access_info', {})).limits.maxAppendObjectBytes, 5115 * 1024 * 1024)
    await setAppendLimit(90)
  })
  console.log(`\n${passed} append verification scenarios passed.`)
} finally {
  await Promise.allSettled(clients.map(client => client.close()))
  if (initialized) {
    if (shareKey) await expect(await api(resource('shares', { key: shareKey }), { method: 'DELETE' }), 204)
    if (files.size) await expect(await api(resource('objects'), { method: 'DELETE', ...json({ keys: [...files] }) }), 200)
    revision = (await expect(await api('/api/tokens'), 200)).headers.get('ETag')
    for (const id of tokens) {
      const response = await expect(await api(`/api/tokens/${id}`, { method: 'DELETE', headers: { 'If-Match': revision } }), 204)
      revision = response.headers.get('ETag')
    }
    console.log('Cleanup: fixture files, shares and API tokens removed from the disposable instance.')
  }
}
