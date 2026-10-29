import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, objectKey, prefixValue, resolveRange, signPayload, verifyPayload, equalSecrets, downloadDisposition, normalizeAdminPath, hashSecret } from '../worker/core.ts'

test('Admin paths reject reserved routes and ambiguous or invalid segments', () => {
  assert.equal(normalizeAdminPath(undefined), '/admin')
  assert.equal(normalizeAdminPath('/console'), '/console')
  assert.equal(normalizeAdminPath(' /admin/storage/ '), '/admin/storage')
  for (const path of ['/api', '/api/objects', '/API/session', '/assets', '/assets/logo', '/s', '/s/anything', '/S/anything', '/', '//console', '/console//files', '/console/../files', '/console?x=1', '/console#files', 'console', 123]) {
    assert.throws(() => normalizeAdminPath(path), error => error instanceof ApiError && error.code === 'INVALID_ADMIN_PATH')
  }
})

test('API token storage uses a deterministic SHA-256 digest', async () => {
  assert.equal(await hashSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.notEqual(await hashSecret('token-a'), await hashSecret('token-b'))
})

test('Object keys preserve Unicode and reject ambiguous paths', () => {
  assert.equal(objectKey('资料/测试 + #?.txt'), '资料/测试 + #?.txt')
  for (const key of ['', '/private.txt', '../file', 'folder/../file', 'a//b', 'a\n.txt', 'a/', 'a/./b']) {
    assert.throws(() => objectKey(key), ApiError)
  }
  assert.equal(objectKey('资料/', { folder: true }), '资料/')
  assert.throws(() => objectKey('目录', { folder: true }))
  assert.throws(() => objectKey('文'.repeat(350)))
  assert.equal(prefixValue(''), '')
  assert.equal(prefixValue('资料/测试'), '资料/测试')
})

test('Byte range handles bounded, open-ended and suffix ranges', () => {
  assert.deepEqual(resolveRange('bytes=0-4', 10), { offset: 0, length: 5 })
  assert.deepEqual(resolveRange('bytes=5-', 10), { offset: 5, length: 5 })
  assert.deepEqual(resolveRange('bytes=-3', 10), { offset: 7, length: 3 })
  assert.deepEqual(resolveRange('bytes=-20', 10), { offset: 0, length: 10 })
  assert.deepEqual(resolveRange('bytes=3-100', 10), { offset: 3, length: 7 })
  for (const value of ['bytes=10-', 'bytes=5-2', 'bytes=0-1,3-5', 'bytes=-0', 'bytes=-']) assert.throws(() => resolveRange(value, 10))
  assert.throws(() => resolveRange('bytes=0-', 0))
})

test('Signed capabilities are bound to purpose, expiry and signature', async () => {
  const secret = 'test-secret-that-is-more-than-32-characters'
  const token = await signPayload({ purpose: 'upload', exp: Math.floor(Date.now() / 1000) + 120, key: '测试.txt' }, secret)
  assert.equal((await verifyPayload(token, secret, 'upload'))?.key, '测试.txt')
  assert.equal(await verifyPayload(token, secret, 'session'), null)
  assert.equal(await verifyPayload(token + 'x', secret, 'upload'), null)
  assert.equal(await verifyPayload(token, 'different-secret', 'upload'), null)
  const expired = await signPayload({ purpose: 'upload', exp: 1 }, secret)
  assert.equal(await verifyPayload(expired, secret, 'upload'), null)
})

test('Secret comparison and Unicode download names', async () => {
  assert.equal(await equalSecrets('密钥-a', '密钥-a'), true)
  assert.equal(await equalSecrets('same-length-a', 'same-length-b'), false)
  const header = downloadDisposition('folder/中文 "file".txt')
  assert.ok(header.includes("filename*=UTF-8''%E4%B8%AD%E6%96%87"))
  assert.ok(!header.includes('\n'))
})
