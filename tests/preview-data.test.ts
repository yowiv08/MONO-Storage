import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePreviewText, readPreviewResponse } from '../src/preview-data.ts'
import { previewKind, supportsDocumentSource } from '../src/preview-kind.ts'
import { safeDocumentLink, safeEmbeddedImage } from '../src/preview-links.ts'

test('Document formats are recognized before generic MIME labels and normalize MIME parameters', () => {
  for (const key of ['README.MD', '中文.markdown']) assert.equal(previewKind(key, 'text/plain'), 'markdown')
  for (const extension of ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods']) assert.equal(previewKind(`data.${extension}`, 'application/octet-stream'), 'workbook')
  assert.equal(previewKind('data', 'APPLICATION/PDF; charset=utf-8'), 'pdf')
  assert.equal(previewKind('data', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'workbook')
  assert.equal(previewKind('data.csv', 'text/plain'), 'csv')
  assert.equal(previewKind('data.docx', 'application/octet-stream'), 'docx')
  assert.equal(previewKind('data.json', 'text/plain'), 'json')
  assert.equal(previewKind('data.html', 'text/plain'), 'html')
  assert.equal(supportsDocumentSource(previewKind('picture.png')), false)
  assert.equal(supportsDocumentSource(previewKind('README.md')), true)
})

test('Bounded preview reads refuse oversized binary files and cancel without collecting their remaining bytes', async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(8)) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  await assert.rejects(readPreviewResponse(new Response(stream), 10, new AbortController().signal), /大小限制/)
  assert.equal(reads, 2)
  assert.equal(cancelled, true)
})

test('Partial text reads keep a bounded prefix and mark it incomplete rather than displaying a false complete document', async () => {
  const encoder = new TextEncoder()
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('0123456789ABC')); controller.close() } }))
  const result = await readPreviewResponse(response, 10, new AbortController().signal, true)
  assert.equal(decodePreviewText(result.data), '0123456789')
  assert.equal(result.truncated, true)
  assert.equal(decodePreviewText(encoder.encode('文').buffer.slice(0, 2), true), '')
  assert.equal(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x87, 0x65]).buffer), '文')
})

test('Closing a preview cancels pending response reads', async () => {
  let cancelled = false
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }))
  const pending = readPreviewResponse(response, 10, controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(cancelled, true)
})

test('Document resources cannot run script or automatically request sibling and remote files', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,evil', '/api/config', '../secret.txt', 'https://user:password@example.com', '//example.com/file', 'file:///secret', ' https://example.com']) assert.equal(safeDocumentLink(url), null)
  assert.equal(safeDocumentLink('https://example.com/readme'), 'https://example.com/readme')
  assert.equal(safeDocumentLink('#标题'), '#标题')
  for (const url of ['https://example.com/tracker.png', '../secret.png', 'data:image/svg+xml;base64,AAAA', 'javascript:alert(1)']) assert.equal(safeEmbeddedImage(url), null)
  assert.equal(safeEmbeddedImage('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=')
})
