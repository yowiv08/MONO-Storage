export const MAX_WORKBOOK_BYTES = 32 * 1024 * 1024
export const MAX_WORKBOOK_SHEETS = 50
export const MAX_WORKBOOK_ROWS = 5000
export const MAX_WORKBOOK_COLUMNS = 200
export const MAX_WORKBOOK_CELLS = 250000
export const WORKBOOK_PAGE_ROWS = 100

export type WorkbookRange = { s: { r: number; c: number }; e: { r: number; c: number } }
export type WorkbookCell = { text: string; raw: string; formula?: string; numeric: boolean }
export type WorkbookSheet = {
  name: string
  startRow: number
  startColumn: number
  rowCount: number
  columnCount: number
  fullRowCount: number
  fullColumnCount: number
  rows: Array<Array<WorkbookCell | null>>
  widths: number[]
  heights: number[]
  merges: WorkbookRange[]
  warnings: string[]
}
export type WorkbookPage = Omit<WorkbookSheet, 'rows' | 'heights'> & { page: number; rows: Array<Array<WorkbookCell | null>>; heights: number[]; source: string; mergeCells: Record<string, WorkbookCell | null> }

function quoteSource(value: string) { return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value }

export function workbookPage(sheet: WorkbookSheet, page: number): WorkbookPage {
  const pages = Math.max(1, Math.ceil(sheet.rowCount / WORKBOOK_PAGE_ROWS))
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new Error('工作表页码无效。')
  const start = page * WORKBOOK_PAGE_ROWS
  const rows = sheet.rows.slice(start, start + WORKBOOK_PAGE_ROWS)
  const source = rows.map(row => row.map(cell => quoteSource(cell?.formula || cell?.raw || '')).join('\t')).join('\n')
  const mergeCells: Record<string, WorkbookCell | null> = Object.create(null)
  for (const range of sheet.merges) {
    if (range.e.r < sheet.startRow + start || range.s.r >= sheet.startRow + start + rows.length) continue
    mergeCells[`${range.s.r}:${range.s.c}`] = sheet.rows[range.s.r - sheet.startRow]?.[range.s.c - sheet.startColumn] || null
  }
  const { rows: _rows, heights, ...info } = sheet
  return { ...info, merges: info.merges.filter(range => range.e.r >= sheet.startRow + start && range.s.r < sheet.startRow + start + rows.length), page, rows, heights: heights.slice(start, start + WORKBOOK_PAGE_ROWS), source, mergeCells }
}

export function workbookColumnName(index: number) {
  let value = index + 1
  let name = ''
  while (value > 0) { name = String.fromCharCode(65 + (value - 1) % 26) + name; value = Math.floor((value - 1) / 26) }
  return name
}

export function pageMerge(sheet: WorkbookPage, row: number, column: number) {
  const absoluteRow = sheet.startRow + sheet.page * WORKBOOK_PAGE_ROWS + row
  const absoluteColumn = sheet.startColumn + column
  const range = sheet.merges.find(item => absoluteRow >= item.s.r && absoluteRow <= item.e.r && absoluteColumn >= item.s.c && absoluteColumn <= item.e.c)
  if (!range) return { skip: false, rowSpan: 1, colSpan: 1 }
  const firstRow = Math.max(range.s.r, sheet.startRow + sheet.page * WORKBOOK_PAGE_ROWS)
  const firstColumn = Math.max(range.s.c, sheet.startColumn)
  if (absoluteRow !== firstRow || absoluteColumn !== firstColumn) return { skip: true, rowSpan: 0, colSpan: 0 }
  return { skip: false, rowSpan: Math.min(range.e.r + 1, sheet.startRow + sheet.page * WORKBOOK_PAGE_ROWS + sheet.rows.length) - firstRow, colSpan: Math.min(range.e.c + 1, sheet.startColumn + sheet.columnCount) - firstColumn, sourceKey: `${range.s.r}:${range.s.c}` }
}
