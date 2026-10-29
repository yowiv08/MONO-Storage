import { parseWorkbookSheet, workbookNames, workbookPage, type WorkbookSheet } from './workbook-data.ts'

type WorkbookRequest = { id: number; type: 'open'; data: ArrayBuffer; kind: 'workbook' | 'csv' } | { id: number; type: 'page'; name: string; page: number }
const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkbookRequest>) => void) | null; postMessage: (value: unknown) => void }
let data: ArrayBuffer | null = null
let kind: 'workbook' | 'csv' = 'workbook'
let names: string[] = []
let sheet: WorkbookSheet | null = null

scope.onmessage = event => {
  const request = event.data
  try {
    if (request.type === 'open') {
      data = request.data
      kind = request.kind
      sheet = null
      names = workbookNames(data, kind)
      scope.postMessage({ id: request.id, names })
    } else {
      if (!data || !names.includes(request.name)) throw new Error('无法读取所选工作表。')
      if (!sheet || sheet.name !== request.name) sheet = parseWorkbookSheet(data, kind, request.name)
      scope.postMessage({ id: request.id, page: workbookPage(sheet, request.page) })
    }
  } catch (error) { scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : '表格解析失败，请下载查看。' }) }
}
