import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utils, write } from 'xlsx'
import { zipSync, strToU8 } from 'fflate'
import { workbookNames, parseWorkbookSheet, MAX_WORKBOOK_BYTES, MAX_WORKBOOK_SHEETS, MAX_WORKBOOK_CELLS } from '../src/workbook-data.ts'
import { workbookPage, pageMerge, workbookColumnName } from '../src/workbook-model.ts'
import { validateDocumentArchive } from '../src/preview-archive.ts'

function workbook(type: 'xlsx' | 'xls' | 'xlsb' | 'ods' = 'xlsx') {
  const book = utils.book_new()
  const sheet = utils.aoa_to_sheet([['中文标题', null, '日期'], ['项目 + <script>', 12.5, 45292], ['下一行', 25, true]])
  sheet.B2.z = '0.00'
  sheet.C2.z = 'yyyy-mm-dd'
  sheet.B3.f = 'B2*2'
  sheet['!cols'] = [{ wch: 24 }, { wch: 16 }]
  sheet['!rows'] = [{ hpt: 36 }]
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  utils.book_append_sheet(book, sheet, '总览')
  utils.book_append_sheet(book, utils.aoa_to_sheet([['另一个表'], ['值']]), '第二表')
  utils.book_append_sheet(book, {}, '空表')
  return write(book, { type: 'array', bookType: type }) as ArrayBuffer
}

test('XLSX previews preserve sheet selection, Unicode, formatted values, formulas and merge geometry', () => {
  const data = workbook()
  assert.deepEqual(workbookNames(data, 'workbook'), ['总览', '第二表', '空表'])
  const sheet = parseWorkbookSheet(data, 'workbook', '总览')
  assert.equal(sheet.rows[0][0]?.text, '中文标题')
  assert.equal(sheet.rows[1][0]?.text, '项目 + <script>')
  assert.equal(sheet.rows[1][1]?.text, '12.50')
  assert.equal(sheet.rows[1][2]?.text, '2024-01-01')
  assert.equal(sheet.rows[2][1]?.formula, '=B2*2')
  assert.equal(sheet.rows[2][1]?.text, '25')
  assert.ok(sheet.widths[0] > 120)
  assert.ok(sheet.heights[0] > 32)
  const page = workbookPage(sheet, 0)
  assert.equal(pageMerge(page, 0, 0).colSpan, 2)
  assert.equal(pageMerge(page, 0, 1).skip, true)
  assert.match(page.source, /=B2\*2/)
  assert.equal(parseWorkbookSheet(data, 'workbook', '第二表').rows[0][0]?.text, '另一个表')
  assert.equal(parseWorkbookSheet(data, 'workbook', '空表').rowCount, 0)
})

test('Legacy XLS, XLSB and ODS documents keep readable values and multiple sheets', () => {
  for (const type of ['xls', 'xlsb', 'ods'] as const) {
    const data = workbook(type)
    assert.deepEqual(workbookNames(data, 'workbook'), ['总览', '第二表', '空表'])
    const sheet = parseWorkbookSheet(data, 'workbook', '总览')
    assert.equal(sheet.rows[1][0]?.text, '项目 + <script>', type)
    assert.equal(sheet.rows[1][1]?.raw, '12.5', type)
    assert.equal(parseWorkbookSheet(data, 'workbook', '第二表').rows[1][0]?.raw, '值', type)
  }
})

test('CSV and TSV preserve quoted delimiters, multiline cells, leading zeroes and formula-looking text without execution', () => {
  const csv = new TextEncoder().encode('\ufeff名称,编号,说明\r\n"中文,标题",001,"两行\n内容"\r\n"=WEBSERVICE(""https://invalid.example"")",0,"<img onerror=x>"').buffer
  const [name] = workbookNames(csv, 'csv')
  const sheet = parseWorkbookSheet(csv, 'csv', name)
  assert.equal(sheet.rows[1][0]?.text, '中文,标题')
  assert.equal(sheet.rows[1][1]?.text, '001')
  assert.equal(sheet.rows[1][2]?.text, '两行\n内容')
  assert.equal(sheet.rows[2][0]?.formula, undefined)
  assert.match(sheet.rows[2][0]?.text || '', /^=WEBSERVICE/)
  assert.match(workbookPage(sheet, 0).source, /"两行\n内容"/)
  const tsv = new TextEncoder().encode('a\tb\n1\t2').buffer
  assert.equal(parseWorkbookSheet(tsv, 'csv', workbookNames(tsv, 'csv')[0]).columnCount, 2)
  const longCsv = new TextEncoder().encode(Array.from({ length: 5101 }, (_, row) => `${row},x`).join('\n')).buffer
  const long = parseWorkbookSheet(longCsv, 'csv', workbookNames(longCsv, 'csv')[0])
  assert.equal(long.rowCount, 5000)
  assert.equal(long.fullRowCount, 5101)
  assert.match(long.warnings[0], /完整工作表为 5101/)
  assert.throws(() => workbookNames(new TextEncoder().encode('a,b\n"unclosed').buffer, 'csv'), /引号没有闭合/)
  const utf16 = Buffer.from('\ufeff名称\t编号\r\n中文\t001', 'utf16le')
  const utf16Data = utf16.buffer.slice(utf16.byteOffset, utf16.byteOffset + utf16.byteLength)
  const utf16Sheet = parseWorkbookSheet(utf16Data, 'csv', workbookNames(utf16Data, 'csv')[0])
  assert.equal(utf16Sheet.rows[1][0]?.text, '中文')
  assert.equal(utf16Sheet.rows[1][1]?.text, '001')
})

test('Workbook bounds report partial ranges and paginate instead of allocating the complete display', () => {
  const book = utils.book_new()
  const sheet = utils.aoa_to_sheet(Array.from({ length: 5101 }, (_, index) => [index]))
  sheet.HR1 = { t: 's', v: '边界列' }
  sheet['!ref'] = 'A1:HR5101'
  utils.book_append_sheet(book, sheet, '大表')
  const data = write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const parsed = parseWorkbookSheet(data, 'workbook', workbookNames(data, 'workbook')[0])
  assert.equal(parsed.columnCount, 200)
  assert.equal(parsed.rowCount, Math.floor(MAX_WORKBOOK_CELLS / 200))
  assert.equal(parsed.fullRowCount, 5101)
  assert.equal(parsed.fullColumnCount, 226)
  assert.match(parsed.warnings[0], /预览范围/)
  assert.equal(workbookPage(parsed, 0).rows.length, 100)
  assert.equal(workbookPage(parsed, 1).rows[0][0]?.text, '100')
  assert.throws(() => workbookPage(parsed, 99), /页码/)
  assert.equal(workbookColumnName(0), 'A')
  assert.equal(workbookColumnName(199), 'GR')
})

test('Merged cells spanning a pagination boundary retain their anchor text on later pages', () => {
  const book = utils.book_new()
  const sheet = utils.aoa_to_sheet(Array.from({ length: 105 }, (_, index) => [index === 98 ? '合并标题' : '']))
  sheet['!merges'] = [{ s: { r: 98, c: 0 }, e: { r: 102, c: 0 } }]
  utils.book_append_sheet(book, sheet, '合并')
  const parsed = parseWorkbookSheet(write(book, { type: 'array', bookType: 'xlsx' }), 'workbook', '合并')
  const page = workbookPage(parsed, 1)
  const merge = pageMerge(page, 0, 0)
  assert.equal(merge.rowSpan, 3)
  assert.equal(page.mergeCells[merge.sourceKey!]?.text, '合并标题')
  assert.equal(pageMerge(page, 1, 0).skip, true)
})

test('Invalid workbooks and declared oversized compressed contents fail before spreadsheet parsing', () => {
  assert.throws(() => workbookNames(new TextEncoder().encode('invalid workbook').buffer, 'workbook'), /不是受支持/)
  assert.throws(() => workbookNames(new ArrayBuffer(MAX_WORKBOOK_BYTES + 1), 'workbook'), /32 MiB/)
  const book = utils.book_new()
  for (let index = 0; index < MAX_WORKBOOK_SHEETS + 1; index++) utils.book_append_sheet(book, {}, `表${index}`)
  assert.throws(() => workbookNames(write(book, { type: 'array', bookType: 'xlsx' }), 'workbook'), /50 个/)
  const zip = zipSync({ 'content.xml': strToU8('<content>普通文档</content>') })
  const central = zip.findIndex((_, index) => zip[index] === 0x50 && zip[index + 1] === 0x4b && zip[index + 2] === 0x01 && zip[index + 3] === 0x02)
  const changed = zip.slice()
  new DataView(changed.buffer).setUint32(central + 24, 65 * 1024 * 1024, true)
  assert.throws(() => validateDocumentArchive(changed.buffer), /64 MiB/)
  new DataView(changed.buffer).setUint32(central + 24, 1, true)
  assert.throws(() => validateDocumentArchive(changed.buffer), /安全预览范围|压缩内容损坏/)
})
