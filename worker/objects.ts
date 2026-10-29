import { ApiError, downloadDisposition, resolveRange } from './core'

export async function objectResponse(request: Request, bucket: R2Bucket, key: string, download = false, expectedVersion?: string): Promise<Response> {
  const head = await bucket.head(key)
  if (!head || (expectedVersion && head.version !== expectedVersion)) throw new ApiError(404, 'OBJECT_NOT_FOUND', '文件不存在或已发生变化。')
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'ETag': head.httpEtag,
    'Accept-Ranges': 'bytes',
    'Content-Type': head.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Length': String(head.size),
    'Last-Modified': head.uploaded.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
  })
  if (download) headers.set('Content-Disposition', downloadDisposition(key))
  if (request.headers.get('If-None-Match')?.split(',').map(value => value.trim()).includes(head.httpEtag)) return new Response(null, { status: 304, headers })
  let range
  try { range = resolveRange(request.headers.get('Range'), head.size) } catch (error) {
    if (error instanceof ApiError && error.status === 416) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}`, 'Cache-Control': 'no-store' } })
    throw error
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`)
    headers.set('Content-Length', String(range.length))
  }
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
  const object = await bucket.get(key, { range, onlyIf: { etagMatches: head.etag } })
  if (!object) throw new ApiError(404, 'OBJECT_NOT_FOUND', '文件不存在。')
  if (!('body' in object)) throw new ApiError(409, 'OBJECT_CHANGED', '文件已发生变化，请重新获取。')
  if (expectedVersion && object.version !== expectedVersion) throw new ApiError(404, 'OBJECT_NOT_FOUND', '分享的文件已发生变化。')
  return new Response(object.body, { status: range ? 206 : 200, headers })
}
