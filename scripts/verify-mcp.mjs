import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// 仅支持本地隔离 Worker，禁止访问开发端口 8787 或远程站点。
const target = new URL(process.env.MONO_URL || 'http://127.0.0.1:8792')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || target.port === '8787') {
  throw new Error('MCP verification requires an isolated localhost Worker; the ordinary port 8787 is prohibited.')
}
const origin = target.origin
const administrator = process.env.MONO_API_TOKEN || `mono_mcp_verify_${randomBytes(24).toString('hex')}`
const bucket = process.env.MONO_BUCKET || 'workspace'
const otherBucket = process.env.MONO_OTHER_BUCKET || 'archive'
assert.ok(bucket !== otherBucket && [bucket, otherBucket].every(name => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)), 'Two distinct local bucket aliases are required.')
const prefix = `verify-mcp-${randomUUID()}/`
const targetKey = `${prefix}目标 + #?.txt`
const siblingKey = `${targetKey}.bak`
const archiveKey = `${prefix}private-archive.txt`
const largeKey = `${prefix}bounded.bin`
const text = '中文 MCP 内容\nUTF-8 + #? and literal paths.'
const privateContent = `private-fixture-${randomUUID()}`
const largeBytes = Buffer.alloc(1024 * 1024 + 31, 0x61)
const files = new Map([[bucket, new Set()], [otherBucket, new Set()]])
const folders = new Map([[bucket, new Set()], [otherBucket, new Set()]])
const tokens = new Map()
const shares = new Set()
const uploads = []
const clients = []
const handshake = []
let cookie = ''
let registryETag = ''
let privateName = ''
let privateAdminPath = ''
let requestId = 100
let passed = 0
let started = false
const protocol = '2025-11-25'
const guideURI = 'mono://docs/api'
const accessURI = 'mono://access/current'
const allPermissions = ['read', 'write', 'delete', 'create_folder', 'delete_folder', 'share']
const fixed = { type: 'bucket', bucket }
const exact = { type: 'file', bucket, key: targetKey }
const baseTools = ['mono_get_access_info', 'mono_api_guide', 'mono_list_buckets']
const readTools = ['mono_get_storage_stats', 'mono_list_objects', 'mono_get_metadata', 'mono_read_file']
const writeTools = ['mono_write_text', 'mono_write_base64', 'mono_create_upload', 'mono_upload_part', 'mono_complete_upload', 'mono_abort_upload']
const deleteTools = ['mono_delete_file', 'mono_delete_files']
const folderTools = ['mono_create_folder', 'mono_delete_folder']
const shareTools = ['mono_get_share', 'mono_revoke_share', 'mono_create_share']
const path = (name, resource, query) => `/api/buckets/${encodeURIComponent(name)}/${resource}${query ? `?${new URLSearchParams(query)}` : ''}`
const object = (key, name = bucket, extra = {}) => path(name, 'object', { key, ...extra })
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function guardedFetch(input, init = {}) {
  const destination = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(destination.origin, origin, 'Every test request must remain inside the isolated localhost origin.')
  const response = await fetch(input, { ...init, redirect: 'manual', signal: init.signal || AbortSignal.timeout(30_000) })
  if (destination.pathname === '/mcp' && typeof init.body === 'string') {
    let message
    try { message = JSON.parse(init.body) } catch {}
    if (message?.method === 'initialize' && response.ok) {
      const result = await response.clone().json()
      handshake.push({ version: result.result?.protocolVersion, session: response.headers.get('Mcp-Session-Id'), cache: response.headers.get('Cache-Control') || '' })
    }
  }
  return response
}

async function api(route, token = administrator, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('X-Mono-Client', 'web')
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  return guardedFetch(new URL(route, origin), { ...init, headers })
}

async function expect(response, status, label = 'HTTP request') {
  if (response.status !== status) {
    let code = ''
    try { code = (await response.clone().json()).error?.code || '' } catch {}
    assert.fail(`${label}: expected ${status}, received ${response.status}${code ? ` (${code})` : ''}`)
  }
  return response
}

function privateInfoAbsent(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of [administrator, cookie, privateName, privateAdminPath, ...[...tokens.values()].map(token => token.secret)].filter(Boolean)) {
    assert.ok(!serialized.includes(secret), 'Responses must not disclose administrator details or API credentials.')
  }
  assert.doesNotMatch(serialized, /"(?:apiTokenHash|tokenHash|credentialVersion|adminPath|displayName)"\s*:/)
}

function relativeGuide(value) {
  assert.ok(typeof value === 'string' && value.includes('MCP 路径：/mcp'))
  assert.ok(!value.includes(origin), 'Documentation must not embed the actual request origin.')
  privateInfoAbsent(value)
}

async function registry() {
  const response = await expect(await api('/api/tokens'), 200, 'Read local test registry')
  registryETag = response.headers.get('ETag')
  assert.ok(registryETag)
  return (await response.json()).tokens
}

async function createToken(name, scope, permissions) {
  const response = await expect(await api('/api/tokens', administrator, { method: 'POST', ...json({ name: `MCP ${name}`, scope, permissions }), headers: { 'Content-Type': 'application/json', 'If-Match': registryETag } }), 201, 'Create isolated test grant')
  registryETag = response.headers.get('ETag')
  const result = await response.json()
  assert.ok(typeof result.secret === 'string' && result.secret.length >= 24)
  const token = { ...result.token, secret: result.secret }
  tokens.set(token.id, token)
  return token
}

async function editToken(token, patch) {
  const response = await expect(await api(`/api/tokens/${token.id}`, administrator, { method: 'PATCH', ...json(patch), headers: { 'Content-Type': 'application/json', 'If-Match': registryETag } }), 200, 'Edit isolated test grant')
  registryETag = response.headers.get('ETag')
  Object.assign(token, (await response.json()).token)
}

async function revokeToken(token) {
  const response = await expect(await api(`/api/tokens/${token.id}`, administrator, { method: 'DELETE', headers: { 'If-Match': registryETag } }), 204, 'Revoke isolated test grant')
  registryETag = response.headers.get('ETag')
  token.revoked = true
}

async function put(key, content, name = bucket) {
  await expect(await api(object(key, name), administrator, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content }), 201, 'Create isolated fixture')
  files.get(name).add(key)
}

async function readBack(key, content, name = bucket) {
  const response = await expect(await api(object(key, name)), 200, 'Read fixture independently through HTTP API')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(content))
}

async function connect(token) {
  const client = new Client({ name: 'mono-local-mcp-verification', version: '1.0.0' }, { capabilities: {} })
  client.onerror = () => {}
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { Authorization: `Bearer ${token.secret}` }, redirect: 'manual' },
    fetch: guardedFetch,
    redirectPolicy: 'same-origin',
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  })
  clients.push(client)
  await client.connect(transport, { timeout: 20_000 })
  assert.equal(transport.sessionId, undefined, 'A fresh POST request must not depend on server session state.')
  return client
}

async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 })
  privateInfoAbsent(result)
  return result
}

async function ok(client, name, args = {}) {
  const result = await tool(client, name, args)
  if (result.isError) {
    const error = result.structuredContent?.error
    assert.fail(`${name} failed${error && Number.isInteger(error.status) && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.status} ${error.code})` : ''} within the current grant.`)
  }
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${name} must return structured data.`)
  assert.deepEqual(JSON.parse(result.content.find(item => item.type === 'text').text), result.structuredContent)
  return result.structuredContent
}

async function storageTotals(client, args = {}) {
  const seen = new Set()
  let cursor
  let objectCount = 0
  let totalBytes = 0
  for (let pages = 0; pages < 50; pages++) {
    const page = await ok(client, 'mono_get_storage_stats', { ...args, ...(cursor ? { cursor } : {}) })
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

async function denied(client, name, args = {}, status) {
  const result = await tool(client, name, args)
  assert.equal(result.isError, true, `${name} must reject this request.`)
  if (status !== undefined) assert.equal(result.structuredContent?.error?.status, status, `${name} must return a safe operation status.`)
  return result
}

async function list(client, names) {
  const result = await client.listTools(undefined, { timeout: 20_000 })
  privateInfoAbsent(result)
  assert.deepEqual(result.tools.map(item => item.name).sort(), [...names].sort())
  for (const item of result.tools) assert.equal(item.inputSchema.additionalProperties, false, 'Every tool must have a closed input schema.')
  return result.tools
}

function rpcBody(method = 'tools/list', params = {}) { return { jsonrpc: '2.0', id: requestId++, method, params } }

async function raw(body, token, init = {}) {
  const headers = new Headers({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': protocol, ...init.headers })
  if (token !== null && token !== undefined) headers.set('Authorization', `Bearer ${typeof token === 'string' ? token : token.secret}`)
  const method = init.method || 'POST'
  return guardedFetch(new URL('/mcp', origin), { ...init, method, headers, ...(!['GET', 'HEAD'].includes(method) ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
}

async function check(label, run) {
  await run()
  passed++
  console.log(`PASS ${label}`)
}

let readToken, writeToken, fileRead, fileAll, globalAll, createFolderToken, deleteFolderToken, shareOnly, readShare
let reader, writer, fileReader, fileManager, manager, folderCreator, folderDeleter, shareManager, sharer

try {
  await check('Disposable local instance, private administrator setup and tracked randomized fixtures', async () => {
    const session = await expect(await api('/api/session', null), 200)
    assert.deepEqual(await session.json(), { authenticated: false })
    const status = await (await expect(await api('/api/setup', null), 200)).json()
    assert.deepEqual(Object.keys(status), ['setupRequired'])
    if (status.setupRequired) {
      privateName = `MCP private ${randomUUID()}`
      privateAdminPath = `/mcp-private-${randomBytes(8).toString('hex')}`
      const response = await expect(await api('/api/setup', null, { method: 'POST', ...json({ displayName: privateName, adminPath: privateAdminPath, apiToken: administrator }) }), 201)
      cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
    } else {
      assert.equal(process.env.MONO_MCP_TEST_ISOLATED, 'true', 'Refuse existing configuration unless explicitly identified as a disposable MCP instance.')
      assert.ok(process.env.MONO_API_TOKEN, 'An existing isolated instance requires its supplied test administrator credential.')
      const response = await expect(await api('/api/session', null, { method: 'POST', ...json({ token: administrator }) }), 200)
      cookie = response.headers.get('Set-Cookie')?.split(';')[0] || ''
      const config = (await (await expect(await api('/api/config'), 200)).json()).config
      privateName = config.displayName
      privateAdminPath = config.adminPath
    }
    assert.ok(cookie)
    started = true
    const administratorSession = await (await expect(await api('/api/session'), 200)).json()
    assert.equal(administratorSession.local, true, 'Use LOCAL_DEVELOPMENT=true and wrangler --local.')
    const available = (await (await expect(await api('/api/buckets'), 200)).json()).buckets.map(item => item.name)
    assert.ok(available.includes(bucket) && available.includes(otherBucket), 'Two separate LOCAL R2 bindings are required.')
    await registry()
    await put(targetKey, text)
    await put(siblingKey, privateContent)
    await put(`${targetKey}/child.txt`, privateContent)
    await put(archiveKey, privateContent, otherBucket)
    await put(largeKey, largeBytes)
    readToken = await createToken('read', fixed, ['read'])
    writeToken = await createToken('write', fixed, ['write'])
    fileRead = await createToken('exact read', exact, ['read'])
    fileAll = await createToken('exact all', exact, ['read', 'write', 'delete', 'share'])
    globalAll = await createToken('all storage', { type: 'all' }, allPermissions)
    createFolderToken = await createToken('create directory', fixed, ['create_folder'])
    deleteFolderToken = await createToken('delete directory', fixed, ['delete_folder'])
    shareOnly = await createToken('share only', fixed, ['share'])
    readShare = await createToken('read and share', fixed, ['read', 'share'])
  })

  await check('Bearer is mandatory, Cookie cannot substitute, and API guidance requires authentication', async () => {
    for (const [token, headers] of [[null, {}], ['wrong_mcp_verification_credential', {}], [null, { Cookie: cookie }], ['wrong_mcp_verification_credential', { Cookie: cookie }]]) {
      const response = await expect(await raw(rpcBody(), token, { headers }), 401)
      assert.match(response.headers.get('WWW-Authenticate') || '', /^Bearer\b/)
      privateInfoAbsent(await response.text())
    }
    const foreign = await expect(await raw(rpcBody(), readToken, { headers: { Origin: 'https://untrusted.invalid' } }), 403)
    privateInfoAbsent(await foreign.text())
    const adminMcp = await expect(await raw(rpcBody(), administrator), 403)
    privateInfoAbsent(await adminMcp.text())
    const anonymousGuide = await expect(await api('/api/mcp/guide', null), 401)
    privateInfoAbsent(await anonymousGuide.text())
    const guide = await expect(await api('/api/mcp/guide', null, { headers: { Cookie: cookie } }), 200)
    assert.match(guide.headers.get('Content-Type') || '', /text\/markdown/)
    assert.match(guide.headers.get('Cache-Control') || '', /no-store/)
    const instructions = await guide.text()
    assert.ok(instructions.includes('https://your-domain.example/mcp') && instructions.includes('mono_get_access_info'))
    relativeGuide(instructions)
    const scopedGuide = await expect(await api('/api/mcp/guide', fileRead.secret), 200)
    const scopedText = await scopedGuide.text()
    assert.ok(scopedText.includes('单文件授权') && scopedText.includes(bucket))
    relativeGuide(scopedText)
    await expect(await api('/api/mcp/guide', null, { method: 'HEAD' }), 401)
    await expect(await api('/api/mcp/guide', administrator, { method: 'HEAD' }), 200)
    for (const method of ['GET', 'DELETE']) {
      const response = await expect(await raw('', readToken, { method }), 405)
      assert.equal(response.headers.get('Allow'), 'POST')
    }
  })

  await check('Standard SDK initialize, stateless requests, guide/access resources and workflow prompt', async () => {
    reader = await connect(readToken)
    assert.equal(reader.getServerVersion()?.name, 'mono-object-storage')
    assert.ok(reader.getServerCapabilities()?.tools && reader.getServerCapabilities()?.resources && reader.getServerCapabilities()?.prompts)
    assert.ok(handshake.some(item => item.version === protocol && item.session === null && /no-store/.test(item.cache)))
    const instructions = reader.getInstructions()
    assert.ok(instructions.includes(bucket) && instructions.includes('mono_read_file'))
    relativeGuide(instructions)
    const toolGuide = await ok(reader, 'mono_api_guide')
    assert.equal(toolGuide.guide, instructions)
    relativeGuide(toolGuide.guide)
    const resourceList = await reader.listResources()
    assert.deepEqual(resourceList.resources.map(item => item.uri).sort(), [guideURI, accessURI].sort())
    const guide = await reader.readResource({ uri: guideURI })
    assert.equal(guide.contents[0].mimeType, 'text/markdown')
    assert.equal(guide.contents[0].text, instructions)
    relativeGuide(guide.contents[0].text)
    const accessResource = await reader.readResource({ uri: accessURI })
    const access = JSON.parse(accessResource.contents[0].text)
    assert.equal(access.origin, origin)
    assert.deepEqual(access.scope, fixed)
    assert.deepEqual(access.permissions, ['read'])
    assert.equal(access.limits.maxReadBytes, 1024 * 1024)
    assert.equal(access.limits.mcpMultipartPartBytes, 5 * 1024 * 1024)
    privateInfoAbsent(access)
    const toolAccess = await ok(reader, 'mono_get_access_info')
    assert.deepEqual(toolAccess, access)
    assert.equal(toolAccess.origin, origin)
    const prompts = await reader.listPrompts()
    assert.deepEqual(prompts.prompts.map(item => item.name), ['mono_api_workflow'])
    const prompt = await reader.getPrompt({ name: 'mono_api_workflow' })
    assert.ok(prompt.messages.some(message => message.content.type === 'text' && message.content.text.includes('mono_get_access_info')))
    assert.ok(!JSON.stringify(prompt).includes(origin), 'Workflow prompt must not embed the actual request origin.')
    privateInfoAbsent(prompt)
    await reader.ping()
  })

  await check('Tools reflect independent permissions and managed ALL grants no administrator authority', async () => {
    writer = await connect(writeToken)
    fileReader = await connect(fileRead)
    fileManager = await connect(fileAll)
    manager = await connect(globalAll)
    folderCreator = await connect(createFolderToken)
    folderDeleter = await connect(deleteFolderToken)
    shareManager = await connect(shareOnly)
    sharer = await connect(readShare)
    await list(reader, [...baseTools, ...readTools])
    await list(writer, [...baseTools, ...writeTools])
    await list(fileReader, [...baseTools, ...readTools])
    await list(fileManager, [...baseTools, ...readTools, ...writeTools, ...deleteTools, ...shareTools])
    await list(manager, [...baseTools, ...readTools, ...writeTools, ...deleteTools, ...folderTools, ...shareTools])
    await list(folderCreator, [...baseTools, 'mono_create_folder'])
    await list(folderDeleter, [...baseTools, 'mono_delete_folder'])
    await list(shareManager, [...baseTools, 'mono_get_share', 'mono_revoke_share'])
    await list(sharer, [...baseTools, ...readTools, ...shareTools])
    const available = await ok(manager, 'mono_list_buckets')
    assert.deepEqual(Object.keys(available).sort(), ['buckets', 'capabilities'])
    assert.ok(available.buckets.some(item => item.name === otherBucket))
    await expect(await api('/api/config', globalAll.secret), 403)
    await expect(await api('/api/tokens', globalAll.secret), 403)
    await denied(manager, 'mono_create_token', { permissions: allPermissions })
    await denied(reader, 'mono_write_text', { key: targetKey, content: 'denied' })
    await denied(writer, 'mono_read_file', { key: targetKey })
    await readBack(targetKey, text)
  })

  await check('Exact file scope reveals only its target, rejects siblings, child paths, other buckets and partial batch deletion', async () => {
    const access = await ok(fileReader, 'mono_get_access_info')
    assert.equal(access.origin, origin)
    assert.deepEqual(access.scope, exact)
    assert.doesNotMatch(JSON.stringify(access), /archive/)
    const available = await ok(fileReader, 'mono_list_buckets')
    assert.deepEqual(available.buckets.map(item => item.name), [bucket])
    const entries = await ok(fileReader, 'mono_list_objects', { recursive: true })
    assert.deepEqual(entries.objects.map(item => item.key), [targetKey])
    assert.deepEqual(entries.folders, [])
    assert.equal(entries.cursor, null)
    assert.equal(entries.truncated, false)
    const stats = await ok(fileReader, 'mono_get_storage_stats')
    assert.deepEqual(stats, { objectCount: 1, totalBytes: Buffer.byteLength(text), cursor: null, truncated: false })
    for (const prefix of ['', exact.key.slice(0, exact.key.lastIndexOf('/') + 1), targetKey]) {
      assert.deepEqual(await ok(fileReader, 'mono_get_storage_stats', { prefix }), stats)
      const response = await expect(await api(path(bucket, 'stats', { prefix }), fileRead.secret), 200)
      assert.deepEqual(await response.json(), stats)
    }
    for (const prefix of [siblingKey, `${targetKey}/`, `${exact.key.slice(0, exact.key.lastIndexOf('/') + 1)}unrelated/`]) {
      const empty = { objectCount: 0, totalBytes: 0, cursor: null, truncated: false }
      assert.deepEqual(await ok(fileReader, 'mono_get_storage_stats', { prefix }), empty)
      const response = await expect(await api(path(bucket, 'stats', { prefix }), fileRead.secret), 200)
      assert.deepEqual(await response.json(), empty)
    }
    await denied(fileReader, 'mono_get_storage_stats', { bucket: otherBucket }, 403)
    const metadata = await ok(fileReader, 'mono_get_metadata')
    assert.equal(metadata.key, targetKey)
    assert.equal((await ok(fileReader, 'mono_read_file')).content, text)
    for (const args of [{ key: siblingKey }, { key: `${targetKey}/child.txt` }, { bucket: otherBucket, key: archiveKey }, { key: '_mono/system-config.json' }]) {
      await denied(fileReader, 'mono_get_metadata', args, 403)
      await denied(fileReader, 'mono_read_file', args, 403)
    }
    await denied(fileReader, 'mono_list_objects', { bucket: otherBucket }, 403)
    await denied(fileManager, 'mono_delete_files', { keys: [targetKey, siblingKey] }, 403)
    await readBack(targetKey, text)
    await readBack(siblingKey, privateContent)
  })

  await check('Directory statistics match the HTTP API, recurse under their prefix and exclude adjacent folders', async () => {
    const directory = `${prefix}目录 + #?/`
    const nested = `${directory}深层/`
    const adjacent = `${prefix}目录 + #?-副本/`
    const empty = `${prefix}统计空目录/`
    for (const key of [directory, nested, adjacent, empty]) {
      await ok(folderCreator, 'mono_create_folder', { key })
      folders.get(bucket).add(key)
    }
    const fixtures = new Map([
      [`${directory}readme.txt`, '目录内容'],
      [`${nested}report.bin`, Buffer.from([0, 1, 2, 255])],
      [`${nested}zero.bin`, Buffer.alloc(0)],
      [`${adjacent}outside.txt`, 'outside-directory'],
    ])
    for (const [key, content] of fixtures) await put(key, content)
    for (const [prefix, expected] of [
      [directory, { objectCount: 3, totalBytes: Buffer.byteLength('目录内容') + 4 }],
      [nested, { objectCount: 2, totalBytes: 4 }],
      [adjacent, { objectCount: 1, totalBytes: Buffer.byteLength('outside-directory') }],
      [empty, { objectCount: 0, totalBytes: 0 }],
      [`${targetKey}/`, { objectCount: 1, totalBytes: Buffer.byteLength(privateContent) }],
      ['_mono/', { objectCount: 0, totalBytes: 0 }],
    ]) {
      assert.deepEqual(await storageTotals(reader, { prefix }), expected)
      const response = await expect(await api(path(bucket, 'stats', { prefix }), readToken.secret), 200)
      assert.deepEqual(await response.json(), { ...expected, cursor: null, truncated: false })
    }
    let expectedBytes = 0
    for (const key of files.get(bucket)) {
      const response = await expect(await api(object(key, bucket, { metadata: 'true' })), 200)
      expectedBytes += (await response.json()).size
    }
    const expected = { objectCount: files.get(bucket).size, totalBytes: expectedBytes }
    assert.deepEqual(await storageTotals(reader, { prefix }), expected)
    const wholeBucket = await storageTotals(reader)
    assert.deepEqual(await storageTotals(reader, { prefix: '' }), wholeBucket)
    assert.ok(wholeBucket.objectCount >= expected.objectCount && wholeBucket.totalBytes >= expected.totalBytes)
    await denied(writer, 'mono_get_storage_stats', { prefix }, 400)
    await expect(await api(path(bucket, 'stats', { prefix }), writeToken.secret), 403)
    for (const invalidPrefix of [`/${prefix}`, `${prefix}../`, `${prefix}bad\npath/`]) {
      await denied(reader, 'mono_get_storage_stats', { prefix: invalidPrefix }, 400)
    }
  })

  await check('Closed schemas, unknown tools, invalid transport and oversized JSON reject without side effects or input echo', async () => {
    const marker = `no-echo-${randomUUID()}`
    for (const extra of [{ url: `https://untrusted.invalid/${marker}` }, { token: marker }, { headers: { Authorization: marker } }, { host: marker }, { path: marker }]) {
      const result = await denied(fileReader, 'mono_read_file', extra, 400)
      assert.ok(!JSON.stringify(result).includes(marker), 'Invalid input must not be echoed.')
    }
    const unknown = await denied(manager, marker, {}, 400)
    assert.ok(!JSON.stringify(unknown).includes(marker))
    await denied(writer, 'mono_write_text', { key: `${prefix}schema-denied.txt`, content: 'denied', url: 'https://untrusted.invalid/' }, 400)
    await expect(await api(object(`${prefix}schema-denied.txt`)), 404)
    await expect(await raw(rpcBody(), readToken, { headers: { 'Content-Type': 'text/plain' } }), 415)
    await expect(await raw(rpcBody(), readToken, { headers: { 'MCP-Protocol-Version': '1900-01-01' } }), 400)
    const malformed = await expect(await raw('{"jsonrpc":', writeToken), 400)
    assert.equal((await malformed.json()).error.code, -32700)
    const oversized = JSON.stringify(rpcBody('tools/call', { name: 'mono_write_text', arguments: { key: `${prefix}oversized.txt`, content: 'x'.repeat(2 * 1024 * 1024 + 1) } }))
    await expect(await raw(oversized, writeToken), 413)
    await expect(await api(object(`${prefix}oversized.txt`)), 404)
    await denied(reader, 'mono_read_file', { key: targetKey, maxBytes: 1024 * 1024 + 1 }, 400)
    await readBack(targetKey, text)
  })

  await check('UTF-8, binary ranges, bounded continuation, end offsets and cursor pagination preserve byte semantics', async () => {
    const content = await ok(fileReader, 'mono_read_file')
    assert.equal(content.content, text)
    assert.equal(content.bytesRead, Buffer.byteLength(text))
    assert.equal(content.truncated, false)
    await denied(fileReader, 'mono_read_file', { offset: 1, maxBytes: 2, encoding: 'utf8' }, 400)
    const range = await ok(fileReader, 'mono_read_file', { offset: 1, maxBytes: 2, encoding: 'base64' })
    assert.deepEqual(Buffer.from(range.content, 'base64'), Buffer.from(text).subarray(1, 3))
    assert.equal(range.bytesRead, 2)
    assert.equal(range.nextOffset, 3)
    const first = await ok(reader, 'mono_read_file', { key: largeKey, maxBytes: 1024 * 1024, encoding: 'base64' })
    assert.equal(first.bytesRead, 1024 * 1024)
    assert.equal(first.truncated, true)
    assert.equal(first.nextOffset, 1024 * 1024)
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1_500_000, 'The read result must be bounded even when the stored object is larger.')
    const last = await ok(reader, 'mono_read_file', { key: largeKey, offset: first.nextOffset, maxBytes: 1024 * 1024, encoding: 'base64' })
    assert.equal(last.bytesRead, 31)
    assert.equal(last.nextOffset, null)
    assert.equal(last.truncated, false)
    assert.deepEqual(Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(last.content, 'base64')]), largeBytes)
    const eof = await ok(reader, 'mono_read_file', { key: largeKey, offset: largeBytes.length })
    assert.equal(eof.bytesRead, 0)
    await denied(reader, 'mono_read_file', { key: largeKey, offset: largeBytes.length + 1 }, 400)
    const found = new Set()
    const cursors = new Set()
    let cursor
    for (let pages = 0; pages < 20; pages++) {
      const page = await ok(reader, 'mono_list_objects', { prefix, recursive: true, limit: 1, ...(cursor ? { cursor } : {}) })
      page.objects.forEach(item => found.add(item.key))
      if (!page.truncated) { cursor = undefined; break }
      assert.ok(typeof page.cursor === 'string' && page.cursor && !cursors.has(page.cursor), 'Truncated listings must advance to a fresh cursor.')
      cursors.add(page.cursor)
      cursor = page.cursor
    }
    assert.equal(cursor, undefined, 'Pagination must eventually finish.')
    assert.deepEqual([...found].sort(), [...files.get(bucket)].sort())
  })

  await check('Text/base64 uploads, conditional overwrite, byte limits and batch/single deletion work through authorized tools', async () => {
    const textKey = `${prefix}write-text.txt`
    const binaryKey = `${prefix}write-binary.bin`
    const binary = Buffer.from([0, 255, 128, 13, 10, 1])
    await ok(writer, 'mono_write_text', { key: textKey, content: '写入 UTF-8', contentType: 'text/plain; charset=utf-8', metadata: { source: 'mcp-test' } })
    files.get(bucket).add(textKey)
    await readBack(textKey, '写入 UTF-8')
    await denied(writer, 'mono_write_text', { key: textKey, content: 'implicit replacement' }, 409)
    const meta = await ok(reader, 'mono_get_metadata', { key: textKey })
    assert.equal(meta.metadata.source, 'mcp-test')
    await ok(writer, 'mono_write_text', { key: textKey, content: 'conditional replacement', ifMatch: meta.etag })
    await denied(writer, 'mono_write_text', { key: textKey, content: 'stale replacement', ifMatch: meta.etag }, 409)
    await readBack(textKey, 'conditional replacement')
    await ok(writer, 'mono_write_base64', { key: binaryKey, content: binary.toString('base64') })
    files.get(bucket).add(binaryKey)
    await readBack(binaryKey, binary)
    await denied(writer, 'mono_write_base64', { key: `${prefix}invalid-base64.bin`, content: 'not-base64!' }, 400)
    const oversizedKey = `${prefix}multibyte-oversized.txt`
    await denied(writer, 'mono_write_text', { key: oversizedKey, content: '中'.repeat(350_000) }, 413)
    await expect(await api(object(oversizedKey)), 404)
    await denied(writer, 'mono_delete_file', { key: binaryKey }, 400)
    await ok(manager, 'mono_delete_file', { bucket, key: binaryKey })
    await expect(await api(object(binaryKey)), 404)
    await denied(manager, 'mono_delete_files', { bucket, keys: Array.from({ length: 101 }, (_, index) => `${prefix}batch-${index}.txt`) }, 400)
    const batch = await ok(manager, 'mono_delete_files', { bucket, keys: [textKey] })
    assert.equal(batch.deleted, 1)
    await expect(await api(object(textKey)), 404)
  })

  await check('Directory creation/deletion remain independent and non-empty folders keep their contents', async () => {
    const directory = `${prefix}empty/`
    await ok(folderCreator, 'mono_create_folder', { key: directory })
    folders.get(bucket).add(directory)
    await denied(folderCreator, 'mono_delete_folder', { key: directory }, 400)
    await denied(folderDeleter, 'mono_create_folder', { key: `${prefix}denied-folder/` }, 400)
    await denied(folderCreator, 'mono_write_text', { key: `${directory}denied.txt`, content: 'denied' }, 400)
    await ok(folderDeleter, 'mono_delete_folder', { key: directory })
    const occupied = `${prefix}occupied/`
    await ok(folderCreator, 'mono_create_folder', { key: occupied })
    folders.get(bucket).add(occupied)
    await put(`${occupied}inside.txt`, 'survives folder deletion')
    await denied(folderDeleter, 'mono_delete_folder', { key: occupied }, 409)
    await readBack(`${occupied}inside.txt`, 'survives folder deletion')
    await denied(fileManager, 'mono_create_folder', { key: `${prefix}file-token-folder/` }, 400)
  })

  await check('Public shares require read+share to create and share-only management cannot read a file', async () => {
    await denied(reader, 'mono_create_share', { key: targetKey }, 400)
    await denied(shareManager, 'mono_create_share', { key: targetKey }, 400)
    await denied(shareManager, 'mono_read_file', { key: targetKey }, 400)
    const share = await ok(sharer, 'mono_create_share', { key: targetKey, expiresIn: 3600 })
    shares.add(targetKey)
    assert.match(share.id, /^[a-f0-9]{32}$/)
    assert.equal(new URL(share.absoluteUrl).origin, origin)
    await expect(await api(`/api/shares/${share.id}`, null), 200)
    const current = await ok(shareManager, 'mono_get_share', { key: targetKey })
    assert.equal(current.share.id, share.id)
    await denied(reader, 'mono_revoke_share', { key: targetKey }, 400)
    await ok(shareManager, 'mono_revoke_share', { key: targetKey })
    await expect(await api(`/api/shares/${share.id}`, null), 404)
  })

  await check('Multipart uploads cross the JSON part threshold, keep credential ownership, complete and abort cleanly', async () => {
    const multipartKey = `${prefix}multipart.bin`
    const firstBytes = Buffer.alloc(5 * 1024 * 1024, 0x6d)
    const finalBytes = Buffer.from('末片')
    const created = await ok(writer, 'mono_create_upload', { key: multipartKey, size: firstBytes.length + finalBytes.length })
    assert.equal(created.partSize, firstBytes.length)
    assert.equal(created.minimumNonFinalPartBytes, firstBytes.length)
    assert.ok(created.uploadToken)
    const upload = { key: multipartKey, bucket, uploadToken: created.uploadToken, owner: writer, finished: false }
    uploads.push(upload)
    await denied(manager, 'mono_upload_part', { bucket, uploadToken: upload.uploadToken, partNumber: 1, content: finalBytes.toString('base64') }, 403)
    const part1 = await ok(writer, 'mono_upload_part', { uploadToken: upload.uploadToken, partNumber: 1, content: firstBytes.toString('base64') })
    const part2 = await ok(writer, 'mono_upload_part', { uploadToken: upload.uploadToken, partNumber: 2, content: finalBytes.toString('base64') })
    await ok(writer, 'mono_complete_upload', { uploadToken: upload.uploadToken, parts: [{ partNumber: part1.partNumber, etag: part1.etag }, { partNumber: part2.partNumber, etag: part2.etag }] })
    upload.finished = true
    files.get(bucket).add(multipartKey)
    await readBack(multipartKey, Buffer.concat([firstBytes, finalBytes]))
    const abortKey = `${prefix}aborted.bin`
    const pending = await ok(writer, 'mono_create_upload', { key: abortKey, size: 8 })
    const aborted = { key: abortKey, bucket, uploadToken: pending.uploadToken, owner: writer, finished: false }
    uploads.push(aborted)
    await ok(writer, 'mono_upload_part', { uploadToken: pending.uploadToken, partNumber: 1, content: Buffer.from('abcdefgh').toString('base64') })
    await ok(writer, 'mono_abort_upload', { uploadToken: pending.uploadToken })
    aborted.finished = true
    await expect(await api(object(abortKey)), 404)
  })

  await check('Permission changes refresh the same client, and disable/revoke immediately reject later MCP requests', async () => {
    const changing = await createToken('live permissions', fixed, ['read', 'write'])
    const client = await connect(changing)
    await list(client, [...baseTools, ...readTools, ...writeTools])
    await editToken(changing, { permissions: ['read'] })
    await list(client, [...baseTools, ...readTools])
    await denied(client, 'mono_write_text', { key: `${prefix}stale-tool.txt`, content: 'denied' }, 400)
    await expect(await api(object(`${prefix}stale-tool.txt`)), 404)
    await editToken(changing, { enabled: false })
    await expect(await raw(rpcBody(), changing), 401)
    await assert.rejects(client.listTools(undefined, { timeout: 10_000 }), error => error.code === 401 || /401/.test(error.message))
    await editToken(changing, { enabled: true })
    await list(client, [...baseTools, ...readTools])
    await revokeToken(changing)
    await expect(await raw(rpcBody(), changing), 401)
    await assert.rejects(client.readResource({ uri: accessURI }, { timeout: 10_000 }), error => error.code === 401 || /401/.test(error.message))
  })

  console.log(`\n${passed} MCP verification scenarios passed with the standard SDK and isolated HTTP API fixtures.`)
} finally {
  let leftovers = 0
  if (started) {
    for (const upload of uploads.filter(item => !item.finished)) {
      try {
        await ok(upload.owner, 'mono_abort_upload', { bucket: upload.bucket, uploadToken: upload.uploadToken })
        upload.finished = true
      } catch { leftovers++ }
    }
    for (const key of shares) {
      const response = await api(path(bucket, 'shares', { key }), administrator, { method: 'DELETE' }).catch(() => null)
      if (response?.status !== 204) leftovers++
    }
    for (const [name, keys] of files) {
      if (!keys.size) continue
      const response = await api(path(name, 'objects'), administrator, { method: 'DELETE', ...json({ keys: [...keys] }) }).catch(() => null)
      if (!response?.ok) leftovers++
    }
    for (const [name, keys] of folders) {
      for (const key of [...keys].sort((a, b) => b.length - a.length)) {
        const response = await api(path(name, 'folders', { key }), administrator, { method: 'DELETE' }).catch(() => null)
        if (response?.status !== 204) leftovers++
      }
    }
    const active = await registry().catch(() => null)
    if (active === null) leftovers++
    else for (const token of active.filter(item => tokens.has(item.id))) {
      try { await revokeToken(tokens.get(token.id)) } catch { leftovers++ }
    }
  }
  await Promise.allSettled(clients.map(client => client.close()))
  console.log(leftovers ? `Cleanup: ${leftovers} tracked operations could not be cleaned; discard only the dedicated test persistence directory after stopping its Worker.` : 'Cleanup: tracked files, folders, shares and active grants removed; revoked-token tombstones remain only in the disposable instance.')
  if (leftovers) process.exitCode = 1
}
