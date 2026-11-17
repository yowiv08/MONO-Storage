import { ApiError, hashSecret } from './core.ts'

export type ShareRecord = {
  id: string
  bucket: string
  key: string
  objectVersion: string
  fingerprint: string
  createdAt: string
  expiresAt: string | null
  revoked: boolean
  followUpdates?: boolean
}

const linkKey = (id: string) => `_mono/shares/links/${id}.json`
const indexKey = async (bucket: string, key: string) => `_mono/shares/objects/${await hashSecret(`${bucket}\n${key}`)}.json`
const options = { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } }

export function shareIsActive(share: ShareRecord, fingerprint: string, now = Date.now()): boolean {
  return !share.revoked && (share.followUpdates === undefined || typeof share.followUpdates === 'boolean') && share.fingerprint === fingerprint && (share.expiresAt === null || Date.parse(share.expiresAt) > now)
}

export function sameShare(link: ShareRecord, current: ShareRecord): boolean {
  return link.id === current.id && link.bucket === current.bucket && link.key === current.key
    && link.objectVersion === current.objectVersion && link.fingerprint === current.fingerprint
    && link.createdAt === current.createdAt && link.expiresAt === current.expiresAt
}

export function shareMatchesObject(share: ShareRecord, head: R2Object): boolean {
  return share.followUpdates === true || share.objectVersion === head.version
}

function followUpdatesOption(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new ApiError(400, 'INVALID_SHARE_MODE', 'followUpdates 必须为布尔值。')
  return value
}

export function shareExpiration(value: unknown): string | null {
  if (value === null) return null
  const seconds = value === undefined ? 7 * 24 * 60 * 60 : value
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 365 * 24 * 60 * 60) throw new ApiError(400, 'INVALID_EXPIRATION', '分享有效期应为 1 秒到 365 天，长期有效请传入 null。')
  return new Date(Date.now() + seconds * 1000).toISOString()
}

export function shareInfo(share: ShareRecord) {
  return { id: share.id, url: `/s/${share.id}`, createdAt: share.createdAt, expiresAt: share.expiresAt, followUpdates: share.followUpdates === true }
}

export async function currentShare(storage: R2Bucket, bucket: string, key: string, head: R2Object, fingerprint: string): Promise<ShareRecord | null> {
  const object = await storage.get(await indexKey(bucket, key))
  if (!object) return null
  const share = await object.json<ShareRecord>()
  return share.bucket === bucket && share.key === key && shareIsActive(share, fingerprint) && shareMatchesObject(share, head) ? share : null
}

export async function createShare(storage: R2Bucket, bucket: string, key: string, head: R2Object, fingerprint: string, expiresIn: unknown, followUpdates?: unknown): Promise<ShareRecord> {
  const mode = followUpdatesOption(followUpdates)
  const index = await indexKey(bucket, key)
  const previous = await storage.get(index)
  const old = previous ? await previous.json<ShareRecord>() : null
  const share: ShareRecord = { id: crypto.randomUUID().replaceAll('-', ''), bucket, key, objectVersion: head.version, fingerprint, createdAt: new Date().toISOString(), expiresAt: shareExpiration(expiresIn), revoked: false, followUpdates: mode }
  await storage.put(linkKey(share.id), JSON.stringify(share), options)
  const written = await storage.put(index, JSON.stringify(share), { ...options, onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' } })
  if (!written) {
    await storage.delete(linkKey(share.id))
    throw new ApiError(409, 'SHARE_CHANGED', '分享状态已变化，请刷新后重试。')
  }
  if (old) await storage.delete(linkKey(old.id))
  return share
}

export async function enableShareUpdates(storage: R2Bucket, bucket: string, key: string, id: unknown, fingerprint: string): Promise<ShareRecord> {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new ApiError(400, 'INVALID_SHARE_ID', '请提供要修改的分享编号。')
  const unavailable = () => new ApiError(404, 'SHARE_UNAVAILABLE', '分享不存在、已过期或已被取消。')
  const index = await indexKey(bucket, key)
  const object = await storage.get(index)
  if (!object) throw unavailable()
  const current = await object.json<ShareRecord>()
  if (current.id !== id) throw new ApiError(409, 'SHARE_CHANGED', '分享已被替换，请刷新后重试。')
  if (current.bucket !== bucket || current.key !== key || !shareIsActive(current, fingerprint)) throw unavailable()
  const link = await storage.get(linkKey(id))
  if (!link) throw unavailable()
  const original = await link.json<ShareRecord>()
  if (!sameShare(original, current) || !shareIsActive(original, fingerprint)) throw unavailable()
  if (current.followUpdates === true) return current
  // The index owns the mutable mode, so a concurrent revoke/replacement wins by ETag.
  const updated: ShareRecord = { ...current, followUpdates: true }
  const written = await storage.put(index, JSON.stringify(updated), { ...options, onlyIf: { etagMatches: object.etag } })
  if (!written) throw new ApiError(409, 'SHARE_CHANGED', '分享状态已变化，请刷新后重试。')
  return updated
}

export async function revokeShare(storage: R2Bucket, bucket: string, key: string): Promise<void> {
  const index = await indexKey(bucket, key)
  const object = await storage.get(index)
  if (!object) return
  const share = await object.json<ShareRecord>()
  const written = await storage.put(index, JSON.stringify({ ...share, revoked: true }), { ...options, onlyIf: { etagMatches: object.etag } })
  if (!written) throw new ApiError(409, 'SHARE_CHANGED', '分享状态已变化，请刷新后重试。')
  await storage.delete(linkKey(share.id))
}

export async function resolveShare(storage: R2Bucket, id: string, fingerprint: string, getBucket: (name: string) => R2Bucket) {
  const unavailable = () => new ApiError(404, 'SHARE_UNAVAILABLE', '分享不存在、已过期或已被取消。')
  if (!/^[a-f0-9]{32}$/.test(id)) throw unavailable()
  const object = await storage.get(linkKey(id))
  if (!object) throw unavailable()
  const share = await object.json<ShareRecord>()
  if (share.id !== id || !shareIsActive(share, fingerprint)) throw unavailable()
  const index = await storage.get(await indexKey(share.bucket, share.key))
  if (!index) throw unavailable()
  const current = await index.json<ShareRecord>()
  if (!sameShare(share, current) || !shareIsActive(current, fingerprint)) throw unavailable()
  let bucket: R2Bucket
  try { bucket = getBucket(share.bucket) } catch { throw unavailable() }
  const head = await bucket.head(share.key)
  if (!head || !shareMatchesObject(current, head)) throw unavailable()
  return { share: current, bucket, head }
}
