import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalBase64ByteLength, isCanonicalBase64 } from '../worker/mcp-base64.ts'

test('Canonical Base64 validates and round-trips full 1 MiB reads and 5 MiB multipart payloads without regexp stack use', () => {
  for (const length of [1024 * 1024, 5 * 1024 * 1024]) {
    const original = Buffer.alloc(length)
    for (let index = 0; index < length; index++) original[index] = index % 256
    const content = original.toString('base64')
    assert.equal(isCanonicalBase64(content, length), true)
    assert.equal(canonicalBase64ByteLength(content, length), length)
    assert.deepEqual(Buffer.from(content, 'base64'), original)
    assert.equal(isCanonicalBase64(content, length - 1), false)
  }
})

test('All three Base64 tail lengths are canonical and include the full standard alphabet', () => {
  for (const value of ['', 'M', 'Ma', 'Man', '\u0000\u00ff\u00fb']) {
    const original = Buffer.from(value, 'latin1')
    const content = original.toString('base64')
    assert.equal(canonicalBase64ByteLength(content, original.length), original.length)
    assert.deepEqual(Buffer.from(content, 'base64'), original)
  }
  assert.equal(isCanonicalBase64('+/8=', 2), true)
  assert.equal(isCanonicalBase64('////', 3), true)
})

test('Malformed length, padding, URL-safe characters and whitespace are rejected', () => {
  for (const content of ['A', 'AA', 'AAA', 'AA=', 'A===', '====', '=AAA', 'AA=A', 'AAAA=', 'AAAA====', 'TQ==\n', ' TQ==', 'TQ--', 'TQ__', 'ＴＱ==', 'TQ==AAAA']) assert.equal(isCanonicalBase64(content, 100), false, content)
})

test('Nonzero unused tail bits are rejected even when permissive decoders return identical bytes', () => {
  assert.deepEqual(Buffer.from('TR==', 'base64'), Buffer.from('TQ==', 'base64'))
  assert.deepEqual(Buffer.from('TWF=', 'base64'), Buffer.from('TWE=', 'base64'))
  assert.equal(isCanonicalBase64('TQ==', 1), true)
  assert.equal(isCanonicalBase64('TR==', 1), false)
  assert.equal(isCanonicalBase64('TWE=', 2), true)
  assert.equal(isCanonicalBase64('TWF=', 2), false)
})

test('Decoded byte bounds apply before scanning or decoding and empty content stays a valid zero-byte write', () => {
  assert.equal(canonicalBase64ByteLength('', 0), 0)
  assert.equal(canonicalBase64ByteLength('TQ==', 0), null)
  assert.equal(canonicalBase64ByteLength('TQ==', -1), null)
  assert.equal(canonicalBase64ByteLength('TQ==', Number.POSITIVE_INFINITY), null)
  assert.equal(canonicalBase64ByteLength('TQ==', 1.5), null)
})
