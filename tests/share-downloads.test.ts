import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, hashSecret } from '../worker/core.ts'
import { objectResponse } from '../worker/objects.ts'
import { createShare, currentShare, enableShareUpdates, resolveShare, revokeShare, shareInfo } from '../worker/shares.ts'

const bucketName = 'workspace'
const key = 'logs/payfree.txt'
const fingerprint = 'test-installation'

async function fixture() {
  const records = new Map<string, { text: string; etag: string }>()
  const indexKey = `_mono/shares/objects/${await hashSecret(`${bucketName}\n${key}`)}.json`
  let writes = 0
  let deletes = 0
  let beforePut: (() => void) | undefined
  const storage = {
    async get(path: string) {
      const record = records.get(path)
      return record ? { etag: record.etag, json: async () => JSON.parse(record.text) } : null
    },
    async put(path: string, text: string, options: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } } = {}) {
      beforePut?.(); beforePut = undefined
      const current = records.get(path)
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null
      if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null
      const etag = `record-${++writes}`
      records.set(path, { text, etag })
      return { etag }
    },
    async delete(path: string) { deletes++; records.delete(path) },
  }
  let version = 1
  let text = 'first 中文'
  let exists = true
  const head = () => ({ key, version: `v${version}`, etag: `content-${version}`, httpEtag: `"content-${version}"`, size: Buffer.byteLength(text), uploaded: new Date(version * 1000), httpMetadata: { contentType: 'text/plain; charset=utf-8' } })
  const bucket = {
    async head(path: string) { assert.equal(path, key); return exists ? head() : null },
    async get(path: string, options: { onlyIf?: { etagMatches: string }; range?: { offset: number; length: number } }) {
      assert.equal(path, key)
      if (!exists) return null
      const current = head()
      if (options.onlyIf?.etagMatches !== current.etag) return current
      const bytes = Buffer.from(text)
      const body = options.range ? bytes.subarray(options.range.offset, options.range.offset + options.range.length) : bytes
      return { ...current, body }
    },
  }
  const getBucket = (name: string) => { assert.equal(name, bucketName); return bucket as never }
  const create = (followUpdates?: unknown, expiresIn: unknown = null) => createShare(storage as never, bucketName, key, head() as never, fingerprint, expiresIn, followUpdates)
  const resolve = (id: string, currentFingerprint = fingerprint) => resolveShare(storage as never, id, currentFingerprint, getBucket)
  async function download(id: string, method = 'GET', headers = {}) {
    const resolved = await resolve(id)
    return objectResponse(new Request(`https://storage.example/s/${id}/file?download=true`, { method, headers }), resolved.bucket, resolved.share.key, true, resolved.share.followUpdates ? undefined : resolved.share.objectVersion)
  }
  return {
    records, storage, indexKey, head, create, resolve, download,
    enable: (id: unknown, currentFingerprint = fingerprint) => enableShareUpdates(storage as never, bucketName, key, id, currentFingerprint),
    revoke: () => revokeShare(storage as never, bucketName, key),
    current: () => currentShare(storage as never, bucketName, key, head() as never, fingerprint),
    update: (content: string) => { text = content; version++ },
    remove: () => { exists = false },
    counts: () => ({ writes, deletes }),
    beforePut: (action: () => void) => { beforePut = action },
  }
}

const unavailable = (error: unknown) => error instanceof ApiError && error.status === 404

test('Repeated GET, HEAD, Range and conditional downloads do not consume a version-bound share', async () => {
  const f = await fixture()
  const share = await f.create()
  assert.equal(shareInfo(share).followUpdates, false)
  const writes = f.counts()
  for (let i = 0; i < 3; i++) {
    const response = await f.download(share.id)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'first 中文')
    assert.match(response.headers.get('Content-Disposition')!, /attachment/)
  }
  const head = await f.download(share.id, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const range = await f.download(share.id, 'GET', { Range: 'bytes=0-4' })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), 'first')
  assert.equal((await f.download(share.id, 'GET', { 'If-None-Match': head.headers.get('ETag')! })).status, 304)
  assert.equal((await f.current())?.id, share.id)
  assert.deepEqual(f.counts(), writes, 'Reading must not write or delete share records.')
  f.update('first 中文\nappended')
  await assert.rejects(f.download(share.id), unavailable)
  assert.equal(await f.current(), null)
})

test('An explicitly selected following share survives append and overwrite with fresh headers and contents', async () => {
  const f = await fixture()
  const share = await f.create(true)
  const records = [...f.records]
  for (const content of ['first 中文', 'first 中文\n追加', 'replacement 最新']) {
    f.update(content)
    for (let i = 0; i < 2; i++) {
      const response = await f.download(share.id)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('ETag'), f.head().httpEtag)
      assert.equal(Number(response.headers.get('Content-Length')), Buffer.byteLength(content))
      assert.equal(await response.text(), content)
    }
    assert.equal((await f.current())?.id, share.id)
  }
  assert.deepEqual([...f.records], records)
  f.remove()
  await assert.rejects(f.download(share.id), unavailable)
})

test('Explicitly enabling an existing stale link preserves its ID and expiry with one conditional index update', async () => {
  const f = await fixture()
  const share = await f.create(false, 3600)
  const linkKey = `_mono/shares/links/${share.id}.json`
  const original = { ...share }
  delete original.followUpdates
  for (const path of [linkKey, f.indexKey]) f.records.get(path)!.text = JSON.stringify(original)
  f.update('new file version')
  await assert.rejects(f.download(share.id), unavailable)
  const writes = f.counts().writes
  const updated = await f.enable(share.id)
  assert.equal(updated.id, share.id)
  assert.equal(updated.expiresAt, share.expiresAt)
  assert.equal(updated.objectVersion, share.objectVersion)
  assert.equal(updated.followUpdates, true)
  assert.equal(f.records.get(linkKey)!.text, JSON.stringify(original), 'The original link identity remains immutable.')
  assert.equal(f.counts().writes, writes + 1)
  assert.equal(await (await f.download(share.id)).text(), 'new file version')
  await f.enable(share.id)
  assert.equal(f.counts().writes, writes + 1, 'Retrying an already enabled mode is idempotent.')
})

test('Following shares still honor expiry, revocation, replacement, installation and immutable identity checks', async () => {
  for (const reason of ['expired', 'revoked', 'replaced', 'installation', 'identity']) {
    const f = await fixture()
    const share = await f.create(true)
    if (reason === 'expired') {
      for (const path of [f.indexKey, `_mono/shares/links/${share.id}.json`]) {
        const record = f.records.get(path)!
        record.text = JSON.stringify({ ...JSON.parse(record.text), expiresAt: '2000-01-01T00:00:00.000Z' })
      }
    }
    if (reason === 'revoked') await f.revoke()
    if (reason === 'replaced') await f.create(true)
    if (reason === 'identity') {
      const record = f.records.get(f.indexKey)!
      record.text = JSON.stringify({ ...JSON.parse(record.text), objectVersion: 'unrelated-version' })
    }
    const generation = reason === 'installation' ? 'new-installation' : fingerprint
    const counts = f.counts()
    await assert.rejects(f.resolve(share.id, generation), unavailable, reason)
    await assert.rejects(f.enable(share.id, generation), error => error instanceof ApiError && [404, 409].includes(error.status), reason)
    assert.deepEqual(f.counts(), counts, 'Unavailable shares must not be revived.')
  }
})

test('A concurrent revoke prevents enabling a stale link and never rewrites the immutable link', async () => {
  const f = await fixture()
  const share = await f.create()
  f.update('new version')
  f.beforePut(() => {
    f.records.set(f.indexKey, { text: JSON.stringify({ ...share, revoked: true }), etag: 'concurrent-revocation' })
  })
  await assert.rejects(f.enable(share.id), error => error instanceof ApiError && error.code === 'SHARE_CHANGED')
  await assert.rejects(f.download(share.id), unavailable)
  assert.equal(JSON.parse(f.records.get(`_mono/shares/links/${share.id}.json`)!.text).followUpdates, false)
})

test('Share mode and explicit link IDs reject ambiguous values before mutation', async () => {
  const f = await fixture()
  for (const mode of [null, 'true', 'false', 0, 1, {}, []]) await assert.rejects(f.create(mode), error => error instanceof ApiError && error.code === 'INVALID_SHARE_MODE')
  for (const id of [undefined, null, '', '../other', 'f'.repeat(31)]) await assert.rejects(f.enable(id), error => error instanceof ApiError && error.code === 'INVALID_SHARE_ID')
  assert.deepEqual(f.counts(), { writes: 0, deletes: 0 })
})
