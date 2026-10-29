import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES } from '../shared/batch-files.ts'
import { ApiError, downloadDisposition, objectKey } from './core.ts'

type ArchiveHead = { key: string; size: number; etag: string; version?: string; uploaded?: Date }
type ArchiveBody = ArchiveHead & { body: ReadableStream<Uint8Array> }
export type ArchiveStorage = {
  head: (key: string) => Promise<ArchiveHead | null>
  get: (key: string, options: { onlyIf: { etagMatches: string } }) => Promise<ArchiveHead | ArchiveBody | null>
}
type ArchiveFile = ArchiveHead & { name: Uint8Array; time: number; date: number }
type StreamState = { cancelled: boolean; reader: ReadableStreamDefaultReader<Uint8Array> | null }

const encoder = new TextEncoder()
const ZIP_FLAGS = 0x0808
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})

export function archiveKeys(body: Record<string, unknown>, validate: (value: unknown) => string = objectKey): string[] {
  if (Object.keys(body).some(key => key !== 'keys')) throw new ApiError(400, 'INVALID_ARCHIVE_QUERY', '打包下载只接受 keys 文件列表。')
  if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > MAX_ARCHIVE_FILES) throw new ApiError(400, 'INVALID_ARCHIVE_KEYS', `每次可打包 1 到 ${MAX_ARCHIVE_FILES} 个文件。`)
  const keys = body.keys.map(value => {
    const key = validate(value)
    if (key === '_mono' || key.startsWith('_mono/')) throw new ApiError(400, 'RESERVED_KEY', '该对象路径由系统保留。')
    return key
  })
  return [...new Set(keys)]
}

function escaped(character: string): string {
  return [...encoder.encode(character)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
}

function safeSegment(segment: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(segment)) throw new ApiError(400, 'UNSAFE_ARCHIVE_PATH', '文件路径包含无效的 Unicode 字符，无法打包。')
  const trailing = segment.search(/[. ]+$/)
  let name = ''
  let position = 0
  for (const character of segment) {
    name += /[%\\<>:"|?*]/.test(character) || trailing >= 0 && position >= trailing ? escaped(character) : character
    position += character.length
  }
  const base = name.split('.', 1)[0].replace(/[ .]+$/, '')
  if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(base)) name = escaped(name[0]) + name.slice(1)
  if (encoder.encode(name).length > 255) throw new ApiError(400, 'UNSAFE_ARCHIVE_PATH', '文件名转为可安全解压的名称后超过 255 字节，请缩短文件名。')
  return name
}

export function archiveEntryNames(keys: string[]): string[] {
  const files = new Set<string>()
  const directories = new Set<string>()
  return keys.map(key => {
    const segments = objectKey(key).split('/').map(safeSegment)
    const name = segments.join('/')
    const normalized = segments.map(segment => segment.normalize('NFC').toUpperCase())
    const canonical = normalized.join('/')
    if (files.has(canonical) || directories.has(canonical)) throw new ApiError(400, 'ARCHIVE_NAME_CONFLICT', '所选文件的解压路径存在重名或文件与目录冲突，请分开下载。')
    for (let index = 1; index < normalized.length; index++) {
      const directory = normalized.slice(0, index).join('/')
      if (files.has(directory)) throw new ApiError(400, 'ARCHIVE_NAME_CONFLICT', '所选文件的解压路径存在重名或文件与目录冲突，请分开下载。')
      directories.add(directory)
    }
    files.add(canonical)
    return name
  })
}

function zipDate(uploaded?: Date): { time: number; date: number } {
  const value = uploaded && Number.isFinite(uploaded.getTime()) ? uploaded : new Date('1980-01-01T00:00:00Z')
  if (value.getUTCFullYear() < 1980) return { time: 0, date: 33 }
  if (value.getUTCFullYear() > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }
  return { time: (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | (value.getUTCSeconds() >>> 1), date: ((value.getUTCFullYear() - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate() }
}

function localHeader(file: ArchiveFile): Uint8Array {
  const data = new Uint8Array(30 + file.name.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, ZIP_FLAGS, true)
  view.setUint16(10, file.time, true)
  view.setUint16(12, file.date, true)
  view.setUint16(26, file.name.length, true)
  data.set(file.name, 30)
  return data
}

function descriptor(file: ArchiveFile, crc: number): Uint8Array {
  const data = new Uint8Array(16)
  const view = new DataView(data.buffer)
  view.setUint32(0, 0x08074b50, true)
  view.setUint32(4, crc, true)
  view.setUint32(8, file.size, true)
  view.setUint32(12, file.size, true)
  return data
}

function centralHeader(file: ArchiveFile, crc: number, offset: number): Uint8Array {
  const data = new Uint8Array(46 + file.name.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, ZIP_FLAGS, true)
  view.setUint16(12, file.time, true)
  view.setUint16(14, file.date, true)
  view.setUint32(16, crc, true)
  view.setUint32(20, file.size, true)
  view.setUint32(24, file.size, true)
  view.setUint16(28, file.name.length, true)
  view.setUint32(42, offset, true)
  data.set(file.name, 46)
  return data
}

function endRecord(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const data = new Uint8Array(22)
  const view = new DataView(data.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, centralSize, true)
  view.setUint32(16, centralOffset, true)
  return data
}

function abortError(): DOMException {
  return new DOMException('打包下载已取消。', 'AbortError')
}

async function openFile(storage: ArchiveStorage, file: ArchiveFile): Promise<ArchiveBody> {
  const result = await storage.get(file.key, { onlyIf: { etagMatches: file.etag } })
  if (!result || !('body' in result) || !result.body || result.key !== file.key || result.etag !== file.etag || result.size !== file.size || file.version !== undefined && result.version !== file.version) {
    if (result && 'body' in result && result.body) await result.body.cancel().catch(() => undefined)
    throw new ApiError(409, 'ARCHIVE_CHANGED', '所选文件已被修改或删除，请刷新列表后重新打包。')
  }
  return result
}

async function* archiveChunks(storage: ArchiveStorage, files: ArchiveFile[], first: ArchiveBody, state: StreamState): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = []
  let offset = 0
  for (let index = 0; index < files.length; index++) {
    if (state.cancelled) throw abortError()
    const file = files[index]
    const object = index === 0 ? first : await openFile(storage, file)
    if (state.cancelled) { await object.body.cancel().catch(() => undefined); throw abortError() }
    const reader = object.body.getReader()
    state.reader = reader
    let consumed = false
    let bytes = 0
    let crc = 0xffffffff
    const start = offset
    try {
      const header = localHeader(file)
      offset += header.length
      yield header
      while (!state.cancelled) {
        const next = await reader.read()
        if (state.cancelled) throw abortError()
        if (next.done) break
        if (!(next.value instanceof Uint8Array) || bytes + next.value.length > file.size) throw new ApiError(409, 'ARCHIVE_CHANGED', '文件内容大小发生变化，请重新打包。')
        bytes += next.value.length
        for (let part = 0; part < next.value.length; part += 64 * 1024) {
          const chunk = next.value.subarray(part, Math.min(part + 64 * 1024, next.value.length))
          for (let byte = 0; byte < chunk.length; byte++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ chunk[byte]) & 255]
          offset += chunk.length
          yield chunk
          if (state.cancelled) throw abortError()
        }
      }
      if (state.cancelled) throw abortError()
      if (bytes !== file.size) throw new ApiError(409, 'ARCHIVE_CHANGED', '文件内容读取不完整，请重新打包。')
      consumed = true
      const checksum = (crc ^ 0xffffffff) >>> 0
      const trailer = descriptor(file, checksum)
      offset += trailer.length
      yield trailer
      central.push(centralHeader(file, checksum, start))
    } finally {
      if (!consumed) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      state.reader = null
    }
  }
  const centralOffset = offset
  for (const header of central) { offset += header.length; yield header }
  yield endRecord(files.length, offset - centralOffset, centralOffset)
}

function archiveStream(storage: ArchiveStorage, files: ArchiveFile[], first: ArchiveBody, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const state: StreamState = { cancelled: false, reader: null }
  const iterator = archiveChunks(storage, files, first, state)
  let stopListening: () => void = () => undefined
  async function cancel(reason?: unknown) {
    state.cancelled = true
    stopListening()
    if (state.reader) await state.reader.cancel(reason).catch(() => undefined)
    else await first.body.cancel(reason).catch(() => undefined)
    await iterator.return(undefined)
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => { controller.error(abortError()); void cancel().catch(() => undefined) }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      stopListening = () => signal?.removeEventListener('abort', abort)
    },
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (state.cancelled) return
        if (next.done) { stopListening(); controller.close() }
        else controller.enqueue(next.value)
      } catch (error) {
        stopListening()
        if (!state.cancelled) controller.error(error)
      }
    },
    cancel,
  }, { highWaterMark: 0 })
}

export async function archiveResponse(storage: ArchiveStorage, inputKeys: string[], bucketName: string, signal?: AbortSignal): Promise<Response> {
  const keys = archiveKeys({ keys: inputKeys })
  const names = archiveEntryNames(keys)
  const files: ArchiveFile[] = []
  let totalBytes = 0
  for (let index = 0; index < keys.length; index++) {
    if (signal?.aborted) throw abortError()
    const head = await storage.head(keys[index])
    if (!head) throw new ApiError(404, 'OBJECT_NOT_FOUND', '所选文件不存在，请刷新列表后重新选择。')
    if (head.key !== keys[index] || !Number.isSafeInteger(head.size) || head.size < 0 || typeof head.etag !== 'string' || !head.etag) throw new ApiError(503, 'ARCHIVE_METADATA_INVALID', '文件信息无效，无法打包。')
    totalBytes += head.size
    if (totalBytes > MAX_ARCHIVE_BYTES) throw new ApiError(413, 'ARCHIVE_TOO_LARGE', '所选文件总大小超过 512 MiB，请分批下载。')
    files.push({ ...head, name: encoder.encode(names[index]), ...zipDate(head.uploaded) })
  }
  if (signal?.aborted) throw abortError()
  const first = await openFile(storage, files[0])
  const size = files.reduce((sum, file) => sum + file.size + 30 + 16 + 46 + file.name.length * 2, 22)
  const filename = `mono-${bucketName.replace(/[^a-z0-9_-]/gi, '_')}-${new Date().toISOString().slice(0, 10)}.zip`
  return new Response(archiveStream(storage, files, first, signal), { headers: {
    'Content-Type': 'application/zip',
    'Content-Disposition': downloadDisposition(filename),
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
  } })
}
