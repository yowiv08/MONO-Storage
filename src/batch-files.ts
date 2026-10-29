import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, MAX_ARCHIVE_REQUEST_BYTES } from '../shared/batch-files.ts'

type BatchFile = { key: string; size: number }

export function selectedBatchFiles<T extends BatchFile>(files: readonly T[], selection: ReadonlySet<string>, visibleKeys?: ReadonlySet<string>): T[] {
  const seen = new Set<string>()
  return files.filter(file => {
    if (!selection.has(file.key) || visibleKeys && !visibleKeys.has(file.key) || seen.has(file.key) || file.key.endsWith('/')) return false
    seen.add(file.key)
    return true
  })
}

export function archiveSelectionError(files: readonly BatchFile[]): string {
  if (!files.length) return '请先选择需要下载的文件。'
  if (files.length > MAX_ARCHIVE_FILES) return `打包下载每次最多 ${MAX_ARCHIVE_FILES} 个文件，请减少所选文件。`
  const bytes = files.reduce((total, file) => total + file.size, 0)
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARCHIVE_BYTES) return '打包下载的文件总大小不能超过 512 MiB，请减少所选文件。'
  if (new TextEncoder().encode(JSON.stringify({ keys: files.map(file => file.key) })).length > MAX_ARCHIVE_REQUEST_BYTES) return '所选文件路径过多，请减少所选文件后下载。'
  return ''
}

export function fileDeleteBatches(keys: readonly string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  const encoder = new TextEncoder()
  for (const key of new Set(keys)) {
    const candidate = [...current, key]
    if (candidate.length > 100 || encoder.encode(JSON.stringify({ keys: candidate })).length > 32 * 1024) {
      if (!current.length) throw new Error('文件路径过长，无法提交删除。')
      batches.push(current)
      current = []
    }
    if (encoder.encode(JSON.stringify({ keys: [key] })).length > 32 * 1024) throw new Error('文件路径过长，无法提交删除。')
    current.push(key)
  }
  if (current.length) batches.push(current)
  return batches
}

export async function runFileDeleteBatches(keys: readonly string[], send: (keys: string[]) => Promise<{ deleted: number }>, onDeleted: (keys: string[]) => void): Promise<void> {
  for (const batch of fileDeleteBatches(keys)) {
    const result = await send(batch)
    if (result.deleted !== batch.length) throw new Error('删除结果不完整，请刷新后核对文件。')
    onDeleted(batch)
  }
}
