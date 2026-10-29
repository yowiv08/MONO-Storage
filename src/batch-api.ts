import { api, bucketPath, StorageError, type StoredObject } from './api'
import { archiveSelectionError, runFileDeleteBatches } from './batch-files.ts'

export function deleteSelectedFiles(bucket: string, keys: readonly string[], onDeleted: (keys: string[]) => void, active = () => true): Promise<void> {
  return runFileDeleteBatches(keys, batch => {
    if (!active()) throw new DOMException('删除操作已停止', 'AbortError')
    return api<{ deleted: number }>(bucketPath(bucket, 'objects'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: batch }) })
  }, onDeleted)
}

export async function fetchFileArchive(bucket: string, files: readonly StoredObject[], signal: AbortSignal): Promise<Blob> {
  const error = archiveSelectionError(files)
  if (error) throw new Error(error)
  const response = await fetch(bucketPath(bucket, 'archive'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mono-Client': 'web' },
    credentials: 'same-origin',
    body: JSON.stringify({ keys: files.map(file => file.key) }),
    signal,
  })
  if (!response.ok) {
    let code = 'ARCHIVE_FAILED'
    let message = `打包下载失败（${response.status}）`
    try {
      const body = await response.json()
      code = body.error?.code || code
      message = body.error?.message || message
    } catch { }
    if (response.status === 401) window.dispatchEvent(new Event('mono:unauthorized'))
    throw new StorageError(response.status, code, message)
  }
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/zip')) {
    await response.body?.cancel()
    throw new Error('下载响应无效，请重新打包。')
  }
  try { return await response.blob() }
  catch (error) {
    if (signal.aborted) throw new DOMException('下载已取消', 'AbortError')
    throw new Error('打包下载中断，文件可能已变化，请刷新后重试。', { cause: error })
  }
}
