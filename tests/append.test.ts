import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEtag, appendLength, appendObject } from '../worker/append.ts'
import { ApiError } from '../worker/core.ts'
import { DEFAULT_APPEND_MAX_MIB, MAX_APPEND_MAX_MIB, MIB, normalizeAppendMaxMiB } from '../shared/storage-limits.ts'

const APPEND_MAX_BYTES = DEFAULT_APPEND_MAX_MIB * MIB

const request = (length?: string) => new Request('https://example.test/append', { method: 'POST', headers: length === undefined ? {} : { 'Content-Length': length }, body: '文' })
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected

test('Append requires a nonempty bounded byte length, including for a streaming request', () => {
  assert.equal(appendLength(request('3'), APPEND_MAX_BYTES), 3)
  assert.equal(appendLength(request(String(APPEND_MAX_BYTES)), APPEND_MAX_BYTES), APPEND_MAX_BYTES)
  assert.throws(() => appendLength(request(), APPEND_MAX_BYTES), code('APPEND_LENGTH_REQUIRED'))
  assert.throws(() => appendLength(request('0'), APPEND_MAX_BYTES), code('EMPTY_APPEND'))
  assert.throws(() => appendLength(request(String(APPEND_MAX_BYTES + 1)), APPEND_MAX_BYTES), code('APPEND_TOO_LARGE'))
  for (const value of ['-1', '1.5', 'NaN', '1e3', String(Number.MAX_SAFE_INTEGER + 1)]) assert.throws(() => appendLength(request(value), APPEND_MAX_BYTES), code('INVALID_CONTENT_LENGTH'))
})

test('Append accepts one exact ETag and rejects broad or ambiguous preconditions', () => {
  assert.equal(appendEtag(null), undefined)
  assert.equal(appendEtag('"abc-2"'), 'abc-2')
  assert.equal(appendEtag('abc-2'), 'abc-2')
  for (const value of ['', '*', '"*"', 'W/"abc"', '"a", "b"', '"abc', 'abc"']) assert.throws(() => appendEtag(value), code('INVALID_ETAG'))
})

test('Append refuses missing files, stale versions and oversized results before reading or writing content', async () => {
  let head: { etag: string; size: number } | null = null
  const bucket = { head: async () => head, get: async () => { throw new Error('Must not read content') }, put: async () => { throw new Error('Must not write content') } } as unknown as R2Bucket
  const options = { createIfMissing: false, contentType: 'text/plain', maxMiB: DEFAULT_APPEND_MAX_MIB }
  await assert.rejects(appendObject(bucket, 'log.txt', request('3'), options), code('OBJECT_NOT_FOUND'))
  head = { etag: 'current', size: APPEND_MAX_BYTES - 2 }
  await assert.rejects(appendObject(bucket, 'log.txt', request('3'), options), code('APPEND_TOO_LARGE'))
  const conditional = request('3')
  conditional.headers.set('If-Match', 'stale')
  await assert.rejects(appendObject(bucket, 'log.txt', conditional, options), code('APPEND_CONFLICT'))
})

test('Append settings use a default for existing workspaces and stay within the R2 single-write bound', () => {
  assert.equal(normalizeAppendMaxMiB(undefined), 90)
  for (const value of [1, 90, 512, 1024, MAX_APPEND_MAX_MIB]) assert.equal(normalizeAppendMaxMiB(value), value)
  for (const value of [null, false, '100', 0, -1, 1.1, NaN, Infinity, MAX_APPEND_MAX_MIB + 1]) assert.throws(() => normalizeAppendMaxMiB(value))
  assert.equal(appendLength(request(String(100 * MIB)), 128 * MIB), 100 * MIB)
  assert.throws(() => appendLength(request(String(2 * MIB)), MIB), code('APPEND_TOO_LARGE'))
})
