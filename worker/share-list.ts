import { ApiError, hashSecret, objectKey } from './core.ts'
import { shareInfo, shareIsActive, type ShareRecord } from './shares.ts'

export type ActiveShare = ReturnType<typeof shareInfo> & {
  bucket: string
  key: string
  size: number
  contentType: string
  uploaded: string
}

export type ActiveSharesPage = { shares: ActiveShare[]; cursor: string | null; truncated: boolean }

const LINK_PREFIX = '_mono/shares/links/'
const PAGE_LIMIT = 100
const CONCURRENCY = 6
const MAX_RECORD_BYTES = 16 * 1024

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
}

function parseShare(value: unknown): ShareRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<ShareRecord>
  if (typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id)
    || typeof record.bucket !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(record.bucket)
    || typeof record.key !== 'string' || record.key === '_mono' || record.key.startsWith('_mono/')
    || typeof record.objectVersion !== 'string' || !record.objectVersion || record.objectVersion.length > 1024 || /[\x00-\x1f\x7f]/.test(record.objectVersion)
    || typeof record.fingerprint !== 'string' || !record.fingerprint || record.fingerprint.length > 512 || /[\x00-\x1f\x7f]/.test(record.fingerprint)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || (record.expiresAt !== null && (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))))
    || typeof record.revoked !== 'boolean') return null
  try { objectKey(record.key) } catch { return null }
  return record as ShareRecord
}

async function readShare(storage: R2Bucket, key: string): Promise<ShareRecord | null> {
  const object = await storage.get(key)
  if (!object) return null
  if (object.key !== key || !Number.isSafeInteger(object.size) || object.size < 0) throw new ApiError(503, 'INVALID_SHARE_STORAGE', '分享存储响应无效。')
  if (object.size > MAX_RECORD_BYTES) return null
  const text = await object.text()
  if (new TextEncoder().encode(text).length > MAX_RECORD_BYTES) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  return parseShare(value)
}

async function activeShare(storage: R2Bucket, listed: R2Object, getBucket: (name: string) => R2Bucket, allowedBuckets: Set<string>, fingerprint: string): Promise<ActiveShare | null> {
  const match = /^_mono\/shares\/links\/([a-f0-9]{32})\.json$/.exec(listed.key)
  if (!match) return null
  const share = await readShare(storage, listed.key)
  if (!share || share.id !== match[1] || !allowedBuckets.has(share.bucket) || !shareIsActive(share, fingerprint)) return null
  const current = await readShare(storage, `_mono/shares/objects/${await hashSecret(`${share.bucket}\n${share.key}`)}.json`)
  if (!current || current.id !== share.id || current.bucket !== share.bucket || current.key !== share.key
    || current.objectVersion !== share.objectVersion || current.createdAt !== share.createdAt || current.expiresAt !== share.expiresAt
    || !shareIsActive(current, fingerprint)) return null
  const head = await getBucket(share.bucket).head(share.key)
  if (!head || head.version !== share.objectVersion) return null
  if (head.key !== share.key || !Number.isSafeInteger(head.size) || head.size < 0 || !Number.isFinite(head.uploaded.getTime())) throw new ApiError(503, 'INVALID_SHARE_STORAGE', '分享文件响应无效。')
  if (!shareIsActive(share, fingerprint)) return null
  return { ...shareInfo(share), bucket: share.bucket, key: share.key, size: head.size, contentType: head.httpMetadata?.contentType || 'application/octet-stream', uploaded: head.uploaded.toISOString() }
}

export async function listActiveSharesPage(primary: R2Bucket, getBucket: (name: string) => R2Bucket, allowedBucketNames: readonly string[], fingerprint: string, cursor?: string): Promise<ActiveSharesPage> {
  const suppliedCursor = cursor === undefined || cursor === '' ? undefined : cursor
  if (suppliedCursor !== undefined && !validCursor(suppliedCursor)) throw new ApiError(400, 'INVALID_CURSOR', '分享分页游标无效。')
  const listing = await primary.list({ prefix: LINK_PREFIX, limit: PAGE_LIMIT, ...(suppliedCursor ? { cursor: suppliedCursor } : {}) })
  if (listing.objects.length > PAGE_LIMIT) throw new ApiError(503, 'INVALID_SHARE_STORAGE', '分享分页响应无效。')
  if (listing.truncated && (!validCursor(listing.cursor) || listing.cursor === suppliedCursor)) throw new ApiError(503, 'INVALID_SHARES_CURSOR', '分享分页游标响应无效。')
  const allowedBuckets = new Set(allowedBucketNames)
  const results: (ActiveShare | null)[] = Array.from({ length: listing.objects.length }, () => null)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listing.objects.length) }, async () => {
    while (next < listing.objects.length) {
      const index = next++
      results[index] = await activeShare(primary, listing.objects[index], getBucket, allowedBuckets, fingerprint)
    }
  }))
  return { shares: results.filter((share): share is ActiveShare => share !== null), cursor: listing.truncated ? listing.cursor : null, truncated: listing.truncated }
}
