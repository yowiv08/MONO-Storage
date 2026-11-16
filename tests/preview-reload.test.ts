import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { decodePreviewText, fetchDocumentPreview, MAX_DOCUMENT_BYTES, MAX_TEXT_PREVIEW_BYTES, PreviewChangedError } from '../src/preview-data.ts'
import type { StoredObject } from '../src/public-api.ts'

const sourceUrl = '/api/buckets/workspace/object?key=payfree%2Fpayfree.txt'
const metadataUrl = sourceUrl + '&metadata=true'

function object(content: string, etag: string, changes: Partial<StoredObject> = {}): StoredObject {
  return { key: 'payfree/payfree.txt', size: new TextEncoder().encode(content).byteLength, etag, contentType: 'text/plain', uploaded: '2026-11-16T14:47:10.306Z', metadata: {}, ...changes }
}

function mockRequests(t: TestContext, respond: (url: URL, init: RequestInit) => Response) {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://storage.example.test') })
  t.after(() => {
    if (location) Object.defineProperty(globalThis, 'location', location)
    else Reflect.deleteProperty(globalThis, 'location')
  })
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    requests.push(input.pathname + input.search)
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('X-Mono-Client'), 'web')
    return respond(input, init)
  })
  return requests
}

test('Opening and reloading a preview refresh both the stale revision and size before reading content', async t => {
  const stale = object('old', 'old')
  let content = '当前文件内容\n'
  let current = object(content, 'current')
  const requests = mockRequests(t, url => url.searchParams.has('metadata')
    ? Response.json(current)
    : new Response(content, { headers: { ETag: 'W/"' + current.etag + '"' } }))
  const initial = await fetchDocumentPreview(sourceUrl, stale, new AbortController().signal, metadataUrl)
  assert.equal(decodePreviewText(initial.data), content)
  assert.deepEqual(initial.object, current)
  content += '文件已追加的新内容\n'
  current = object(content, 'appended')
  const reloaded = await fetchDocumentPreview(sourceUrl, stale, new AbortController().signal, metadataUrl)
  assert.equal(decodePreviewText(reloaded.data), content)
  assert.deepEqual(reloaded.object, current)
  assert.equal(reloaded.data.byteLength, current.size)
  assert.equal(reloaded.truncated, false)
  assert.deepEqual(requests, [metadataUrl, sourceUrl, metadataUrl, sourceUrl])
  assert.equal(stale.etag, 'old')
})

for (const failure of ['etag', 'conflict']) {
  test('A concurrent write detected by ' + failure + ' refreshes metadata and retries once', async t => {
    const content = 'new content'
    let metadataReads = 0
    let contentReads = 0
    const requests = mockRequests(t, url => {
      if (url.searchParams.has('metadata')) return Response.json(object(content, ++metadataReads === 1 ? 'v1' : 'v2'))
      if (++contentReads === 1 && failure === 'conflict') return Response.json({ error: { code: 'OBJECT_CHANGED', message: '文件已发生变化，请重新获取。' } }, { status: 409 })
      return new Response(content, { headers: { ETag: 'W/"v2"' } })
    })
    const result = await fetchDocumentPreview(sourceUrl, object('old', 'old'), new AbortController().signal, metadataUrl)
    assert.equal(result.object.etag, 'v2')
    assert.equal(decodePreviewText(result.data), content)
    assert.deepEqual(requests, [metadataUrl, sourceUrl, metadataUrl, sourceUrl])
  })
}

test('Repeated concurrent changes stop after one retry, and a later manual reload can recover', async t => {
  let busy = true
  const content = 'stable content'
  const requests = mockRequests(t, url => {
    if (url.searchParams.has('metadata')) return Response.json(object(content, 'stable'))
    if (busy) return Response.json({ error: { code: 'OBJECT_CHANGED' } }, { status: 409 })
    return new Response(content, { headers: { ETag: '"stable"' } })
  })
  const stale = object('old', 'old')
  await assert.rejects(fetchDocumentPreview(sourceUrl, stale, new AbortController().signal, metadataUrl), PreviewChangedError)
  assert.equal(requests.length, 4)
  busy = false
  const result = await fetchDocumentPreview(sourceUrl, stale, new AbortController().signal, metadataUrl)
  assert.equal(decodePreviewText(result.data), content)
  assert.equal(result.object.etag, 'stable')
  assert.equal(requests.length, 6)
})

test('Public preview metadata is refreshed through its share endpoint and supplies the current document type', async t => {
  const content = '{"updated":true}'
  const stale = object('old', 'old', { key: 'data' })
  const current = object(content, 'current', { key: 'data', contentType: 'application/json' })
  const requests = mockRequests(t, url => url.pathname === '/api/shares/example'
    ? Response.json({ object: current, expiresAt: null, previewUrl: '/s/example/file' })
    : new Response(content, { headers: { ETag: '"current"' } }))
  const result = await fetchDocumentPreview('/s/example/file', stale, new AbortController().signal, '/api/shares/example')
  assert.deepEqual(result.object, current)
  assert.equal(result.kind, 'json')
  assert.equal(decodePreviewText(result.data), content)
  assert.deepEqual(requests, ['/api/shares/example', '/s/example/file'])
})

test('Missing, revoked or unauthorized share metadata never falls back to the cached file', async t => {
  let status = 404
  const requests = mockRequests(t, () => Response.json({ error: { code: 'OBJECT_NOT_FOUND', message: '文件不存在或分享已经失效。' } }, { status }))
  for (status of [404, 403]) {
    await assert.rejects(fetchDocumentPreview('/s/example/file', object('old', 'old'), new AbortController().signal, '/api/shares/example'), /不存在或分享已经失效/)
  }
  assert.deepEqual(requests, ['/api/shares/example', '/api/shares/example'])
})

test('Aborting metadata refresh prevents any subsequent content request', async t => {
  const controller = new AbortController()
  const requests = mockRequests(t, () => {
    controller.abort()
    return Response.json(object('content', 'current'))
  })
  await assert.rejects(fetchDocumentPreview(sourceUrl, object('old', 'old'), controller.signal, metadataUrl), error => error instanceof DOMException && error.name === 'AbortError')
  assert.deepEqual(requests, [metadataUrl])
})

test('Fresh metadata enforces the binary size limit before downloading a file that has grown', async t => {
  const stale = object('old', 'old', { key: 'report.pdf', contentType: 'application/pdf' })
  const requests = mockRequests(t, () => Response.json({ ...stale, etag: 'larger', size: MAX_DOCUMENT_BYTES + 1 }))
  await assert.rejects(fetchDocumentPreview(sourceUrl, stale, new AbortController().signal, metadataUrl), /32 MiB/)
  assert.deepEqual(requests, [metadataUrl])
})

test('A text file that grew beyond the limit uses its fresh size for a bounded range preview', async t => {
  const current = object('', 'large', { size: MAX_TEXT_PREVIEW_BYTES + 100 })
  const requests = mockRequests(t, (url, init) => {
    if (url.searchParams.has('metadata')) return Response.json(current)
    assert.equal(new Headers(init.headers).get('Range'), 'bytes=0-' + (MAX_TEXT_PREVIEW_BYTES - 1))
    return new Response(new Uint8Array(MAX_TEXT_PREVIEW_BYTES), { status: 206, headers: { ETag: 'W/"large"' } })
  })
  const result = await fetchDocumentPreview(sourceUrl, object('old', 'old'), new AbortController().signal, metadataUrl)
  assert.equal(result.data.byteLength, MAX_TEXT_PREVIEW_BYTES)
  assert.equal(result.truncated, true)
  assert.equal(result.object.size, current.size)
  assert.deepEqual(requests, [metadataUrl, sourceUrl])
})

test('Invalid or mismatched metadata stops before fetching any file contents', async t => {
  let payload: unknown
  const requests = mockRequests(t, () => Response.json(payload))
  for (payload of [null, { ...object('x', 'v1'), key: 'another.txt' }, { ...object('x', 'v1'), size: -1 }, { ...object('x', 'v1'), metadata: null }]) {
    await assert.rejects(fetchDocumentPreview(sourceUrl, object('old', 'old'), new AbortController().signal, metadataUrl), /文件信息无效/)
  }
  assert.deepEqual(requests, Array(4).fill(metadataUrl))
  await assert.rejects(fetchDocumentPreview(sourceUrl, object('old', 'old'), new AbortController().signal, 'https://another.example.test/metadata'), /预览地址无效/)
  assert.equal(requests.length, 4)
})
