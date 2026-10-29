import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, hashSecret } from '../worker/core.ts'
import { listActiveSharesPage } from '../worker/share-list.ts'
import type { ShareRecord } from '../worker/shares.ts'

function fixture() {
  const records = new Map<string, string>()
  const heads = new Map<string, Record<string, unknown>>()
  const listed: { key: string }[] = []
  const listCalls: unknown[] = []
  const bucketCalls: string[] = []
  let reading = 0
  let peakReading = 0
  const primary = {
    async list(options: { prefix: string; limit: number; cursor?: string }) {
      listCalls.push(options)
      const start = Number(options.cursor || 0)
      const objects = listed.slice(start, start + options.limit)
      const next = start + objects.length
      return next < listed.length ? { objects, truncated: true, cursor: String(next) } : { objects, truncated: false }
    },
    async get(key: string) {
      reading++
      peakReading = Math.max(peakReading, reading)
      await Promise.resolve()
      reading--
      const text = records.get(key)
      return text === undefined ? null : { key, size: Buffer.byteLength(text), text: async () => text }
    },
  }
  const getBucket = (name: string) => {
    bucketCalls.push(name)
    return { head: async (key: string) => heads.get(`${name}/${key}`) || null }
  }
  async function add(index: number, changes: Partial<ShareRecord> = {}, indexChanges: Partial<ShareRecord> = {}) {
    const share: ShareRecord = { id: index.toString(16).padStart(32, '0'), bucket: 'workspace', key: `docs/${index}.txt`, objectVersion: `object-${index}`, fingerprint: 'current-installation', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: null, revoked: false, ...changes }
    const link = `_mono/shares/links/${share.id}.json`
    listed.push({ key: link })
    records.set(link, JSON.stringify(share))
    records.set(`_mono/shares/objects/${await hashSecret(`${share.bucket}\n${share.key}`)}.json`, JSON.stringify({ ...share, ...indexChanges }))
    heads.set(`${share.bucket}/${share.key}`, { key: share.key, size: 123, version: share.objectVersion, uploaded: new Date('2026-01-02T00:00:00.000Z'), httpMetadata: { contentType: 'text/plain' }, customMetadata: { secret: 'private-metadata' } })
    return share
  }
  return { primary, getBucket, add, records, heads, listed, listCalls, bucketCalls, peak: () => peakReading }
}

test('Share overview filters stale, revoked, expired, replaced, deleted and unauthorized records without private metadata', async () => {
  const f = fixture()
  const active = await f.add(1)
  await f.add(2, { revoked: true })
  await f.add(3, { expiresAt: '2000-01-01T00:00:00.000Z' })
  await f.add(4, { fingerprint: 'previous-installation' })
  await f.add(5, {}, { id: 'f'.repeat(32) })
  const overwritten = await f.add(6)
  f.heads.get(`${overwritten.bucket}/${overwritten.key}`)!.version = 'new-object-version'
  const deleted = await f.add(7)
  f.heads.delete(`${deleted.bucket}/${deleted.key}`)
  await f.add(8, { bucket: 'archive' })
  await f.add(9, { key: '_mono/system-config.json' })
  await f.add(10, {}, { revoked: true })
  const result = await listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation')
  assert.deepEqual(result, { shares: [{ id: active.id, url: `/s/${active.id}`, createdAt: active.createdAt, expiresAt: null, bucket: 'workspace', key: active.key, size: 123, contentType: 'text/plain', uploaded: '2026-01-02T00:00:00.000Z' }], cursor: null, truncated: false })
  assert.ok(!JSON.stringify(result).includes('fingerprint') && !JSON.stringify(result).includes('private-metadata') && !JSON.stringify(result).includes('objectVersion'))
  assert.ok(!f.bucketCalls.includes('archive'), 'An excluded bucket must not be queried.')
  assert.ok(f.peak() <= 6, 'Share record reads must stay bounded even when a page contains many entries.')
})

test('A full invalid page returns its cursor and the next page supplies the remaining active share', async () => {
  const f = fixture()
  for (let index = 1; index <= 100; index++) await f.add(index, { revoked: true })
  const active = await f.add(101)
  const first = await listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation')
  assert.deepEqual(first, { shares: [], truncated: true, cursor: '100' })
  const second = await listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation', first.cursor!)
  assert.deepEqual(second.shares.map(share => share.id), [active.id])
  assert.equal(second.truncated, false)
  assert.equal(second.cursor, null)
  assert.deepEqual(f.listCalls, [{ prefix: '_mono/shares/links/', limit: 100 }, { prefix: '_mono/shares/links/', limit: 100, cursor: '100' }])
})

test('Malformed records are ignored and invalid cursor responses fail before an unbounded scan', async () => {
  const f = fixture()
  const invalid = await f.add(1)
  f.records.set(`_mono/shares/links/${invalid.id}.json`, '{malformed-json')
  const oversized = await f.add(2)
  f.records.set(`_mono/shares/links/${oversized.id}.json`, 'x'.repeat(16 * 1024 + 1))
  assert.deepEqual((await listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation')).shares, [])
  const calls = f.listCalls.length
  for (const cursor of ['bad\nnext', 'x'.repeat(4097)]) await assert.rejects(listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation', cursor), error => error instanceof ApiError && error.status === 400)
  assert.equal(f.listCalls.length, calls)
  const looping = { ...f.primary, list: async () => ({ objects: [], truncated: true, cursor: 'same' }) }
  await assert.rejects(listActiveSharesPage(looping as never, f.getBucket as never, ['workspace'], 'current-installation', 'same'), error => error instanceof ApiError && error.code === 'INVALID_SHARES_CURSOR')
  const excessive = { ...f.primary, list: async () => ({ objects: Array.from({ length: 101 }, () => ({ key: 'irrelevant' })), truncated: false }) }
  await assert.rejects(listActiveSharesPage(excessive as never, f.getBucket as never, ['workspace'], 'current-installation'), error => error instanceof ApiError && error.code === 'INVALID_SHARE_STORAGE')
})

test('Storage mismatches and outages never produce an apparently complete valid share list', async () => {
  const f = fixture()
  const share = await f.add(1)
  f.heads.get(`${share.bucket}/${share.key}`)!.key = 'docs/sibling.txt'
  await assert.rejects(listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation'), error => error instanceof ApiError && error.status === 503)
  f.heads.get(`${share.bucket}/${share.key}`)!.key = share.key
  f.heads.get(`${share.bucket}/${share.key}`)!.size = -1
  await assert.rejects(listActiveSharesPage(f.primary as never, f.getBucket as never, ['workspace'], 'current-installation'), error => error instanceof ApiError && error.status === 503)
  const unavailable = { ...f.primary, get: async () => { throw new Error('Storage unavailable') } }
  await assert.rejects(listActiveSharesPage(unavailable as never, f.getBucket as never, ['workspace'], 'current-installation'))
})
