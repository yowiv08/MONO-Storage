export function safeDocumentLink(value?: string): string | null {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null
  if (/^#[\p{L}\p{N}_:.-]+$/u.test(value)) return value
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function safeEmbeddedImage(value?: string): string | null {
  if (!value || value.length > 3 * 1024 * 1024) return null
  return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value) ? value : null
}
