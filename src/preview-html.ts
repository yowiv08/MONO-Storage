import DOMPurify from 'dompurify'
import { safeDocumentLink, safeEmbeddedImage } from './preview-links'

export function sanitizeDocumentHtml(value: string): string {
  const fragment = DOMPurify.sanitize(value, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sup', 'sub', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'a', 'img', 'span', 'div'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
  for (const link of fragment.querySelectorAll('a')) {
    const href = safeDocumentLink(link.getAttribute('href') || '')
    if (href) { link.setAttribute('href', href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); link.setAttribute('referrerpolicy', 'no-referrer') }
    else link.removeAttribute('href')
  }
  for (const image of fragment.querySelectorAll('img')) {
    const src = safeEmbeddedImage(image.getAttribute('src') || '')
    if (src) image.setAttribute('src', src)
    else {
      const placeholder = document.createElement('span')
      placeholder.className = 'document-image-placeholder'
      placeholder.textContent = `图片：${image.getAttribute('alt') || '未嵌入文档的图片'}`
      image.replaceWith(placeholder)
    }
  }
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
