import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PDF_CANVAS_PIXELS, MAX_PDF_CANVAS_SIDE, pdfCanvasSize, pdfPageNumber, pdfPageText } from '../src/pdf-runtime.ts'

test('PDF page dimensions cap canvas memory and dimensions while retaining the requested scale for ordinary pages', () => {
  const ordinary = pdfCanvasSize(600, 800, 1.25, 2)
  assert.equal(ordinary.scale, 1.25)
  assert.equal(ordinary.pixelWidth, 1500)
  assert.equal(ordinary.pixelHeight, 2000)
  assert.equal(ordinary.limited, false)
  for (const values of [[600, 800, 3, 4], [100000, 100000, 3, 2], [1, 1e9, 10, 2], [8192, 8192, 1, 2]]) {
    const bounded = pdfCanvasSize(...values as [number, number, number, number])
    assert.ok(bounded.pixelWidth <= MAX_PDF_CANVAS_SIDE && bounded.pixelHeight <= MAX_PDF_CANVAS_SIDE)
    assert.ok(bounded.pixelWidth * bounded.pixelHeight <= MAX_PDF_CANVAS_PIXELS)
  }
  for (const values of [[0, 800, 1], [600, Infinity, 1], [600, 800, -1], [NaN, 800, 1]]) assert.throws(() => pdfCanvasSize(...values as [number, number, number]))
})

test('PDF page navigation accepts only a whole page inside the existing document', () => {
  assert.equal(pdfPageNumber(' 02 ', 3), 2)
  assert.equal(pdfPageNumber(3, 3), 3)
  for (const input of ['', '0', '-1', '1.5', '1e1', '2x', '4', NaN]) assert.equal(pdfPageNumber(input, 3), null)
  assert.equal(pdfPageNumber('1', 0), null)
})

test('PDF source preserves explicit and geometric line breaks, ignores marked content, and stays bounded without splitting Unicode pairs', () => {
  const extracted = pdfPageText([
    { type: 'beginMarkedContent' },
    { str: '标题', transform: [12, 0, 0, 12, 0, 200], width: 24 },
    { str: 'Hello', transform: [12, 0, 0, 12, 0, 180], width: 30 },
    { str: 'world', transform: [12, 0, 0, 12, 34, 180], width: 30, hasEOL: true },
    { str: '中文', transform: [12, 0, 0, 12, 0, 160], width: 24 },
    { str: '文本', transform: [12, 0, 0, 12, 24, 160], width: 24 },
  ])
  assert.deepEqual(extracted, { text: '标题\nHello world\n中文文本', truncated: false })
  assert.deepEqual(pdfPageText([{ str: '甲😀乙' }], 2), { text: '甲', truncated: true })
  assert.deepEqual(pdfPageText([{ str: 'abcd' }, { str: 'e' }], 4), { text: 'abcd', truncated: true })
  assert.deepEqual(pdfPageText([{ str: 'abcd' }], 4), { text: 'abcd', truncated: false })
  assert.throws(() => pdfPageText([], 0))
})
