import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X, File, FileText, Image, Film, Music2, Folder, Table2 } from 'lucide-react'
import type { StoredObject } from './public-api'
import { baseName, fileKind } from './format'
import { DocumentPreview } from './document-preview'
import { previewKind, supportsDocumentSource, type PreviewMode } from './preview-kind'

export function FileGlyph({ object, folder = false, size = 18 }: { object?: StoredObject; folder?: boolean; size?: number }) {
  const kind = folder ? 'folder' : fileKind(object?.key || '', object?.contentType)
  const documentKind = previewKind(object?.key || '', object?.contentType)
  const Icon = !folder && ['workbook', 'csv'].includes(documentKind) ? Table2 : !folder && ['markdown', 'docx'].includes(documentKind) ? FileText : ({ folder: Folder, file: File, text: FileText, image: Image, video: Film, audio: Music2, pdf: FileText })[kind]
  return <Icon size={size} strokeWidth={1.6} />
}

const modalLayers: HTMLDivElement[] = []
let modalBodyOverflow = ''

export function Modal({ title, subtitle, onClose, children, wide = false, className = '' }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (!modalLayers.length) modalBodyOverflow = document.body.style.overflow
    modalLayers.push(element)
    const isTopLayer = () => modalLayers.at(-1) === element
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, a[href], [tabindex="0"]') || [])
    const input = ref.current?.querySelector<HTMLElement>('input:not([type="checkbox"]), textarea')
    ;(input || focusable()[0])?.focus()
    const handler = (event: KeyboardEvent) => {
      if (!isTopLayer()) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      const wasTopLayer = isTopLayer()
      const index = modalLayers.indexOf(element)
      if (index >= 0) modalLayers.splice(index, 1)
      if (!modalLayers.length) document.body.style.overflow = modalBodyOverflow
      if (wasTopLayer && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && modalLayers.at(-1) === ref.current) onClose() }}>
    <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={19} /></button></div>
      {children}
    </div>
  </div>
}

export function Preview({ object, sourceUrl, mode, showModeControls = true }: { object: StoredObject; sourceUrl: string; bucket?: string; mode?: PreviewMode; showModeControls?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false)
  const kind = previewKind(object.key, object.contentType)
  const url = sourceUrl
  useEffect(() => setImageFailed(false), [url])
  if (supportsDocumentSource(kind)) return <DocumentPreview key={`${object.key}:${object.etag}`} object={object} sourceUrl={sourceUrl} kind={kind} mode={mode} showModeControls={showModeControls} />
  if (kind === 'image' && !imageFailed) return <div className="preview-image checkerboard"><img src={url} alt={baseName(object.key)} onError={() => setImageFailed(true)} /></div>
  if (kind === 'video') return <div className="preview-media"><video src={url} controls preload="metadata" /></div>
  if (kind === 'audio') return <div className="preview-audio"><Music2 size={44} strokeWidth={1} /><audio src={url} controls preload="metadata" /></div>
  return <div className="preview-unavailable"><FileGlyph object={object} size={48} /><strong>{imageFailed ? '浏览器无法预览这张图片' : '这个文件暂不支持在线预览'}</strong><span>可以下载后在本地打开</span></div>
}
