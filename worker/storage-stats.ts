import { ApiError, objectKey, prefixValue } from './core.ts'

export type StorageStatsPage = { objectCount: number; totalBytes: number; cursor: string | null; truncated: boolean }
type StatObject = { key: string; size: number }
type StatListing = { objects: StatObject[]; truncated: false } | { objects: StatObject[]; truncated: true; cursor: string }
export type StatsStorage = {
  list: (options: { limit: number; cursor?: string; prefix?: string }) => Promise<StatListing>
  head: (key: string) => Promise<StatObject | null>
}

export function statsCursor(value: string | null): string | undefined {
  if (!value) return undefined
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(400, 'INVALID_CURSOR', '统计分页游标无效。')
  return value
}

function isFile(key: string): boolean {
  return key !== '_mono' && !key.startsWith('_mono/') && !key.endsWith('/')
}

function fileBytes(object: StatObject): number {
  if (!Number.isSafeInteger(object.size) || object.size < 0) throw new ApiError(503, 'INVALID_STATS', '存储统计包含无效的文件大小。')
  return object.size
}

export async function storageStatsPage(storage: StatsStorage, cursor?: string, exactFile?: string, prefix = ''): Promise<StorageStatsPage> {
  const safeCursor = statsCursor(cursor || null)
  const safePrefix = prefixValue(prefix)
  if (exactFile !== undefined) {
    const key = objectKey(exactFile)
    if (!isFile(key)) throw new ApiError(403, 'TOKEN_SCOPE_DENIED', '系统文件不能统计。')
    if (!key.startsWith(safePrefix)) return { objectCount: 0, totalBytes: 0, cursor: null, truncated: false }
    const object = await storage.head(key)
    if (!object) return { objectCount: 0, totalBytes: 0, cursor: null, truncated: false }
    // Exact-file statistics require the authorized key.
    if (object.key !== key) throw new ApiError(503, 'INVALID_STATS', '文件统计响应无效。')
    return { objectCount: 1, totalBytes: fileBytes(object), cursor: null, truncated: false }
  }

  // Page totals exclude folder markers and system data; use the cursor until truncated=false.
  const listing = await storage.list({ limit: 1000, ...(safeCursor ? { cursor: safeCursor } : {}), ...(safePrefix ? { prefix: safePrefix } : {}) })
  let totalBytes = 0
  let objectCount = 0
  for (const object of listing.objects) {
    if (!isFile(object.key) || !object.key.startsWith(safePrefix)) continue
    totalBytes += fileBytes(object)
    objectCount++
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(objectCount)) throw new ApiError(503, 'STATS_TOO_LARGE', '存储统计超出安全整数范围。')
  }
  if (listing.truncated && (!listing.cursor || listing.cursor === safeCursor || statsCursor(listing.cursor) === undefined)) throw new ApiError(503, 'INVALID_STATS_CURSOR', '存储统计分页游标无效。')
  return { objectCount, totalBytes, cursor: listing.truncated ? listing.cursor : null, truncated: listing.truncated }
}
