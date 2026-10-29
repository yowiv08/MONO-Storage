import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveSelectionError, fileDeleteBatches, runFileDeleteBatches, selectedBatchFiles } from '../src/batch-files.ts'
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES } from '../shared/batch-files.ts'

test('Batch targets only include unique loaded files inside the visible filter, and ignore stale or folder selections', () => {
  const files = [{ key: 'docs/a.txt', size: 10 }, { key: 'docs/photo.png', size: 20 }, { key: 'docs/a.txt', size: 10 }, { key: 'docs/', size: 0 }]
  const selection = new Set(['docs/a.txt', 'docs/photo.png', 'docs/', 'other-bucket/private.txt'])
  assert.deepEqual(selectedBatchFiles(files, selection, new Set(['docs/a.txt', 'docs/'])), [files[0]])
  assert.deepEqual(selectedBatchFiles([], selection), [])
  assert.deepEqual(selectedBatchFiles(files, selection), [files[0], files[1]])
})

test('Batch deletion obeys both the file-count and UTF-8 JSON body bounds while keeping literal paths and order', () => {
  const keys = Array.from({ length: 253 }, (_, index) => `nested/${index}.txt`)
  const batches = fileDeleteBatches([...keys, keys[0]])
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 53])
  assert.deepEqual(batches.flat(), keys)
  const unicode = Array.from({ length: 70 }, (_, index) => `资料/${'文'.repeat(330)}-${index} + #?\\\".txt`)
  const unicodeBatches = fileDeleteBatches(unicode)
  assert.ok(unicodeBatches.length > 2)
  assert.deepEqual(unicodeBatches.flat(), unicode)
  for (const batch of unicodeBatches) assert.ok(new TextEncoder().encode(JSON.stringify({ keys: batch })).length <= 32 * 1024)
  assert.deepEqual(fileDeleteBatches([]), [])
  assert.throws(() => fileDeleteBatches(['文'.repeat(12000)]), /路径过长/)
})

test('A later deletion failure leaves only completed batches reported and never sends subsequent targets', async () => {
  const keys = Array.from({ length: 240 }, (_, index) => `files/${index}.txt`)
  const sent: string[][] = []
  const completed: string[] = []
  await assert.rejects(runFileDeleteBatches(keys, async batch => {
    sent.push([...batch])
    if (sent.length === 2) throw new Error('storage unavailable')
    return { deleted: batch.length }
  }, batch => completed.push(...batch)), /storage unavailable/)
  assert.equal(sent.length, 2)
  assert.deepEqual(completed, keys.slice(0, 100))
  assert.deepEqual(keys.filter(key => !completed.includes(key)), keys.slice(100))
  await assert.rejects(runFileDeleteBatches(['file'], async () => ({ deleted: 0 }), () => assert.fail('Incomplete response must not report successful deletion')), /结果不完整/)
})

test('Archive limits do not block ordinary selection or deletion and allow exact count and byte boundaries', () => {
  assert.equal(archiveSelectionError([{ key: 'empty.txt', size: 0 }]), '')
  assert.equal(archiveSelectionError([{ key: 'boundary.bin', size: MAX_ARCHIVE_BYTES }]), '')
  assert.match(archiveSelectionError([{ key: 'large.bin', size: MAX_ARCHIVE_BYTES + 1 }]), /512 MiB/)
  const files = Array.from({ length: MAX_ARCHIVE_FILES }, (_, index) => ({ key: `${index}.txt`, size: 0 }))
  assert.equal(archiveSelectionError(files), '')
  assert.match(archiveSelectionError([...files, { key: 'one-more.txt', size: 0 }]), /500/)
  assert.match(archiveSelectionError([]), /先选择/)
})
