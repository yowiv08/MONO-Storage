export type PreviewKind = 'markdown' | 'pdf' | 'workbook' | 'csv' | 'docx' | 'html' | 'json' | 'text' | 'image' | 'video' | 'audio' | 'file'
export type PreviewMode = 'preview' | 'source'

export function previewKind(key: string, contentType = ''): PreviewKind {
  const type = contentType.split(';', 1)[0].trim().toLowerCase()
  const extension = key.split('/').pop()?.split('.').pop()?.toLowerCase() || ''
  if (/^(md|markdown|mdown|mkd)$/.test(extension)) return 'markdown'
  if (extension === 'pdf') return 'pdf'
  if (/^(xlsx|xls|xlsb|xlsm|xltx|xltm|ods)$/.test(extension)) return 'workbook'
  if (/^(csv|tsv)$/.test(extension)) return 'csv'
  if (extension === 'docx') return 'docx'
  if (/^(html|htm)$/.test(extension)) return 'html'
  if (extension === 'json') return 'json'
  if (/^(png|jpe?g|gif|webp|avif|svg|ico)$/.test(extension)) return 'image'
  if (/^(mp4|webm|mov)$/.test(extension)) return 'video'
  if (/^(mp3|wav|ogg|m4a|flac)$/.test(extension)) return 'audio'
  if (['text/markdown', 'text/x-markdown', 'application/markdown'].includes(type)) return 'markdown'
  if (type === 'application/pdf') return 'pdf'
  if (/^(application\/(?:vnd\.ms-excel(?:\..+)?|vnd\.openxmlformats-officedocument\.spreadsheetml\..+|vnd\.oasis\.opendocument\.spreadsheet))$/.test(type)) return 'workbook'
  if (['text/csv', 'application/csv', 'text/tab-separated-values'].includes(type)) return 'csv'
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (['text/html', 'application/xhtml+xml'].includes(type)) return 'html'
  if (type === 'application/json' || type.endsWith('+json')) return 'json'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('text/') || /^(txt|log|js|jsx|ts|tsx|css|xml|yaml|yml|toml|ini|conf|sh|py|sql|c|h|cpp|java|rs|go)$/.test(extension)) return 'text'
  return 'file'
}

export function supportsDocumentSource(kind: PreviewKind): boolean {
  return !['image', 'video', 'audio', 'file'].includes(kind)
}

export function sourceModeLabel(kind: PreviewKind): string {
  return ['pdf', 'docx'].includes(kind) ? '文档原文' : kind === 'workbook' ? '表格原文' : '文本原文'
}
