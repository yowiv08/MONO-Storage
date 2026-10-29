export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1).replace(/\.0$/, '')} ${units[index]}`
}

export function formatDate(value: string, full = false): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(full ? { hour: '2-digit', minute: '2-digit' } : {}), hour12: false }).format(new Date(value)).replaceAll('/', '.')
}

export function baseName(key: string): string {
  return key.replace(/\/$/, '').split('/').pop() || key
}

export function fileKind(key: string, contentType = ''): 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'file' {
  contentType = contentType.split(';', 1)[0].trim().toLowerCase()
  if (contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(key)) return 'image'
  if (contentType.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(key)) return 'video'
  if (contentType.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(key)) return 'audio'
  if (contentType === 'application/pdf' || /\.pdf$/i.test(key)) return 'pdf'
  if (contentType.startsWith('text/') || /\.(txt|json|csv|md|log|js|ts|css|html|xml|yaml|yml|toml)$/i.test(key)) return 'text'
  return 'file'
}

export function typeLabel(key: string, contentType: string): string {
  const extension = baseName(key).includes('.') ? baseName(key).split('.').pop()!.toUpperCase() : ''
  return extension && extension.length < 9 ? extension : ({ image: '图片', video: '视频', audio: '音频', pdf: 'PDF', text: '文本', file: '文件' })[fileKind(key, contentType)]
}
