import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES } from '../shared/batch-files.ts'
import { ApiError } from '../worker/core.ts'
import { archiveEntryNames, archiveKeys, archiveResponse, type ArchiveStorage } from '../worker/archive.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function unpack(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const end = data.length - 22
  assert.equal(view.getUint32(end, true), 0x06054b50)
  const count = view.getUint16(end + 10, true)
  assert.equal(view.getUint16(end + 8, true), count)
  assert.equal(view.getUint16(end + 4, true), 0)
  const offset = view.getUint32(end + 16, true)
  const size = view.getUint32(end + 12, true)
  assert.equal(offset + size, end)
  const result = new Map<string, Uint8Array>()
  let cursor = offset
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    assert.equal(flags & 0x0808, 0x0808)
    const compressed = view.getUint32(cursor + 20, true)
    const uncompressed = view.getUint32(cursor + 24, true)
    const crc = view.getUint32(cursor + 16, true)
    const filenameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const name = decoder.decode(data.subarray(cursor + 46, cursor + 46 + filenameLength))
    const local = view.getUint32(cursor + 42, true)
    assert.equal(view.getUint32(local, true), 0x04034b50)
    assert.equal(view.getUint16(local + 6, true), flags)
    assert.equal(view.getUint16(local + 8, true), method)
    const localNameLength = view.getUint16(local + 26, true)
    const localExtraLength = view.getUint16(local + 28, true)
    assert.equal(decoder.decode(data.subarray(local + 30, local + 30 + localNameLength)), name)
    const start = local + 30 + localNameLength + localExtraLength
    const stored = data.subarray(start, start + compressed)
    const content = method === 0 ? stored : new Uint8Array(inflateRawSync(stored))
    assert.equal(content.length, uncompressed)
    assert.equal(crc32(content), crc)
    const descriptor = start + compressed
    assert.equal(view.getUint32(descriptor, true), 0x08074b50)
    assert.equal(view.getUint32(descriptor + 4, true), crc)
    assert.equal(view.getUint32(descriptor + 8, true), compressed)
    assert.equal(view.getUint32(descriptor + 12, true), uncompressed)
    result.set(name, new Uint8Array(content))
    cursor += 46 + filenameLength + extraLength + commentLength
  }
  assert.equal(cursor, end)
  return result
}

function fixtures(contents: Map<string, Uint8Array>, fixtureOptions: { chunkSize?: number } = {}): { storage: ArchiveStorage; heads: string[]; gets: string[] } {
  const heads: string[] = []
  const gets: string[] = []
  const storage: ArchiveStorage = {
    head: async key => { heads.push(key); const bytes = contents.get(key); return bytes ? { key, size: bytes.length, etag: `etag-${key}`, version: `version-${key}`, uploaded: new Date('2026-10-29T08:37:49Z') } : null },
    get: async (key, options) => {
      gets.push(key)
      assert.equal(options.onlyIf.etagMatches, `etag-${key}`)
      const bytes = contents.get(key)
      if (!bytes) return null
      let offset = 0
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return }
        const next = Math.min(offset + (fixtureOptions.chunkSize || 17), bytes.length)
        controller.enqueue(bytes.slice(offset, next)); offset = next
      } })
      return { key, size: bytes.length, etag: `etag-${key}`, version: `version-${key}`, body }
    },
  }
  return { storage, heads, gets }
}

const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected

test('ZIP STORE output has valid UTF-8 names, CRCs, descriptors, central offsets and full directory paths', async () => {
  const contents = new Map([
    ['中文/报告 + #.txt', encoder.encode('中文内容\n123456789')],
    ['different/报告 + #.txt', new Uint8Array([0, 1, 255, 33])],
    ['empty.bin', new Uint8Array()],
    ['many-chunks.dat', Uint8Array.from({ length: 200_013 }, (_, index) => index % 256)],
  ])
  const fixture = fixtures(contents)
  const response = await archiveResponse(fixture.storage, [...contents.keys()], 'workspace')
  assert.equal(response.headers.get('Content-Type'), 'application/zip')
  assert.match(response.headers.get('Content-Disposition')!, /attachment;.*\.zip/)
  assert.match(response.headers.get('Cache-Control')!, /private.*no-store/)
  assert.deepEqual(fixture.gets, ['中文/报告 + #.txt'], 'Only the first stream is opened before consumption.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.equal(Number(response.headers.get('Content-Length')), bytes.length)
  assert.deepEqual(unpack(bytes), contents)
  assert.deepEqual(fixture.heads, [...contents.keys()])
  assert.deepEqual(fixture.gets, [...contents.keys()])
})

test('Archive selection is strict and deduplicates keys while protecting system objects', () => {
  assert.deepEqual(archiveKeys({ keys: ['folder/a.txt', 'folder/a.txt', 'folder/b.txt'] }), ['folder/a.txt', 'folder/b.txt'])
  for (const body of [{ keys: [] }, { keys: Array.from({ length: MAX_ARCHIVE_FILES + 1 }, () => 'a') }, { keys: 'a' }]) assert.throws(() => archiveKeys(body), code('INVALID_ARCHIVE_KEYS'))
  assert.throws(() => archiveKeys({ keys: ['a'], target: 'other' }), code('INVALID_ARCHIVE_QUERY'))
  for (const key of ['_mono', '_mono/config.json']) assert.throws(() => archiveKeys({ keys: [key] }), code('RESERVED_KEY'))
  for (const key of ['/absolute', 'a/../b', 'a/./b', 'a//b', 'a/', 'a\n.txt']) assert.throws(() => archiveKeys({ keys: [key] }), code('INVALID_KEY'))
})

test('Extraction names escape platform-special characters, percent literals, trailing characters and device names safely', async () => {
  const keys = ['中文/文件 + #?.txt', 'C:\\path\\file.txt', 'value%3F.txt', 'a<*>|".txt', 'trailing. ', 'CON', 'con.txt', 'CON .txt', 'LPT¹.md', 'folder/NUL.json']
  const expected = ['中文/文件 + #%3F.txt', 'C%3A%5Cpath%5Cfile.txt', 'value%253F.txt', 'a%3C%2A%3E%7C%22.txt', 'trailing%2E%20', '%43ON', '%63on.txt', '%43ON .txt', '%4CPT¹.md', 'folder/%4EUL.json']
  assert.deepEqual(archiveEntryNames(keys), expected)
  const contents = new Map(keys.map(key => [key, encoder.encode(key)]))
  const response = await archiveResponse(fixtures(contents).storage, keys, 'workspace')
  const archive = unpack(new Uint8Array(await response.arrayBuffer()))
  assert.deepEqual([...archive.keys()], expected)
  for (const name of archive.keys()) assert.ok(!/[\\<>:"|?*]/.test(name) && !name.startsWith('/') && !name.split('/').some(segment => segment === '.' || segment === '..'))
})

test('Case, Unicode normalization and file-versus-directory collisions are refused before storage access', async () => {
  for (const keys of [['a.txt', 'A.txt'], ['caf\u00e9.txt', 'cafe\u0301.txt'], ['folder', 'folder/file.txt'], ['folder/file.txt', 'FOLDER']]) {
    assert.throws(() => archiveEntryNames(keys), code('ARCHIVE_NAME_CONFLICT'))
    const fixture = fixtures(new Map(keys.map(key => [key, encoder.encode('x')])))
    await assert.rejects(archiveResponse(fixture.storage, keys, 'workspace'), code('ARCHIVE_NAME_CONFLICT'))
    assert.deepEqual(fixture.heads, [])
    assert.deepEqual(fixture.gets, [])
  }
  assert.throws(() => archiveEntryNames(['invalid\ud800.txt']), code('UNSAFE_ARCHIVE_PATH'))
  assert.throws(() => archiveEntryNames(['文'.repeat(86) + '.txt']), code('UNSAFE_ARCHIVE_PATH'))
})

test('Missing objects, invalid metadata and total byte limits stop before opening file bodies', async () => {
  const missing = fixtures(new Map([['exists', encoder.encode('x')]]))
  await assert.rejects(archiveResponse(missing.storage, ['exists', 'missing'], 'workspace'), code('OBJECT_NOT_FOUND'))
  assert.deepEqual(missing.gets, [])
  for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const storage: ArchiveStorage = { head: async key => ({ key, size, etag: 'x' }), get: async () => { assert.fail('Invalid metadata cannot read body.') } }
    await assert.rejects(archiveResponse(storage, ['a'], 'workspace'), code('ARCHIVE_METADATA_INVALID'))
  }
  const large: ArchiveStorage = { head: async key => ({ key, size: MAX_ARCHIVE_BYTES + 1, etag: 'x' }), get: async () => { assert.fail('Too-large archives cannot read body.') } }
  await assert.rejects(archiveResponse(large, ['a'], 'workspace'), code('ARCHIVE_TOO_LARGE'))
})

test('The first conditional read rejects changed or deleted objects before a ZIP response is returned', async () => {
  for (const returned of [null, { key: 'a', size: 3, etag: 'changed' }, { key: 'other', size: 3, etag: 'x' }]) {
    const storage: ArchiveStorage = { head: async key => ({ key, size: 3, etag: 'x' }), get: async () => returned }
    await assert.rejects(archiveResponse(storage, ['a'], 'workspace'), code('ARCHIVE_CHANGED'))
  }
})

test('Changed later files, short/long bodies and stream failures reject consumers instead of producing completed ZIPs', async () => {
  const fixture = fixtures(new Map([['a', encoder.encode('a')], ['b', encoder.encode('b')]]))
  const originalGet = fixture.storage.get
  fixture.storage.get = async (key, options) => key === 'b' ? null : originalGet(key, options)
  const changed = await archiveResponse(fixture.storage, ['a', 'b'], 'workspace')
  await assert.rejects(changed.arrayBuffer(), code('ARCHIVE_CHANGED'))
  for (const [size, bodyBytes] of [[4, 3], [2, 3]]) {
    const storage: ArchiveStorage = {
      head: async key => ({ key, size, etag: 'x' }),
      get: async key => ({ key, size, etag: 'x', body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bodyBytes)); controller.close() } }) }),
    }
    const response = await archiveResponse(storage, ['a'], 'workspace')
    await assert.rejects(response.arrayBuffer(), code('ARCHIVE_CHANGED'))
  }
  const failed: ArchiveStorage = {
    head: async key => ({ key, size: 3, etag: 'x' }),
    get: async key => ({ key, size: 3, etag: 'x', body: new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('read failure')) } }) }),
  }
  await assert.rejects((await archiveResponse(failed, ['a'], 'workspace')).blob(), /read failure/)
})

test('Consumer cancellation and request abort close the active object without opening the remaining files', async () => {
  for (const abortRequest of [false, true]) {
    const controller = new AbortController()
    let cancelled = false
    const calls: string[] = []
    const storage: ArchiveStorage = {
      head: async key => ({ key, size: 3, etag: 'x' }),
      get: async key => { calls.push(key); return { key, size: 3, etag: 'x', body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }) } },
    }
    const response = await archiveResponse(storage, ['a', 'b'], 'workspace', controller.signal)
    const reader = response.body!.getReader()
    assert.equal((await reader.read()).done, false)
    if (abortRequest) {
      const waiting = reader.read()
      controller.abort()
      await assert.rejects(waiting, error => error instanceof DOMException && error.name === 'AbortError')
      await Promise.resolve()
    } else await reader.cancel()
    assert.equal(cancelled, true)
    assert.deepEqual(calls, ['a'])
  }
  const controller = new AbortController()
  controller.abort()
  const fixture = fixtures(new Map([['a', encoder.encode('x')]]))
  await assert.rejects(archiveResponse(fixture.storage, ['a'], 'workspace', controller.signal), error => error instanceof DOMException && error.name === 'AbortError')
  assert.deepEqual(fixture.heads, [])
  assert.deepEqual(fixture.gets, [])
})

test('Response consumption applies backpressure to subsequent object reads', async () => {
  const fixture = fixtures(new Map([['a', new Uint8Array(1_000_000)], ['b', encoder.encode('b')]]))
  const response = await archiveResponse(fixture.storage, ['a', 'b'], 'workspace')
  await Promise.resolve()
  assert.deepEqual(fixture.gets, ['a'])
  const reader = response.body!.getReader()
  await reader.read()
  await Promise.resolve()
  assert.deepEqual(fixture.gets, ['a'])
  await reader.cancel()
  assert.deepEqual(fixture.gets, ['a'])
})
