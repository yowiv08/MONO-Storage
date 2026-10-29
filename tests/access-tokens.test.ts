import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, hashSecret } from '../worker/core.ts'
import { accessTokenInfo, assertTokenBucket, assertTokenPermission, createAccessToken, permissionValue, revokeAccessToken, scopeValue, tokenIsActive, updateAccessToken, validateTokenRegistry, type StoredAccessToken } from '../worker/access-tokens.ts'
import { permissionPreset, type TokenPermission, type TokenScope } from '../shared/token-permissions.ts'

const storagePermissions: TokenPermission[] = ['read', 'write', 'delete', 'create_folder', 'delete_folder', 'share']
const filePermissions: TokenPermission[] = ['read', 'write', 'delete', 'share']
const targetKey = '资料/报告 + #?.txt'
const scope: TokenScope = { type: 'file', bucket: 'workspace', key: targetKey }

function fixture(overrides: Partial<StoredAccessToken> = {}): StoredAccessToken {
  return { id: 'a'.repeat(32), name: '权限边界测试', scope: { type: 'all' }, permissions: [...storagePermissions], enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: null, tokenHash: 'b'.repeat(64), credentialVersion: 'c'.repeat(32), revoked: false, ...overrides }
}

const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403
const invalid = (error: unknown) => error instanceof ApiError && error.status === 400

test('A file capability authorizes one exact key, including Unicode, without granting sibling or directory access', () => {
  const token = fixture({ scope, permissions: filePermissions })
  for (const permission of filePermissions) assert.doesNotThrow(() => assertTokenPermission(token, permission, 'workspace', targetKey))
  for (const other of ['资料/', '资料/报告 + #?.txt.bak', '资料/报告 + #?.txt/child', '资料/报告 + #?.TXT', '资料/报告%20+%20%23%3F.txt', 'other.txt', undefined]) {
    for (const permission of filePermissions) assert.throws(() => assertTokenPermission(token, permission, 'workspace', other), forbidden)
  }
  assert.throws(() => assertTokenPermission(token, 'read', 'archive', targetKey), forbidden)
  assert.throws(() => assertTokenPermission(token, 'read', 'workspace', targetKey, true), forbidden)
  // 单文件授权不包含目录权限。
  const directoryGrant = fixture({ scope, permissions: storagePermissions })
  for (const permission of ['create_folder', 'delete_folder'] as const) assert.throws(() => assertTokenPermission(directoryGrant, permission, 'workspace', targetKey), forbidden)
})

test('Bucket and global grants keep operation permissions separate and protect the system prefix', () => {
  const token = fixture({ scope: { type: 'bucket', bucket: 'workspace' } })
  assert.doesNotThrow(() => assertTokenBucket(token, 'workspace'))
  assert.throws(() => assertTokenBucket(token, 'archive'), forbidden)
  for (const permission of storagePermissions) {
    const key = permission.endsWith('_folder') ? '资料/' : targetKey
    assert.doesNotThrow(() => assertTokenPermission(token, permission, 'workspace', key, permission.endsWith('_folder')))
    assert.throws(() => assertTokenPermission(token, permission, 'archive', key, permission.endsWith('_folder')), forbidden)
    const onlyThisPermission = fixture({ permissions: [permission] })
    for (const denied of storagePermissions.filter(item => item !== permission)) assert.throws(() => assertTokenPermission(onlyThisPermission, denied, 'workspace', key), forbidden)
  }
  const global = fixture()
  for (const bucket of ['workspace', 'archive']) assert.doesNotThrow(() => assertTokenPermission(global, 'read', bucket, targetKey))
  for (const key of ['_mono', '_mono/system-config.json', '_mono/shares/private.json']) {
    for (const permission of filePermissions) assert.throws(() => assertTokenPermission(global, permission, 'workspace', key), forbidden)
  }
})

test('Scope input rejects unknown buckets, reserved or ambiguous keys, and extra fields that would expand authority', () => {
  assert.deepEqual(scopeValue(scope, ['workspace', 'archive']), scope)
  for (const value of [null, [], { type: 'all', bucket: 'workspace' }, { type: 'bucket', bucket: 'missing' }, { type: 'bucket', bucket: 'workspace', key: targetKey }, { type: 'file', bucket: 'workspace', key: '_mono/system-config.json' }, { type: 'file', bucket: 'workspace', key: '资料/' }, { type: 'file', bucket: 'workspace', key: '../secret.txt' }, { type: 'file', bucket: 'workspace', key: '资料//报告.txt' }, { type: 'file', bucket: 'workspace', key: targetKey, recursive: true }]) {
    assert.throws(() => scopeValue(value, ['workspace', 'archive']), invalid)
  }
})

test('ALL means only the available storage operations for the chosen scope, never administrator privileges', () => {
  assert.deepEqual(permissionPreset('all', { type: 'all' }), storagePermissions)
  assert.deepEqual(permissionPreset('all', scope), filePermissions)
  for (const value of [[], ['read', 'read'], ['ALL'], ['admin'], ['manage_tokens'], ['read', 'create_folder'], ['delete_folder']]) {
    assert.throws(() => permissionValue(value, scope), invalid)
  }
  assert.deepEqual(permissionValue(['share', 'read'], scope), ['read', 'share'])
})

test('Expiration is exclusive at the deadline; disabled and revoked grants cannot be reactivated by time', () => {
  const deadline = Date.parse('2030-01-01T00:00:00.000Z')
  const token = fixture({ expiresAt: new Date(deadline).toISOString() })
  assert.equal(tokenIsActive(token, deadline - 1), true)
  assert.equal(tokenIsActive(token, deadline), false)
  assert.equal(tokenIsActive(token, deadline + 1), false)
  assert.equal(tokenIsActive({ ...token, enabled: false }, deadline - 1), false)
  assert.equal(tokenIsActive({ ...token, revoked: true, enabled: true }, deadline - 1), false)
  assert.equal(tokenIsActive({ ...token, expiresAt: null }, deadline + 10 ** 12), true)
  for (const inactive of [fixture({ enabled: false }), fixture({ revoked: true }), fixture({ expiresAt: '2000-01-01T00:00:00.000Z' })]) assert.throws(() => assertTokenPermission(inactive, 'read', 'workspace', targetKey), forbidden)
})

test('Permission and status changes invalidate old upload generations; renaming preserves credentials and scope', () => {
  const token = fixture({ scope, permissions: ['read', 'write'] })
  const renamed = updateAccessToken(token, { name: '新名称' })
  assert.equal(renamed.credentialVersion, token.credentialVersion)
  for (const patch of [{ permissions: ['read'] }, { enabled: false }, { enabled: true }, { expiresAt: '2099-01-01T00:00:00.000Z' }, { expiresAt: null }]) {
    const updated = updateAccessToken(token, patch)
    assert.notEqual(updated.credentialVersion, token.credentialVersion)
    assert.equal(updated.id, token.id)
    assert.equal(updated.tokenHash, token.tokenHash)
    assert.deepEqual(updated.scope, scope)
  }
  for (const patch of [{ scope: { type: 'all' } }, { token: 'replacement-secret' }, { tokenHash: 'd'.repeat(64) }, { revoked: false }, { credentialVersion: 'd'.repeat(32) }]) assert.throws(() => updateAccessToken(token, patch), invalid)
  const revoked = revokeAccessToken(token)
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.enabled, false)
  assert.notEqual(revoked.credentialVersion, token.credentialVersion)
  assert.throws(() => updateAccessToken(revoked, { enabled: true }), error => error instanceof ApiError && error.status === 404)
})

test('Token creation refuses administrator secrets and previously used secrets, including revoked tombstones', async () => {
  const secret = 'mono_test_custom_secret_abcdefghijklmnopqrstuvwxyz'
  const hash = await hashSecret(secret)
  const draft = { name: '单文件读取', scope, permissions: ['read'], token: secret }
  await assert.rejects(createAccessToken(draft, ['workspace'], [], hash), invalid)
  for (const revoked of [false, true]) await assert.rejects(createAccessToken(draft, ['workspace'], [fixture({ tokenHash: hash, revoked, enabled: !revoked })], 'f'.repeat(64)), invalid)
  const created = await createAccessToken(draft, ['workspace'], [], 'f'.repeat(64))
  assert.equal(created.secret, secret)
  assert.equal(created.token.tokenHash, hash)
  assert.notEqual(created.token.id, created.token.credentialVersion)
  assert.deepEqual(created.token.scope, scope)
  assert.equal(tokenIsActive(created.token), true)
})

test('Stored registry validation keeps revoked hashes and rejects duplicate or malformed identities', () => {
  const revoked = revokeAccessToken(fixture())
  const stored = validateTokenRegistry([revoked])
  assert.equal(stored[0].tokenHash, revoked.tokenHash)
  assert.equal(stored[0].revoked, true)
  assert.throws(() => validateTokenRegistry([revoked, { ...revoked, id: 'd'.repeat(32) }]))
  assert.throws(() => validateTokenRegistry([revoked, { ...revoked, tokenHash: 'd'.repeat(64) }]))
  for (const patch of [{ tokenHash: 'plaintext-secret' }, { enabled: 'true' }, { credentialVersion: '' }, { scope: { type: 'file', bucket: 'workspace', key: '_mono/system-config.json' } }]) assert.throws(() => validateTokenRegistry([{ ...revoked, ...patch }]))
})

test('Management responses exclude secret material and token creation rejects client supplied privilege fields', async () => {
  assert.deepEqual(Object.keys(accessTokenInfo(fixture())).sort(), ['createdAt', 'enabled', 'expiresAt', 'id', 'name', 'permissions', 'scope', 'updatedAt'])
  const base = { name: '授权', scope: { type: 'all' }, permissions: ['read'] }
  for (const extra of [{ enabled: true }, { revoked: false }, { tokenHash: 'a'.repeat(64) }, { credentialVersion: 'a'.repeat(32) }, { admin: true }]) await assert.rejects(createAccessToken({ ...base, ...extra }, ['workspace'], [], 'f'.repeat(64)), invalid)
  for (const expiresAt of ['not-a-date', '2000-01-01T00:00:00Z', 123]) await assert.rejects(createAccessToken({ ...base, expiresAt }, ['workspace'], [], 'f'.repeat(64)), invalid)
})
