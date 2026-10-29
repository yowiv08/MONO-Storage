import { Unzip, UnzipInflate, type UnzipFile } from 'fflate'

export const MAX_DOCUMENT_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_DOCUMENT_ARCHIVE_ENTRIES = 4096

function archiveDirectory(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === data.length) { end = offset; break }
  }
  if (end < 0) throw new Error('文档压缩结构不完整，请下载后检查文件。')
  const count = view.getUint16(end + 10, true)
  const directoryBytes = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('暂不支持分卷或 ZIP64 文档预览，请下载查看。')
  if (count > MAX_DOCUMENT_ARCHIVE_ENTRIES || directoryOffset + directoryBytes > end) throw new Error('文档内容过多或压缩结构无效，请下载查看。')
  let offset = directoryOffset
  let total = 0
  const entries = new Map<string, number>()
  const decoder = new TextDecoder('utf-8')
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('文档压缩结构无效，请下载查看。')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressed = view.getUint32(offset + 20, true)
    const original = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const length = 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    if (flags & 1) throw new Error('加密文档暂不支持在线预览，请下载后打开。')
    if (![0, 8].includes(method) || original === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff || offset + length > directoryOffset + directoryBytes || localOffset + 30 > directoryOffset) throw new Error('文档压缩格式不受支持或内容不完整。')
    total += original
    if (total > MAX_DOCUMENT_ARCHIVE_BYTES) throw new Error('文档解压内容超过 64 MiB，请下载查看。')
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength))
    if (entries.has(name)) throw new Error('文档包含重复的内容路径，请下载查看。')
    entries.set(name, original)
    offset += length
  }
  if (offset !== directoryOffset + directoryBytes) throw new Error('文档压缩目录无效，请下载查看。')
  return entries
}

export function validateDocumentArchive(buffer: ArrayBuffer): void {
  const data = new Uint8Array(buffer)
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return
  const directory = archiveDirectory(data)
  let total = 0
  let seen = 0
  const active = new Set<UnzipFile>()
  const completed = new Set<string>()
  const unzip = new Unzip(file => {
    const expected = directory.get(file.name)
    if (expected === undefined || completed.has(file.name) || ++seen > MAX_DOCUMENT_ARCHIVE_ENTRIES) throw new Error('文档压缩目录与内容不一致。')
    let size = 0
    active.add(file)
    file.ondata = (error, chunk, final) => {
      if (error) throw new Error('文档压缩内容损坏，请下载后检查。')
      total += chunk.length
      size += chunk.length
      if (total > MAX_DOCUMENT_ARCHIVE_BYTES || size > expected) throw new Error('文档解压内容超过安全预览范围，请下载查看。')
      if (final) {
        if (size !== expected) throw new Error('文档压缩内容不完整。')
        completed.add(file.name)
        active.delete(file)
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < data.length; offset += 4096) unzip.push(data.subarray(offset, offset + 4096), offset + 4096 >= data.length)
    if (seen !== directory.size || completed.size !== directory.size || active.size) throw new Error('文档压缩内容不完整。')
  } finally { for (const file of active) file.terminate() }
}
