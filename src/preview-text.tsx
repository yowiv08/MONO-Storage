import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { sanitizeDocumentHtml } from './preview-html'
import { safeDocumentLink, safeEmbeddedImage } from './preview-links'
import type { PreviewKind, PreviewMode } from './preview-kind'

export function TextPreview({ text, kind, mode, truncated }: { text: string; kind: PreviewKind; mode: PreviewMode; truncated: boolean }) {
  const html = useMemo(() => kind === 'html' && mode === 'preview' ? sanitizeDocumentHtml(text) : '', [kind, mode, text])
  const formattedJson = useMemo(() => {
    if (kind !== 'json' || mode !== 'preview' || truncated) return null
    try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return null }
  }, [kind, mode, truncated, text])
  return <>
    {truncated && <p className="document-hint document-limit" role="status">仅显示前 2 MiB 内容，下载文件可查看完整原文。</p>}
    {mode === 'source' ? <pre className="document-source" aria-label="文件文本原文">{text}</pre>
      : kind === 'markdown' ? <article className="document-page document-markdown" aria-label="Markdown 格式预览"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(url, key) => (key === 'src' ? safeEmbeddedImage(url) : safeDocumentLink(url)) || ''} components={{
        a: ({ href, children }) => safeDocumentLink(href) ? <a href={safeDocumentLink(href)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
        img: ({ src, alt }) => safeEmbeddedImage(typeof src === 'string' ? src : undefined) ? <img src={typeof src === 'string' ? src : undefined} alt={alt || ''} /> : <span className="document-image-placeholder">图片：{alt || '未嵌入文档的图片'}</span>,
      }}>{text}</ReactMarkdown></article>
        : kind === 'html' ? <article className="document-page document-html" aria-label="HTML 格式预览" dangerouslySetInnerHTML={{ __html: html }} />
          : <><pre className="document-source document-formatted" aria-label={kind === 'json' ? 'JSON 格式预览' : '文本预览'}>{formattedJson ?? text}</pre>{kind === 'json' && formattedJson === null && !truncated && <p className="document-hint">内容不是有效的 JSON，已显示原文。</p>}</>}
  </>
}
