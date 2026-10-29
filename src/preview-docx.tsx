import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { sanitizeDocumentHtml } from './preview-html'
import type { PreviewMode } from './preview-kind'

type DocxData = { html: string; text: string; textTruncated: boolean; previewError: string; skippedImages: boolean; warnings: boolean }

export function DocxPreview({ data, mode }: { data: ArrayBuffer; mode: PreviewMode }) {
  const [content, setContent] = useState<DocxData | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const worker = new Worker(new URL('./docx-worker.ts', import.meta.url), { type: 'module' })
    let active = true
    setContent(null); setError('')
    const stop = () => worker.terminate()
    const timer = window.setTimeout(() => { if (active) { setError('文档解析耗时较长，请重试或下载文件。'); stop() } }, 25_000)
    worker.onmessage = event => {
      if (!active) return
      clearTimeout(timer)
      if (event.data.error) setError(String(event.data.error))
      else setContent(event.data as DocxData)
      stop()
    }
    worker.onerror = () => { if (active) { clearTimeout(timer); setError('无法加载 Word 预览，请重试。'); stop() } }
    worker.postMessage(data.slice(0))
    return () => { active = false; clearTimeout(timer); stop() }
  }, [data, retry])
  const html = useMemo(() => content?.html ? sanitizeDocumentHtml(content.html) : '', [content])
  if (error) return <div className="document-state document-error" role="alert"><p>{error}</p><button className="button" onClick={() => setRetry(value => value + 1)}>重新解析</button></div>
  if (!content) return <div className="document-state" role="status"><LoaderCircle size={22} className="spin" />正在读取 Word 文档…</div>
  if (mode === 'source') return <><p className="document-hint">显示从文档提取的文本，保留段落顺序。</p>{content.textTruncated && <p className="document-hint document-limit">原文较长，仅显示前 200 万个字符。下载可查看完整文档。</p>}<pre className="document-source" aria-label="Word 文档原文">{content.text || '这份文档没有可提取的文本。'}</pre></>
  return <>{content.skippedImages && <p className="document-hint">部分图片未嵌入文档或超出预览大小，可下载查看。</p>}{content.warnings && <p className="document-hint">已显示文档正文；部分复杂排版可下载查看。</p>}{content.previewError ? <p className="document-error" role="alert">{content.previewError}</p> : <article className="document-page document-word" aria-label="Word 格式预览" dangerouslySetInnerHTML={{ __html: html }} />}</>
}
