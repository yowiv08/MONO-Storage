import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePreviewText } from '../src/preview-data.ts'

const encoder = new TextEncoder()
const prefix = '这是正常的中文内容，不能因个别坏字节变成乱码。\n'
const suffix = '\n后面的内容也应保持可读。'
const damagedUtf8 = new Uint8Array([...encoder.encode(prefix), 0xff, ...encoder.encode(suffix)]).buffer

test('Declared UTF-8 tolerates isolated invalid bytes without reinterpreting the entire document as GB18030', () => {
  for (const contentType of ['text/plain; charset=utf-8', 'text/plain; Charset="UTF-8"', "text/plain; charset = 'utf-8'"]) {
    assert.equal(decodePreviewText(damagedUtf8, false, contentType), prefix + '\uFFFD' + suffix)
  }
})

test('Automatic detection prefers the decoding with fewer damaged characters', () => {
  assert.equal(decodePreviewText(damagedUtf8), prefix + '\uFFFD' + suffix)
  assert.equal(decodePreviewText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xff]).buffer), '你好\uFFFD')
})

test('Legacy Chinese encodings remain readable with or without a charset declaration', () => {
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]).buffer
  for (const contentType of ['', 'text/plain; charset=gbk', 'text/plain; charset=GB2312', 'text/plain; charset=gb18030', 'text/plain; charset=unknown-encoding']) {
    assert.equal(decodePreviewText(gbk, false, contentType), '你好')
  }
})

test('Unicode byte-order marks take priority over an incorrect declared charset', () => {
  const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new Uint8Array(damagedUtf8)]).buffer
  assert.equal(decodePreviewText(utf8Bom, false, 'text/plain; charset=gbk'), prefix + '\uFFFD' + suffix)
  assert.equal(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x87, 0x65]).buffer, false, 'text/plain; charset=utf-8'), '文')
  assert.equal(decodePreviewText(new Uint8Array([0xfe, 0xff, 0x65, 0x87]).buffer, false, 'text/plain; charset=utf-8'), '文')
})

test('Truncated previews do not display a replacement character for a cut multibyte tail', () => {
  const utf8 = encoder.encode('abc文').buffer.slice(0, -1)
  assert.equal(decodePreviewText(utf8, true, 'text/plain; charset=utf-8'), 'abc')
  assert.equal(decodePreviewText(utf8, false, 'text/plain; charset=utf-8'), 'abc\uFFFD')
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba]).buffer
  assert.equal(decodePreviewText(gbk, true, 'text/plain; charset=gbk'), '你')
  assert.equal(decodePreviewText(gbk, false, 'text/plain; charset=gbk'), '你\uFFFD')
  assert.equal(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x41, 0, 0x87]).buffer, true), 'A')
})
