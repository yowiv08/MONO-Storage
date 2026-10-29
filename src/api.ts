export interface Bucket {
  name: string
  description: string
}

export interface StoredObject {
  key: string
  size: number
  etag: string
  uploaded: string
  contentType: string
  metadata: Record<string, string>
}

export interface SessionState {
  authenticated: boolean
  configured?: boolean
  setupRequired?: boolean
  setupTokenRequired?: boolean
  adminPath?: string | null
  displayName?: string | null
  local?: boolean
}

export interface Listing {
  objects: StoredObject[]
  folders: string[]
  cursor: string | null
  truncated: boolean
  prefix: string
}

export interface BucketStatsPage {
  objectCount: number
  totalBytes: number
  cursor: string | null
  truncated: boolean
}

export { api, StorageError } from './public-api'
import { api, StorageError } from './public-api'

export function bucketPath(bucket: string, resource: string): string {
  return `/api/buckets/${encodeURIComponent(bucket)}/${resource}`
}

export function objectUrl(bucket: string, key: string, download = false): string {
  const query = new URLSearchParams({ key })
  if (download) query.set('download', 'true')
  return `${bucketPath(bucket, 'object')}?${query}`
}

function sendPart(url: string, body: Blob, headers: Record<string, string>, signal: AbortSignal, progress: (loaded: number) => void): Promise<{ partNumber: number; etag: string } | StoredObject> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('X-Mono-Client', 'web')
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = event => progress(event.loaded)
    const abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.onload = () => {
      signal.removeEventListener('abort', abort)
      let data
      try { data = JSON.parse(xhr.responseText) } catch { data = {} }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event('mono:unauthorized'))
        reject(new StorageError(xhr.status, data.error?.code || 'UPLOAD_FAILED', data.error?.message || `上传失败（${xhr.status}）`))
      }
    }
    xhr.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('网络连接中断，请重新上传。')) }
    xhr.onabort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('上传已取消', 'AbortError')) }
    if (signal.aborted) return reject(new DOMException('上传已取消', 'AbortError'))
    xhr.send(body)
  })
}

export async function uploadFile(bucket: string, key: string, file: File, overwrite: boolean, signal: AbortSignal, progress: (loaded: number) => void): Promise<void> {
  const type = file.type || 'application/octet-stream'
  if (file.size <= 40 * 1024 * 1024) {
    await sendPart(`${objectUrl(bucket, key)}${overwrite ? '&overwrite=true' : ''}`, file, { 'Content-Type': type }, signal, progress)
    return
  }
  const started = await api<{ uploadToken: string; partSize: number }>(bucketPath(bucket, 'uploads'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, size: file.size, contentType: type, overwrite }), signal })
  const parts: { partNumber: number; etag: string }[] = []
  const partSize = Math.max(started.partSize, Math.ceil(file.size / 10000))
  if (partSize > 90 * 1024 * 1024) throw new Error('该文件超出网页上传支持的大小。')
  try {
    for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber++) {
      const part = await sendPart(`${bucketPath(bucket, 'uploads/part')}?partNumber=${partNumber}`, file.slice(offset, offset + partSize), { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': started.uploadToken }, signal, loaded => progress(offset + loaded)) as { partNumber: number; etag: string }
      parts.push(part)
    }
    await api(bucketPath(bucket, 'uploads/complete'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadToken: started.uploadToken, parts }), signal })
  } catch (error) {
    await api(bucketPath(bucket, 'uploads/abort'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadToken: started.uploadToken }) }).catch(() => undefined)
    throw error
  }
}
