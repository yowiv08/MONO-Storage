export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024

export type PreviewData = { data: ArrayBuffer; truncated: boolean }

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('读取已取消', 'AbortError')
}

export async function readPreviewResponse(response: Response, maxBytes: number, signal: AbortSignal, allowPartial = false): Promise<PreviewData> {
  if (!response.body) return { data: new ArrayBuffer(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let finished = false
  let truncated = false
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      aborted(signal)
      const next = await reader.read()
      aborted(signal)
      if (next.done) { finished = true; break }
      const remaining = maxBytes - length
      if (next.value.byteLength > remaining) {
        if (!allowPartial) throw new Error('文件超过在线预览的大小限制，请下载后查看。')
        if (remaining) chunks.push(next.value.slice(0, remaining))
        length = maxBytes
        truncated = true
        break
      }
      length += next.value.byteLength
      chunks.push(next.value)
    }
    const output = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
    return { data: output.buffer, truncated }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function fetchPreviewData(sourceUrl: string, object: { size: number; etag: string }, signal: AbortSignal, text = false): Promise<PreviewData> {
  const url = new URL(sourceUrl, location.origin)
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('文件预览地址无效。')
  const limit = text ? MAX_TEXT_PREVIEW_BYTES : MAX_DOCUMENT_BYTES
  if (!Number.isSafeInteger(object.size) || object.size < 0) throw new Error('文件大小无效，请重新读取文件列表。')
  if (!text && object.size > limit) throw new Error('该文件超过 32 MiB 的在线文档预览限制，请下载后查看。')
  const headers = new Headers({ 'X-Mono-Client': 'web' })
  if (object.size > limit) headers.set('Range', `bytes=0-${limit - 1}`)
  const response = await fetch(url, { headers, credentials: 'same-origin', redirect: 'error', signal })
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('mono:unauthorized'))
    let message = response.status === 404 ? '文件不存在或分享已经失效。' : `无法读取文件（${response.status}）。`
    try {
      const body = await readPreviewResponse(response, 8192, signal, true)
      const error = JSON.parse(new TextDecoder().decode(body.data)).error
      if (typeof error?.message === 'string' && error.message.length < 300) message = error.message
    } catch { aborted(signal) }
    throw new Error(message)
  }
  const receivedEtag = response.headers.get('ETag')?.replace(/^"|"$/g, '')
  if (receivedEtag && object.etag && receivedEtag !== object.etag.replace(/^"|"$/g, '')) {
    await response.body?.cancel()
    throw new Error('文件已发生变化，请关闭预览并刷新文件列表。')
  }
  const result = await readPreviewResponse(response, limit, signal, text)
  if (object.size <= limit && result.data.byteLength !== object.size) throw new Error('文件内容读取不完整，请重试。')
  return { data: result.data, truncated: result.truncated || object.size > result.data.byteLength }
}

export function decodePreviewText(data: ArrayBuffer, truncated = false): string {
  const bytes = new Uint8Array(data)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return decoder.decode(bytes, { stream: truncated })
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}
