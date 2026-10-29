import { useEffect, useRef, useState } from 'react'
import { api, bucketPath, type BucketStatsPage } from './api'

type BucketTotals = {
  bucket: string
  prefix: string
  revision: number
  objectCount: number
  totalBytes: number
  pages: number
  complete: boolean
  loading: boolean
  error: string
}

export function useBucketStats(bucket: string, prefix: string, revision: number, enabled: boolean) {
  const generation = useRef(0)
  const [stats, setStats] = useState<BucketTotals | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = ++generation.current
    if (!enabled || !bucket) { setStats(null); return () => controller.abort() }
    const current = () => !controller.signal.aborted && generation.current === requestGeneration
    setStats({ bucket, prefix, revision, objectCount: 0, totalBytes: 0, pages: 0, complete: false, loading: true, error: '' })

    async function scan() {
      let objectCount = 0
      let totalBytes = 0
      let pages = 0
      let cursor: string | null = null
      const seenCursors = new Set<string>()
      try {
        do {
          const params = new URLSearchParams()
          if (prefix) params.set('prefix', prefix)
          if (cursor) params.set('cursor', cursor)
          const endpoint = `${bucketPath(bucket, 'stats')}${params.size ? `?${params}` : ''}`
          const page = await api<BucketStatsPage>(endpoint, { signal: controller.signal })
          if (!current()) return
          if (!Number.isSafeInteger(page.objectCount) || page.objectCount < 0 || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < 0 || typeof page.truncated !== 'boolean' || page.cursor !== null && typeof page.cursor !== 'string' || !page.truncated && page.cursor !== null) throw new Error('统计响应无效，请重新统计。')
          if (page.truncated && (!page.cursor || seenCursors.has(page.cursor))) throw new Error('统计分页未继续前进，请重新统计。')
          const nextCount = objectCount + page.objectCount
          const nextBytes = totalBytes + page.totalBytes
          if (!Number.isSafeInteger(nextCount) || !Number.isSafeInteger(nextBytes)) throw new Error('文件数量或大小超出可准确显示的范围。')
          objectCount = nextCount; totalBytes = nextBytes; pages++
          if (page.cursor) seenCursors.add(page.cursor)
          setStats({ bucket, prefix, revision, objectCount, totalBytes, pages, complete: !page.truncated, loading: page.truncated, error: '' })
          cursor = page.truncated ? page.cursor : null
        } while (cursor && current())
      } catch (error) {
        if (current()) setStats({ bucket, prefix, revision, objectCount, totalBytes, pages, complete: false, loading: false, error: error instanceof Error ? error.message : '统计失败，请重新统计。' })
      }
    }

    void scan()
    return () => controller.abort()
  }, [bucket, prefix, revision, enabled])

  return enabled && stats?.bucket === bucket && stats.prefix === prefix && stats.revision === revision ? stats : null
}
