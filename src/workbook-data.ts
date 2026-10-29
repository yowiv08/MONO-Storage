import { read, utils, type CellObject, type WorkBook, type WorkSheet } from 'xlsx'
import { validateDocumentArchive } from './preview-archive.ts'
import { MAX_WORKBOOK_BYTES, MAX_WORKBOOK_SHEETS, MAX_WORKBOOK_ROWS, MAX_WORKBOOK_COLUMNS, MAX_WORKBOOK_CELLS, type WorkbookCell, type WorkbookSheet } from './workbook-model.ts'
export { workbookPage, MAX_WORKBOOK_BYTES, MAX_WORKBOOK_SHEETS, MAX_WORKBOOK_ROWS, MAX_WORKBOOK_COLUMNS, MAX_WORKBOOK_CELLS, WORKBOOK_PAGE_ROWS, type WorkbookSheet, type WorkbookPage } from './workbook-model.ts'
const MAX_CELL_TEXT = 16384
const MAX_SHEET_TEXT = 8 * 1024 * 1024

function textValue(cell: CellObject) {
  if (cell.v === undefined || cell.v === null) return ''
  return cell.v instanceof Date ? cell.v.toISOString() : String(cell.v)
}

function csvText(data: ArrayBuffer) {
  const bytes = new Uint8Array(data)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(data)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(data)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return new TextDecoder('gb18030').decode(data) }
}

function csvDimensions(data: ArrayBuffer) {
  const text = csvText(data)
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0
  let quoted = false
  let firstRow = true
  let delimiter = 44
  let commas = 0
  let tabs = 0
  let semicolons = 0
  let rowColumns = 1
  let columns = 1
  let rows = 0
  let lastRowStart = start
  for (let index = start; index < text.length; index++) {
    const value = text.charCodeAt(index)
    if (value === 34) {
      if (quoted && text.charCodeAt(index + 1) === 34) { index++; continue }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (firstRow) { if (value === 44) commas++; if (value === 9) tabs++; if (value === 59) semicolons++ }
    else if (value === delimiter) rowColumns++
    if (value === 10 || value === 13) {
      if (firstRow) { delimiter = tabs > commas && tabs >= semicolons ? 9 : semicolons > commas ? 59 : 44; rowColumns = (delimiter === 9 ? tabs : delimiter === 59 ? semicolons : commas) + 1; firstRow = false }
      rows++; columns = Math.max(columns, rowColumns); rowColumns = 1
      if (value === 13 && text.charCodeAt(index + 1) === 10) index++
      lastRowStart = index + 1
    }
  }
  if (quoted) throw new Error('CSV 引号没有闭合，请检查文件内容。')
  if (lastRowStart < text.length) {
    if (firstRow) rowColumns = (tabs > commas && tabs >= semicolons ? tabs : semicolons > commas ? semicolons : commas) + 1
    rows++; columns = Math.max(columns, rowColumns)
  }
  return { rows, columns }
}

export function workbookNames(data: ArrayBuffer, kind: 'workbook' | 'csv') {
  if (!data.byteLength) throw new Error('这个表格文件没有内容。')
  if (data.byteLength > MAX_WORKBOOK_BYTES) throw new Error('表格超过 32 MiB，暂不支持在线预览，请下载查看。')
  if (kind === 'workbook') {
    const bytes = new Uint8Array(data)
    const header = new TextDecoder().decode(bytes.subarray(0, 1024))
    const supported = bytes[0] === 0x50 && bytes[1] === 0x4b || bytes[0] === 0xd0 && bytes[1] === 0xcf || bytes[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(bytes[1]) || /(?:<\?xml|<office:document|<Workbook)[\s\S]*(?:spreadsheet|Workbook|office:document)/i.test(header)
    if (!supported) throw new Error('文件内容不是受支持的 Excel 或 OpenDocument 表格。')
  }
  validateDocumentArchive(data)
  if (kind === 'csv') { csvDimensions(data); return ['Sheet1'] }
  const result = readWorkbook(data, kind, { bookSheets: true, bookProps: false })
  if (result.SheetNames.length > MAX_WORKBOOK_SHEETS) throw new Error('表格超过 50 个工作表，请下载查看。')
  if (!result.SheetNames.length) throw new Error('文件中没有可预览的工作表。')
  return [...result.SheetNames]
}

function readWorkbook(data: ArrayBuffer, kind: 'workbook' | 'csv', options: Parameters<typeof read>[1]): WorkBook {
  const source = kind === 'csv' ? csvText(data) : data
  return read(source, { type: kind === 'csv' ? 'string' : 'array', dense: false, raw: kind === 'csv', cellHTML: false, cellNF: true, cellStyles: true, cellFormula: true, cellText: true, bookVBA: false, sheetRows: MAX_WORKBOOK_ROWS, ...options })
}

function sheetRange(sheet: WorkSheet, property: '!ref' | '!fullref') {
  const ref = sheet[property] as string | undefined
  if (!ref) return null
  try {
    const range = utils.decode_range(ref)
    if (![range.s.r, range.s.c, range.e.r, range.e.c].every(value => Number.isSafeInteger(value) && value >= 0) || range.e.r < range.s.r || range.e.c < range.s.c || range.e.r > 1048575 || range.e.c > 16383) throw new Error()
    return range
  } catch { throw new Error('工作表的行列范围无效，请下载查看。') }
}

export function parseWorkbookSheet(data: ArrayBuffer, kind: 'workbook' | 'csv', name: string): WorkbookSheet {
  const csvRange = kind === 'csv' ? csvDimensions(data) : null
  const parsed = readWorkbook(data, kind, { sheets: [name] })
  const sheet = parsed.Sheets?.[name]
  if (!sheet) throw new Error('无法读取所选工作表。')
  const ref = sheetRange(sheet, '!ref')
  const fullRef = sheetRange(sheet, '!fullref') || ref
  if (!ref || !fullRef) return { name, startRow: 0, startColumn: 0, rowCount: 0, columnCount: 0, fullRowCount: fullRef ? fullRef.e.r - fullRef.s.r + 1 : 0, fullColumnCount: fullRef ? fullRef.e.c - fullRef.s.c + 1 : 0, rows: [], widths: [], heights: [], merges: [], warnings: fullRef ? ['前 5000 行没有可预览内容，下载可查看完整工作表。'] : [] }
  const fullRows = csvRange?.rows || fullRef.e.r - fullRef.s.r + 1
  const fullColumns = csvRange?.columns || fullRef.e.c - fullRef.s.c + 1
  const columns = Math.min(MAX_WORKBOOK_COLUMNS, ref.e.c - ref.s.c + 1)
  const rows = Math.min(MAX_WORKBOOK_ROWS, ref.e.r - ref.s.r + 1, Math.floor(MAX_WORKBOOK_CELLS / columns))
  const warnings: string[] = []
  if (fullRows > rows || fullColumns > columns) warnings.push(`预览范围为 ${rows} 行 × ${columns} 列，完整工作表为 ${fullRows} 行 × ${fullColumns} 列；下载可查看全部内容。`)
  let truncatedText = false
  let uncachedFormula = false
  let textBudget = MAX_SHEET_TEXT
  const visibleRows = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c): WorkbookCell | null => {
    const cell = sheet[utils.encode_cell({ r: r + ref.s.r, c: c + ref.s.c })] as CellObject | undefined
    if (!cell || cell.t === 'z') return null
    const raw = textValue(cell)
    let text = cell.w !== undefined ? String(cell.w) : raw
    if (cell.f && cell.v === undefined) { text = '未保存计算结果'; uncachedFormula = true }
    const formula = cell.f ? `=${cell.f}` : undefined
    const length = Math.min(MAX_CELL_TEXT, Math.floor(textBudget / 3))
    if (raw.length > length || text.length > length || (formula?.length || 0) > length) truncatedText = true
    const visible = { text: text.slice(0, length), raw: raw.slice(0, length), ...(formula ? { formula: formula.slice(0, length) } : {}), numeric: cell.t === 'n' || cell.t === 'd' }
    textBudget -= visible.text.length + visible.raw.length + (visible.formula?.length || 0)
    return visible
  }))
  if (truncatedText) warnings.push('单元格长文本超过预览范围：每个单元格最多 16384 个字符、当前工作表文本合计最多 8 MiB；下载可查看完整内容。')
  if (uncachedFormula) warnings.push('部分公式没有保存计算结果；原文视图可查看公式，在线预览不会执行公式。')
  const widths = Array.from({ length: columns }, (_, c) => {
    const info = sheet['!cols']?.[c + ref.s.c]
    const width = info?.wpx || (info?.wch ? info.wch * 8 + 16 : 120)
    return Math.min(420, Math.max(80, Number.isFinite(width) ? width : 120))
  })
  const heights = Array.from({ length: rows }, (_, r) => {
    const info = sheet['!rows']?.[r + ref.s.r]
    const height = info?.hpx || (info?.hpt ? info.hpt * 4 / 3 : 32)
    return Math.min(160, Math.max(32, Number.isFinite(height) ? height : 32))
  })
  const merges = (sheet['!merges'] || []).filter(range => range.e.r >= ref.s.r && range.s.r < ref.s.r + rows && range.e.c >= ref.s.c && range.s.c < ref.s.c + columns).slice(0, 1000)
  if ((sheet['!merges']?.length || 0) > 1000) warnings.push('工作表合并区域较多，预览显示前 1000 个合并区域。')
  return { name, startRow: ref.s.r, startColumn: ref.s.c, rowCount: rows, columnCount: columns, fullRowCount: fullRows, fullColumnCount: fullColumns, rows: visibleRows, widths, heights, merges, warnings }
}
