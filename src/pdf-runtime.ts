export const MAX_PDF_CANVAS_PIXELS = 16 * 1024 * 1024
export const MAX_PDF_CANVAS_SIDE = 8192
export const MAX_PDF_SOURCE_CHARACTERS = 256 * 1024

export type PdfTextItem = { str: string; hasEOL?: boolean; transform?: unknown[]; width?: number; height?: number }

export function pdfCanvasSize(width: number, height: number, requestedScale: number, deviceScale = 1) {
  if (![width, height, requestedScale, deviceScale].every(Number.isFinite) || width <= 0 || height <= 0 || requestedScale <= 0 || deviceScale <= 0) throw new Error('PDF 页面尺寸无效。')
  const scale = Math.min(requestedScale, MAX_PDF_CANVAS_SIDE / width, MAX_PDF_CANVAS_SIDE / height, Math.sqrt(MAX_PDF_CANVAS_PIXELS / width / height))
  const displayWidth = Math.max(1, width * scale)
  const displayHeight = Math.max(1, height * scale)
  const outputScale = Math.min(deviceScale, 2, MAX_PDF_CANVAS_SIDE / displayWidth, MAX_PDF_CANVAS_SIDE / displayHeight, Math.sqrt(MAX_PDF_CANVAS_PIXELS / displayWidth / displayHeight))
  return {
    scale,
    displayWidth,
    displayHeight,
    outputScale,
    pixelWidth: Math.max(1, Math.floor(displayWidth * outputScale)),
    pixelHeight: Math.max(1, Math.floor(displayHeight * outputScale)),
    limited: scale < requestedScale,
  }
}

export function pdfPageNumber(input: string | number, totalPages: number): number | null {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1 || typeof input === 'string' && !/^\d+$/.test(input.trim())) return null
  const page = Number(input)
  return Number.isSafeInteger(page) && page >= 1 && page <= totalPages ? page : null
}

export function pdfPageText(items: readonly unknown[], limit = MAX_PDF_SOURCE_CHARACTERS): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('PDF 原文长度限制无效。')
  const segments: string[] = []
  let length = 0
  let previous: PdfTextItem | null = null
  let truncated = false
  for (const value of items) {
    if (!value || typeof value !== 'object' || !('str' in value) || typeof value.str !== 'string') continue
    const item = value as PdfTextItem
    let separator = ''
    if (previous && !previous.hasEOL && previous.str && item.str) {
      const previousX = Number(previous.transform?.[4])
      const previousY = Number(previous.transform?.[5])
      const x = Number(item.transform?.[4])
      const y = Number(item.transform?.[5])
      const height = Math.max(1, Math.abs(Number(item.height) || Number(item.transform?.[3]) || 10))
      if ([previousY, y].every(Number.isFinite) && Math.abs(y - previousY) > Math.max(2, height * .35)) separator = '\n'
      else if ([previousX, x, previous.width].every(Number.isFinite) && x - previousX - Number(previous.width) > Math.max(1, height * .15) && !/\s$/.test(previous.str) && !/^\s/.test(item.str)) separator = ' '
    }
    const segment = separator + item.str + (item.hasEOL ? '\n' : '')
    const remaining = limit - length
    if (segment.length > remaining) {
      let ending = segment.slice(0, remaining)
      if (ending && /[\uD800-\uDBFF]$/.test(ending)) ending = ending.slice(0, -1)
      segments.push(ending)
      truncated = true
      break
    }
    segments.push(segment)
    length += segment.length
    previous = item
  }
  return { text: segments.join(''), truncated }
}
