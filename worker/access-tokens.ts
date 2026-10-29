import { ApiError, hashSecret, objectKey } from './core.ts'
import { allTokenPermissions, fileTokenPermissions, type TokenPermission, type TokenScope } from '../shared/token-permissions.ts'

export type StoredAccessToken = {
  id: string
  name: string
  scope: TokenScope
  permissions: TokenPermission[]
  enabled: boolean
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  tokenHash: string
  credentialVersion: string
  revoked: boolean
}

export const ACTIVE_TOKEN_LIMIT = 200
export const TOKEN_REGISTRY_LIMIT = 500

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nameValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(400, 'INVALID_TOKEN_NAME', 'Token 名称需要 1 到 80 个字符。')
  return value.trim()
}

export function scopeValue(value: unknown, bucketNames?: string[]): TokenScope {
  if (!record(value)) throw new ApiError(400, 'INVALID_TOKEN_SCOPE', 'Token 授权范围无效。')
  const fields = Object.keys(value)
  if (value.type === 'all' && fields.length === 1) return { type: 'all' }
  if (value.type !== 'bucket' && value.type !== 'file') throw new ApiError(400, 'INVALID_TOKEN_SCOPE', 'Token 授权范围无效。')
  if (typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value.bucket) || bucketNames && !bucketNames.includes(value.bucket)) throw new ApiError(400, 'INVALID_TOKEN_SCOPE', '授权的存储桶不存在。')
  if (value.type === 'bucket' && fields.length === 2 && fields.includes('bucket')) return { type: 'bucket', bucket: value.bucket }
  if (value.type === 'file' && fields.length === 3 && fields.includes('bucket') && fields.includes('key')) {
    const key = objectKey(value.key)
    if (key === '_mono' || key.startsWith('_mono/')) throw new ApiError(400, 'INVALID_TOKEN_SCOPE', '系统文件不能用于 Token 授权。')
    return { type: 'file', bucket: value.bucket, key }
  }
  throw new ApiError(400, 'INVALID_TOKEN_SCOPE', 'Token 授权范围包含无效字段。')
}

export function permissionValue(value: unknown, scope: TokenScope): TokenPermission[] {
  if (!Array.isArray(value) || !value.length || value.some(permission => typeof permission !== 'string' || !allTokenPermissions.includes(permission as TokenPermission)) || new Set(value).size !== value.length) throw new ApiError(400, 'INVALID_TOKEN_PERMISSIONS', '请选择至少一项有效权限，权限不能重复。')
  const permissions = value as TokenPermission[]
  if (scope.type === 'file' && permissions.some(permission => !fileTokenPermissions.includes(permission))) throw new ApiError(400, 'INVALID_TOKEN_PERMISSIONS', '单文件 Token 不能获得目录操作权限。')
  return allTokenPermissions.filter(permission => permissions.includes(permission))
}

function expirationValue(value: unknown, now: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now) throw new ApiError(400, 'INVALID_TOKEN_EXPIRATION', 'Token 有效期需要是未来的日期，长期有效请使用 null。')
  return new Date(value).toISOString()
}

function generation(): string { return crypto.randomUUID().replaceAll('-', '') }

export function tokenIsActive(token: StoredAccessToken, now = Date.now()): boolean {
  return !token.revoked && token.enabled && (token.expiresAt === null || Date.parse(token.expiresAt) > now)
}

export function accessTokenInfo(token: StoredAccessToken) {
  return { id: token.id, name: token.name, scope: token.scope, permissions: [...token.permissions], enabled: token.enabled, createdAt: token.createdAt, updatedAt: token.updatedAt, expiresAt: token.expiresAt }
}

export function validateTokenRegistry(value: unknown): StoredAccessToken[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > TOKEN_REGISTRY_LIMIT) throw new Error('Invalid API token registry')
  const ids = new Set<string>()
  const hashes = new Set<string>()
  return value.map(item => {
    if (!record(item) || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id) || ids.has(item.id) || typeof item.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.tokenHash) || hashes.has(item.tokenHash) || typeof item.credentialVersion !== 'string' || !/^[a-f0-9]{32}$/.test(item.credentialVersion) || typeof item.enabled !== 'boolean' || typeof item.revoked !== 'boolean' || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || item.expiresAt !== null && (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)))) throw new Error('Invalid API token registry entry')
    ids.add(item.id); hashes.add(item.tokenHash)
    const scope = scopeValue(item.scope)
    return { id: item.id, tokenHash: item.tokenHash, credentialVersion: item.credentialVersion, name: nameValue(item.name), scope, permissions: permissionValue(item.permissions, scope), enabled: item.enabled, revoked: item.revoked, createdAt: item.createdAt, updatedAt: item.updatedAt, expiresAt: item.expiresAt as string | null }
  })
}

export function assertTokenBucket(token: StoredAccessToken, bucket: string): void {
  if (token.scope.type !== 'all' && token.scope.bucket !== bucket) throw new ApiError(403, 'TOKEN_SCOPE_DENIED', '该 Token 无权访问此存储桶。')
}

export function assertTokenPermission(token: StoredAccessToken, permission: TokenPermission, bucket: string, key?: string, folder = false): void {
  if (!tokenIsActive(token)) throw new ApiError(403, 'TOKEN_INACTIVE', '该 Token 已停用、过期或撤销。')
  assertTokenBucket(token, bucket)
  if (!token.permissions.includes(permission)) throw new ApiError(403, 'TOKEN_PERMISSION_DENIED', '该 Token 没有执行此操作的权限。')
  if (token.scope.type === 'file' && (folder || permission === 'create_folder' || permission === 'delete_folder' || key !== token.scope.key)) throw new ApiError(403, 'TOKEN_SCOPE_DENIED', '该 Token 只能访问指定的文件。')
  if (key && (key === '_mono' || key.startsWith('_mono/'))) throw new ApiError(403, 'TOKEN_SCOPE_DENIED', '系统文件不允许访问。')
}

export async function createAccessToken(body: Record<string, unknown>, bucketNames: string[], registry: StoredAccessToken[], adminHash: string): Promise<{ token: StoredAccessToken; secret: string }> {
  if (Object.keys(body).some(field => !['name', 'scope', 'permissions', 'expiresAt', 'token'].includes(field))) throw new ApiError(400, 'INVALID_TOKEN_FIELDS', '创建 Token 的字段无效。')
  if (registry.length >= TOKEN_REGISTRY_LIMIT || registry.filter(token => !token.revoked).length >= ACTIVE_TOKEN_LIMIT) throw new ApiError(400, 'TOKEN_LIMIT_REACHED', 'Token 数量已达到上限。')
  const name = nameValue(body.name)
  const scope = scopeValue(body.scope, bucketNames)
  const permissions = permissionValue(body.permissions, scope)
  const now = Date.now()
  const expiresAt = expirationValue(body.expiresAt, now)
  if (body.token !== undefined && typeof body.token !== 'string') throw new ApiError(400, 'INVALID_API_TOKEN', 'API Token 必须是文本。')
  const secret = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : `mono_api_${generation()}${generation()}`
  if (secret.length < 24 || secret.length > 256) throw new ApiError(400, 'INVALID_API_TOKEN', 'API Token 长度必须在 24 到 256 个字符之间。')
  const tokenHash = await hashSecret(secret)
  if (tokenHash === adminHash || registry.some(token => token.tokenHash === tokenHash)) throw new ApiError(400, 'TOKEN_ALREADY_USED', '该 Token 已被使用，请生成新密钥。')
  const timestamp = new Date(now).toISOString()
  return { secret, token: { id: generation(), name, scope, permissions, enabled: true, createdAt: timestamp, updatedAt: timestamp, expiresAt, tokenHash, credentialVersion: generation(), revoked: false } }
}

export function updateAccessToken(token: StoredAccessToken, body: Record<string, unknown>): StoredAccessToken {
  const fields = Object.keys(body)
  if (!fields.length || fields.some(field => !['name', 'permissions', 'enabled', 'expiresAt'].includes(field))) throw new ApiError(400, 'INVALID_TOKEN_FIELDS', '只能修改 Token 名称、权限、启用状态和有效期。')
  if (token.revoked) throw new ApiError(404, 'TOKEN_NOT_FOUND', 'Token 不存在或已撤销。')
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_TOKEN_FIELDS', '启用状态必须是布尔值。')
  return { ...token, name: 'name' in body ? nameValue(body.name) : token.name, permissions: 'permissions' in body ? permissionValue(body.permissions, token.scope) : [...token.permissions], enabled: 'enabled' in body ? body.enabled as boolean : token.enabled, expiresAt: 'expiresAt' in body ? expirationValue(body.expiresAt, Date.now()) : token.expiresAt, updatedAt: new Date().toISOString(), credentialVersion: fields.some(field => ['permissions', 'enabled', 'expiresAt'].includes(field)) ? generation() : token.credentialVersion }
}

export function revokeAccessToken(token: StoredAccessToken): StoredAccessToken {
  return { ...token, enabled: false, revoked: true, updatedAt: new Date().toISOString(), credentialVersion: generation() }
}
