import { Component, lazy, Suspense, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlignLeft, BookOpen, LoaderCircle, RefreshCw } from 'lucide-react'
import type { StoredObject } from './public-api'
import { decodePreviewText, fetchPreviewData, type PreviewData } from './preview-data'
import { sourceModeLabel, type PreviewKind, type PreviewMode } from './preview-kind'

const TextPreview = lazy(() => import('./preview-text').then(module => ({ default: module.TextPreview })))
const PdfPreview = lazy(() => import('./preview-pdf').then(module => ({ default: module.PdfPreview })))
const WorkbookPreview = lazy(() => import('./preview-workbook').then(module => ({ default: module.WorkbookPreview })))
const DocxPreview = lazy(() => import('./preview-docx').then(module => ({ default: module.DocxPreview })))

class PreviewBoundary extends Component<{ children: ReactNode; mode: PreviewMode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(previous: { mode: PreviewMode }) { if (this.state.failed && previous.mode !== this.props.mode) this.setState({ failed: false }) }
  render() {
    if (this.state.failed) return <div className="document-state document-error" role="alert"><p>内容无法排版，请切换到原文或下载文件查看。</p><button className="button" onClick={() => { this.setState({ failed: false }); this.props.onRetry() }}>重新加载</button></div>
    return this.props.children
  }
}

export function DocumentPreview({ object, sourceUrl, kind, mode: controlledMode, showModeControls = true }: { object: StoredObject; sourceUrl: string; kind: PreviewKind; mode?: PreviewMode; showModeControls?: boolean }) {
  const id = useId()
  const [localMode, setLocalMode] = useState<PreviewMode>('preview')
  const [content, setContent] = useState<PreviewData | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const text = ['markdown', 'csv', 'html', 'json', 'text'].includes(kind)
  const mode = controlledMode ?? localMode
  useEffect(() => {
    const controller = new AbortController()
    setContent(null); setError('')
    fetchPreviewData(sourceUrl, object, controller.signal, text).then(result => { if (!controller.signal.aborted) setContent(result) }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '无法读取文件。') })
    return () => controller.abort()
  }, [sourceUrl, object.size, object.etag, text, retry])
  const decoded = content && text ? decodePreviewText(content.data, content.truncated) : ''
  function switchMode(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || controlledMode) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'source' : mode === 'preview' ? 'source' : 'preview'
    setLocalMode(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus()
  }
  const loading = <div className="document-state" role="status"><LoaderCircle size={22} className="spin" />正在加载文档…</div>
  return <div className={`document-preview document-kind-${kind}`}>
    {showModeControls && <div className="document-modes" role="tablist" aria-label="内容显示方式" onKeyDown={switchMode}>{(['preview', 'source'] as const).map(value => <button type="button" role="tab" key={value} id={`${id}-${value}`} aria-controls={`${id}-content`} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} data-mode={value} onClick={() => setLocalMode(value)}>{value === 'preview' ? <BookOpen size={16} /> : <AlignLeft size={16} />}{value === 'preview' ? '格式预览' : sourceModeLabel(kind)}</button>)}</div>}
    <div className="document-content" id={`${id}-content`} {...(showModeControls ? { role: 'tabpanel', 'aria-labelledby': `${id}-${mode}` } : {})}>
      {error ? <div className="document-state document-error" role="alert"><p>{error}</p><button className="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />重新加载</button></div> : !content ? loading : <PreviewBoundary mode={mode} onRetry={() => setRetry(value => value + 1)}><Suspense fallback={loading}>
        {kind === 'pdf' ? <PdfPreview data={content.data} mode={mode} />
          : kind === 'workbook' || kind === 'csv' && mode === 'preview' ? <>{content.truncated && <p className="document-hint document-limit">仅将文件前 2 MiB 转为表格，最后一行可能不完整。下载可查看完整文件。</p>}<WorkbookPreview data={content.data} kind={kind === 'csv' ? 'csv' : 'workbook'} mode={mode} /></>
            : kind === 'docx' ? <DocxPreview data={content.data} mode={mode} />
              : <TextPreview text={decoded} kind={kind} mode={mode} truncated={content.truncated} />}
      </Suspense></PreviewBoundary>}
    </div>
  </div>
}
