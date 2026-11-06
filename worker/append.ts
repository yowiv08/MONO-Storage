import { ApiError } from './core.ts'
import { MIB, normalizeAppendMaxMiB } from '../shared/storage-limits.ts'

export function appendLength(request: Request, maxBytes: number): number {
  const value = request.headers.get('Content-Length')
  if (value === null) throw new ApiError(411, 'APPEND_LENGTH_REQUIRED', '追加内容需要 Content-Length 请求头，值为请求正文的字节数。')
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length 必须是有效的字节数。')
  const length = Number(value)
  if (!length || !request.body) throw new ApiError(400, 'EMPTY_APPEND', '追加内容不能为空。')
  if (length > maxBytes) throw new ApiError(413, 'APPEND_TOO_LARGE', `追加后的文件不能超过当前设置的 ${maxBytes / MIB} MiB。`)
  return length
}

export function appendEtag(value: string | null): string | undefined {
  if (value === null) return undefined
  const match = /^(?:"([^"\s,]+)"|([^"\s,]+))$/.exec(value.trim())
  const etag = match?.[1] || match?.[2]
  if (!etag || etag === '*' || etag.startsWith('W/')) throw new ApiError(400, 'INVALID_ETAG', 'If-Match 需要一个明确的文件 ETag。')
  return etag
}

function conflict(): ApiError {
  return new ApiError(409, 'APPEND_CONFLICT', '文件在追加期间发生变化，本次内容未写入。请核对后重新追加。')
}

export async function appendObject(bucket: R2Bucket, key: string, request: Request, options: { createIfMissing: boolean; contentType: string; maxMiB: number }) {
  const maxBytes = normalizeAppendMaxMiB(options.maxMiB) * MIB
  const length = appendLength(request, maxBytes)
  const expectedEtag = appendEtag(request.headers.get('If-Match'))
  const head = await bucket.head(key)
  if (expectedEtag && head?.etag !== expectedEtag) throw conflict()
  if (!head && !options.createIfMissing) throw new ApiError(404, 'OBJECT_NOT_FOUND', '文件不存在；需要同时创建文件时，添加 create=true。')
  const size = (head?.size || 0) + length
  if (size > maxBytes) throw new ApiError(413, 'APPEND_TOO_LARGE', `追加后的文件不能超过当前设置的 ${options.maxMiB} MiB。`)
  const fetched = head ? await bucket.get(key, { onlyIf: { etagMatches: head.etag } }) : null
  const existing = fetched && 'body' in fetched ? fetched as R2ObjectBody : null
  if (head && !existing) throw conflict()

  const stream = new FixedLengthStream(size)
  const controller = new AbortController()
  const cancel = () => controller.abort(new ApiError(400, 'APPEND_CANCELLED', '追加请求已取消。'))
  request.signal.addEventListener('abort', cancel, { once: true })
  if (request.signal.aborted) cancel()
  const piping = (async () => {
    if (existing) await existing.body.pipeTo(stream.writable, { preventClose: true, signal: controller.signal })
    await request.body!.pipeTo(stream.writable, { signal: controller.signal })
  })()
  const writing = bucket.put(key, stream.readable, {
    onlyIf: head ? { etagMatches: head.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: existing?.httpMetadata || { contentType: options.contentType },
    customMetadata: existing?.customMetadata,
    ...(existing?.storageClass ? { storageClass: existing.storageClass } : {}),
  }).then(item => {
    if (!item) throw conflict()
    return item
  }).catch(error => {
    controller.abort(error)
    throw error
  })
  try {
    const [saved, transfer] = await Promise.allSettled([writing, piping])
    if (saved.status === 'rejected') throw saved.reason
    if (transfer.status === 'rejected') throw transfer.reason
    return { key: saved.value.key, size: saved.value.size, etag: saved.value.httpEtag, appendedBytes: length, created: !head }
  } finally {
    request.signal.removeEventListener('abort', cancel)
    if (existing && !existing.body.locked) await existing.body.cancel().catch(() => {})
  }
}
