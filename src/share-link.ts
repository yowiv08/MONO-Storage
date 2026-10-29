export function parseShareLink(value: string, origin: string): string {
  const input = value.trim()
  if (/^[a-f0-9]{32}$/.test(input)) return input
  let url: URL
  try { url = new URL(input, origin) } catch { throw new Error('请输入完整的分享链接。') }
  const match = /^\/s\/([a-f0-9]{32})\/?$/.exec(url.pathname)
  if (url.origin !== origin || url.username || url.password || !match) throw new Error('请粘贴本站生成的分享链接，或输入分享编号。')
  return match[1]
}
