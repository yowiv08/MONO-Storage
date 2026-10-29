import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../worker/core.ts'
import { statsCursor, storageStatsPage, type StatsStorage } from '../worker/storage-stats.ts'

const invalid = (error: unknown) => error instanceof ApiError && error.status === 400

test('Recursive statistics are page increments, omit system and folder markers, and use one list per request', async () => {
  const calls: Array<{ limit: number; cursor?: string }> = []
  const storage: StatsStorage = {
    list: async options => {
      calls.push(options)
      return options.cursor === undefined
        ? { objects: [{ key: '_mono', size: 900 }, { key: '_mono/system-config.json', size: 800 }, { key: '_mono/shares/hidden.json', size: 500 }, { key: 'docs/', size: 0 }, { key: 'docs/first.txt', size: 37 }, { key: 'nested/more/second.bin', size: 63 }], truncated: true, cursor: 'second-page' }
        : { objects: [{ key: 'nested/', size: 0 }, { key: '中文/第三份.pdf', size: 1000 }, { key: '_mono-not-system.txt', size: 2 }, { key: 'empty.txt', size: 0 }], truncated: false }
    },
    head: async () => { throw new Error('Bucket statistics must not head each object') },
  }
  const first = await storageStatsPage(storage)
  assert.deepEqual(first, { objectCount: 2, totalBytes: 100, cursor: 'second-page', truncated: true })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { limit: 1000 })
  const second = await storageStatsPage(storage, first.cursor!)
  assert.deepEqual(second, { objectCount: 3, totalBytes: 1002, cursor: null, truncated: false })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { limit: 1000, cursor: 'second-page' })
  assert.equal(first.objectCount + second.objectCount, 5)
  assert.equal(first.totalBytes + second.totalBytes, 1102)
})

test('A page containing only directories and protected objects can be incomplete with zero bytes', async () => {
  const storage: StatsStorage = { list: async () => ({ objects: [{ key: 'docs/', size: 0 }, { key: '_mono/config.json', size: 500 }], truncated: true, cursor: 'next' }), head: async () => null }
  assert.deepEqual(await storageStatsPage(storage), { objectCount: 0, totalBytes: 0, cursor: 'next', truncated: true })
})

test('Directory statistics use the same literal prefix across pages and include all descendants without matching siblings', async () => {
  const prefix = 'docs/'
  const calls: Array<{ limit: number; cursor?: string; prefix?: string }> = []
  const storage: StatsStorage = {
    list: async options => {
      calls.push(options)
      return options.cursor === undefined
        ? { objects: [{ key: 'docs/', size: 0 }, { key: 'docs/first.txt', size: 37 }, { key: 'docs/nested/second.bin', size: 63 }, { key: 'docs-old/unrelated.bin', size: 900 }, { key: 'docs.txt', size: 500 }], truncated: true, cursor: 'directory-next' }
        : { objects: [{ key: 'docs/nested/deeper/third.txt', size: 13 }, { key: 'docs/empty.txt', size: 0 }, { key: 'elsewhere/unrelated.txt', size: 70 }], truncated: false }
    },
    head: async () => { throw new Error('Directory statistics must not head each object') },
  }
  const first = await storageStatsPage(storage, undefined, undefined, prefix)
  assert.deepEqual(first, { objectCount: 2, totalBytes: 100, cursor: 'directory-next', truncated: true })
  const second = await storageStatsPage(storage, first.cursor!, undefined, prefix)
  assert.deepEqual(second, { objectCount: 2, totalBytes: 13, cursor: null, truncated: false })
  assert.deepEqual(calls, [{ limit: 1000, prefix }, { limit: 1000, cursor: 'directory-next', prefix }])
})

test('Unicode directories and URL-special characters stay literal, and absent prefixes report empty totals', async () => {
  const prefix = '资料/报告 + #?/'
  const objects = [{ key: `${prefix}文件.txt`, size: 125 }, { key: '资料/报告 + #?旧/文件.txt', size: 900 }, { key: prefix, size: 0 }]
  const storage: StatsStorage = {
    list: async options => ({ objects: objects.filter(object => object.key.startsWith(options.prefix || '')), truncated: false }),
    head: async () => null,
  }
  assert.deepEqual(await storageStatsPage(storage, undefined, undefined, prefix), { objectCount: 1, totalBytes: 125, cursor: null, truncated: false })
  assert.deepEqual(await storageStatsPage(storage, undefined, undefined, '不存在/'), { objectCount: 0, totalBytes: 0, cursor: null, truncated: false })
})

test('Exact-file scope heads only the full key, never enumerates its bucket, and has no pagination', async () => {
  const key = '资料/报告 + #?.txt'
  const calls: string[] = []
  const storage: StatsStorage = {
    list: async () => { throw new Error('File scope must never enumerate storage') },
    head: async requested => { calls.push(requested); return requested === key ? { key, size: 123 } : null },
  }
  assert.deepEqual(await storageStatsPage(storage, 'ignored-but-valid', key), { objectCount: 1, totalBytes: 123, cursor: null, truncated: false })
  assert.deepEqual(calls, [key])
  assert.deepEqual(await storageStatsPage(storage, undefined, '资料/missing.txt'), { objectCount: 0, totalBytes: 0, cursor: null, truncated: false })
  await assert.rejects(storageStatsPage(storage, undefined, '_mono/system-config.json'), error => error instanceof ApiError && error.status === 403)
  assert.deepEqual(calls, [key, '资料/missing.txt'])
})

test('Exact-file statistics obey the requested prefix without looking up or enumerating any other file', async () => {
  const key = '资料/报告 + #?.txt'
  const calls: string[] = []
  const storage: StatsStorage = {
    list: async () => { throw new Error('File scope must never enumerate storage') },
    head: async requested => { calls.push(requested); return { key: requested, size: 123 } },
  }
  assert.deepEqual(await storageStatsPage(storage, undefined, key, '资料/'), { objectCount: 1, totalBytes: 123, cursor: null, truncated: false })
  assert.deepEqual(await storageStatsPage(storage, undefined, key, '资料/报告 + #?'), { objectCount: 1, totalBytes: 123, cursor: null, truncated: false })
  assert.deepEqual(await storageStatsPage(storage, 'valid-cursor', key, '其他资料/'), { objectCount: 0, totalBytes: 0, cursor: null, truncated: false })
  assert.deepEqual(await storageStatsPage(storage, undefined, key, '资料/报告 + #?/'), { objectCount: 0, totalBytes: 0, cursor: null, truncated: false })
  assert.deepEqual(calls, [key, key])
})

test('Invalid directory prefixes are rejected before storage access, including within exact-file scope', async () => {
  const storage: StatsStorage = {
    list: async () => { throw new Error('Invalid prefix must not enumerate storage') },
    head: async () => { throw new Error('Invalid prefix must not head storage') },
  }
  for (const prefix of ['/docs/', 'docs/../', 'docs//nested/', 'docs/./', 'docs\n/', '文'.repeat(342)]) {
    await assert.rejects(storageStatsPage(storage, undefined, undefined, prefix), error => invalid(error) && (error as ApiError).code === 'INVALID_PREFIX')
    await assert.rejects(storageStatsPage(storage, undefined, 'docs/file.txt', prefix), error => invalid(error) && (error as ApiError).code === 'INVALID_PREFIX')
  }
})

test('Malformed cursors are rejected before storage access, and invalid repeated pages cannot loop', async () => {
  assert.equal(statsCursor(null), undefined)
  assert.equal(statsCursor(''), undefined)
  assert.equal(statsCursor('valid+opaque/cursor='), 'valid+opaque/cursor=')
  assert.throws(() => statsCursor('x'.repeat(4097)), invalid)
  assert.throws(() => statsCursor('cursor\nnext'), invalid)
  const storage: StatsStorage = { list: async () => ({ objects: [], truncated: true, cursor: 'same' }), head: async () => null }
  await assert.rejects(storageStatsPage(storage, 'same'), error => error instanceof ApiError && error.code === 'INVALID_STATS_CURSOR')
})

test('Invalid sizes and per-page integer overflow fail without reporting a false byte total', async () => {
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const storage: StatsStorage = { list: async () => ({ objects: [{ key: 'file', size }], truncated: false }), head: async () => null }
    await assert.rejects(storageStatsPage(storage), error => error instanceof ApiError && error.code === 'INVALID_STATS')
  }
  const storage: StatsStorage = { list: async () => ({ objects: [{ key: 'one', size: Number.MAX_SAFE_INTEGER }, { key: 'two', size: 1 }], truncated: false }), head: async () => null }
  await assert.rejects(storageStatsPage(storage), error => error instanceof ApiError && error.code === 'STATS_TOO_LARGE')
})
