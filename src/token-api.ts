import { api } from './api'
import type { TokenPermission, TokenScope } from '../shared/token-permissions'

export type AccessTokenInfo = {
  id: string
  name: string
  scope: TokenScope
  permissions: TokenPermission[]
  enabled: boolean
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

export type AccessTokenDraft = {
  name: string
  scope: TokenScope
  permissions: TokenPermission[]
  expiresAt?: string | null
  token?: string
}

export type AccessTokenUpdate = Partial<Pick<AccessTokenInfo, 'name' | 'permissions' | 'enabled' | 'expiresAt'>>
export type AccessTokenList = { tokens: AccessTokenInfo[] }
export type AccessTokenResult = { token: AccessTokenInfo; secret?: string }

export function accessTokenPath(id?: string): string {
  return id ? `/api/tokens/${encodeURIComponent(id)}` : '/api/tokens'
}

export function listAccessTokens(file?: { bucket: string; key: string }, signal?: AbortSignal, onResponse?: (response: Response) => void) {
  const query = file ? `?${new URLSearchParams(file)}` : ''
  return api<AccessTokenList>(`${accessTokenPath()}${query}`, { signal }, onResponse)
}

export function createAccessToken(draft: AccessTokenDraft, etag?: string | null, onResponse?: (response: Response) => void) {
  return api<AccessTokenResult>(accessTokenPath(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, body: JSON.stringify(draft) }, onResponse)
}

export function updateAccessToken(id: string, update: AccessTokenUpdate, etag?: string | null, onResponse?: (response: Response) => void) {
  return api<AccessTokenResult>(accessTokenPath(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, body: JSON.stringify(update) }, onResponse)
}

export function revokeAccessToken(id: string, etag?: string | null, onResponse?: (response: Response) => void) {
  return api<void>(accessTokenPath(id), { method: 'DELETE', headers: etag ? { 'If-Match': etag } : {} }, onResponse)
}
