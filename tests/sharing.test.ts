import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShareLink } from '../src/share-link.ts'
import { shareExpiration, shareIsActive, type ShareRecord } from '../worker/shares.ts'

test('Public lookup accepts local share links and IDs without following other origins', () => {
  const origin = 'https://storage.example.com'
  const id = 'b2f1a738d2494180bf107f7a9d224481'
  for (const input of [id, `  ${origin}/s/${id}  `, `/s/${id}`, `/s/${id}/`]) assert.equal(parseShareLink(input, origin), id)
  for (const input of ['', 'invalid', `${origin}/admin`, `${origin}/api/shares/${id}`, `https://other.example/s/${id}`, `//other.example/s/${id}`, `javascript:alert(1)`, `https://name:password@storage.example.com/s/${id}`]) assert.throws(() => parseShareLink(input, origin))
})

test('Shares expire at their deadline and stop working after revocation or a new installation', () => {
  const share: ShareRecord = { id: 'example', bucket: 'workspace', key: 'file.txt', objectVersion: 'v1', fingerprint: 'installation-a', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', revoked: false }
  const deadline = Date.parse(share.expiresAt!)
  assert.equal(shareIsActive(share, 'installation-a', deadline - 1), true)
  assert.equal(shareIsActive(share, 'installation-a', deadline), false)
  assert.equal(shareIsActive({ ...share, revoked: true }, 'installation-a', deadline - 1), false)
  assert.equal(shareIsActive(share, 'installation-b', deadline - 1), false)
  assert.equal(shareIsActive({ ...share, expiresAt: null }, 'installation-a', deadline + 365 * 86400000), true)
})

test('Share duration is explicit, bounded, and supports permanent links', () => {
  assert.equal(shareExpiration(null), null)
  const now = Date.now()
  const expires = Date.parse(shareExpiration(undefined)!)
  assert.ok(expires >= now + 604800000 && expires <= Date.now() + 604800000)
  for (const duration of [0, -1, 0.5, '3600', true, 31536001, Infinity, {}]) assert.throws(() => shareExpiration(duration))
})
