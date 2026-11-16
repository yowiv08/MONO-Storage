import type { StoredObject } from './public-api'
import { previewKind, supportsDocumentSource, type PreviewKind } from './preview-kind.ts'

export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024

export type PreviewData = { data: ArrayBuffer; truncated: boolean }
export type DocumentPreviewData = PreviewData & { object: StoredObject; kind: PreviewKind }

export class PreviewChangedError extends Error {
  constructor() {
    super('文件已发生变化，请点击重新加载以读取最新内容。')
    this.name = 'PreviewChangedError'
  }
}

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

function previewEtag(value: string): string {
  const etag = value.trim()
  // Compression can weaken the HTTP ETag without changing the stored object.
  return /^(?:W\/)?"([^"]*)"$/.exec(etag)?.[1] ?? etag
}

async function previewResponse(sourceUrl: string, signal: AbortSignal, headers = new Headers()): Promise<Response> {
  aborted(signal)
  const url = new URL(sourceUrl, location.origin)
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('文件预览地址无效。')
  headers.set('X-Mono-Client', 'web')
  const response = await fetch(url, { headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal })
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('mono:unauthorized'))
    let changed = false
    let message = response.status === 404 ? '文件不存在或分享已经失效。' : `无法读取文件（${response.status}）。`
    try {
      const body = await readPreviewResponse(response, 8192, signal, true)
      const error = JSON.parse(new TextDecoder().decode(body.data)).error
      if (typeof error?.message === 'string' && error.message.length < 300) message = error.message
      changed = response.status === 409 && error?.code === 'OBJECT_CHANGED'
    } catch { aborted(signal) }
    if (changed) throw new PreviewChangedError()
    throw new Error(message)
  }
  return response
}

async function fetchPreviewObject(metadataUrl: string, key: string, signal: AbortSignal): Promise<StoredObject> {
  const response = await previewResponse(metadataUrl, signal)
  const body = await readPreviewResponse(response, 64 * 1024, signal)
  let payload: Record<string, unknown> | null
  try { payload = JSON.parse(new TextDecoder().decode(body.data)) } catch { throw new Error('文件信息无效，请重新加载。') }
  const object = (payload?.object ?? payload) as Partial<StoredObject> | null
  if (!object || typeof object !== 'object' || object.key !== key || typeof object.etag !== 'string' || !object.etag || typeof object.size !== 'number' || !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.contentType !== 'string' || typeof object.uploaded !== 'string' || !object.metadata || typeof object.metadata !== 'object' || Array.isArray(object.metadata) || Object.values(object.metadata).some(value => typeof value !== 'string')) throw new Error('文件信息无效，请重新加载。')
  return object as StoredObject
}

export async function fetchPreviewData(sourceUrl: string, object: { size: number; etag: string }, signal: AbortSignal, text = false): Promise<PreviewData> {
  const limit = text ? MAX_TEXT_PREVIEW_BYTES : MAX_DOCUMENT_BYTES
  if (!Number.isSafeInteger(object.size) || object.size < 0) throw new Error('文件大小无效，请重新读取文件列表。')
  if (!text && object.size > limit) throw new Error('该文件超过 32 MiB 的在线文档预览限制，请下载后查看。')
  const headers = new Headers()
  if (object.size > limit) headers.set('Range', `bytes=0-${limit - 1}`)
  const response = await previewResponse(sourceUrl, signal, headers)
  const receivedEtag = response.headers.get('ETag')
  if (receivedEtag && object.etag && previewEtag(receivedEtag) !== previewEtag(object.etag)) {
    await response.body?.cancel()
    throw new PreviewChangedError()
  }
  const result = await readPreviewResponse(response, limit, signal, text)
  if (object.size <= limit && result.data.byteLength !== object.size) throw new Error('文件内容读取不完整，请重试。')
  return { data: result.data, truncated: result.truncated || object.size > result.data.byteLength }
}

export async function fetchDocumentPreview(sourceUrl: string, object: StoredObject, signal: AbortSignal, metadataUrl?: string): Promise<DocumentPreviewData> {
  for (let attempt = 0; ; attempt++) {
    aborted(signal)
    const current = metadataUrl ? await fetchPreviewObject(metadataUrl, object.key, signal) : object
    const kind = previewKind(current.key, current.contentType)
    if (!supportsDocumentSource(kind)) throw new Error('该文件类型暂不支持在线文档预览，请下载后查看。')
    try {
      const content = await fetchPreviewData(sourceUrl, current, signal, ['markdown', 'csv', 'html', 'json', 'text'].includes(kind))
      return { ...content, object: current, kind }
    } catch (error) {
      // One refresh covers a write between metadata and content reads. Further
      // changes remain visible errors, so a busy file cannot cause a retry loop.
      if (!metadataUrl || attempt > 0 || !(error instanceof PreviewChangedError)) throw error
    }
  }
}

export function decodePreviewText(data: ArrayBuffer, truncated = false, contentType = ''): string {
  const bytes = new Uint8Array(data)
  const decode = (encoding: string, fatal = false) => new TextDecoder(encoding, { fatal }).decode(bytes, { stream: truncated })
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode('utf-16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode('utf-16be')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode('utf-8')
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType)
  if (charset) {
    try { return decode(charset[1] || charset[2] || charset[3]) } catch { /* Unknown charset: use byte-based detection. */ }
  }
  try {
    return decode('utf-8', true)
  } catch {
    const utf8 = decode('utf-8')
    const legacy = decode('gb18030')
    const invalid = (value: string) => (value.match(/\uFFFD/g) || []).length
    // A few damaged UTF-8 bytes must not turn the rest of the file into mojibake.
    return invalid(utf8) <= invalid(legacy) ? utf8 : legacy
  }
}
