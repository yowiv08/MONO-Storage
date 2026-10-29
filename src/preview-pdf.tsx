import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, Maximize2, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import { AnnotationMode, getDocument, GlobalWorkerOptions, PasswordResponses, VerbosityLevel, type PDFDocumentProxy, type PDFDocumentLoadingTask, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { MAX_PDF_CANVAS_PIXELS, MAX_PDF_SOURCE_CHARACTERS, pdfCanvasSize, pdfPageNumber, pdfPageText } from './pdf-runtime'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type PasswordRequest = { data: ArrayBuffer; update: (password: string) => void; incorrect: boolean }
type DocumentState = { data: ArrayBuffer; document: PDFDocumentProxy }
type SourceState = { document: PDFDocumentProxy; page: number; text: string; truncated: boolean }
const zoomValues = [.5, .75, 1, 1.25, 1.5, 2, 3]

export function PdfPreview({ data, mode }: { data: ArrayBuffer; mode: 'preview' | 'source' }) {
  const id = useId()
  const [loaded, setLoaded] = useState<DocumentState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null)
  const [password, setPassword] = useState('')
  const [passwordPending, setPasswordPending] = useState(false)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [rotation, setRotation] = useState(0)
  const [width, setWidth] = useState(0)
  const [rendering, setRendering] = useState(true)
  const [renderError, setRenderError] = useState('')
  const [renderLimited, setRenderLimited] = useState(false)
  const [source, setSource] = useState<SourceState | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderingTaskRef = useRef<RenderTask | null>(null)
  const renderingPromiseRef = useRef<Promise<void> | null>(null)
  const activeDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const activeDataRef = useRef(data)
  const effectiveZoomRef = useRef(1)
  const currentDocument = loaded?.data === data ? loaded.document : null
  const currentPassword = passwordRequest?.data === data ? passwordRequest : null
  activeDocumentRef.current = currentDocument
  activeDataRef.current = data

  useEffect(() => {
    let disposed = false
    let task: PDFDocumentLoadingTask | null = null
    const isCurrent = () => !disposed && activeDataRef.current === data
    setLoaded(null); setLoadError(''); setPasswordRequest(null); setPassword(''); setPasswordPending(false)
    setPageNumber(1); setPageInput('1'); setZoom('fit'); setRotation(0); setWidth(0)
    setSource(null); setSourceError(''); setRenderError(''); setRendering(true)
    try {
      const options = {
        data: new Uint8Array(data.slice(0)),
        cMapUrl: '/assets/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/assets/pdfjs/standard_fonts/',
        wasmUrl: '/assets/pdfjs/wasm/',
        useWorkerFetch: true,
        useSystemFonts: true,
        isEvalSupported: false,
        enableXfa: false,
        maxImageSize: MAX_PDF_CANVAS_PIXELS,
        canvasMaxAreaInBytes: MAX_PDF_CANVAS_PIXELS * 4,
        verbosity: VerbosityLevel.ERRORS,
      }
      task = getDocument(options)
      task.onPassword = (update: (password: string) => void, reason: number) => {
        if (!isCurrent()) return
        setPasswordRequest({ data, update, incorrect: reason === PasswordResponses.INCORRECT_PASSWORD })
        setPassword(''); setPasswordPending(false)
      }
      void task.promise.then(document => {
        if (!isCurrent()) return
        setLoaded({ data, document }); setPasswordRequest(null); setPassword(''); setPasswordPending(false)
      }).catch(error => {
        if (isCurrent()) setLoadError(error?.name === 'InvalidPDFException' ? 'PDF 文件损坏或格式无效，无法预览。' : '无法打开 PDF，请下载后查看或重新上传。')
      })
    } catch {
      setLoadError('PDF 预览无法启动，请刷新页面后重试。')
    }
    return () => {
      disposed = true
      renderingTaskRef.current?.cancel()
      if (task) void task.destroy().catch(() => undefined)
    }
  }, [data])

  useEffect(() => { setPageInput(String(pageNumber)) }, [pageNumber])

  useEffect(() => {
    if (!currentDocument || mode !== 'preview' || !scrollRef.current) return
    const container = scrollRef.current
    const measure = () => {
      const styles = getComputedStyle(container)
      const measured = Math.max(1, Math.floor(container.clientWidth - (parseFloat(styles.paddingLeft) || 0) - (parseFloat(styles.paddingRight) || 0)))
      setWidth(previous => previous === measured ? previous : measured)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [currentDocument, mode])

  useEffect(() => {
    if (!currentDocument || mode !== 'preview' || !canvasRef.current || width === 0) return
    let disposed = false
    let task: RenderTask | null = null
    let page: PDFPageProxy | null = null
    const previousRendering = renderingPromiseRef.current
    const canvas = canvasRef.current
    const isCurrent = () => !disposed && activeDocumentRef.current === currentDocument && activeDataRef.current === data
    setRendering(true); setRenderError(''); setRenderLimited(false)
    const renderingPromise = (async () => {
      if (previousRendering) await previousRendering
      if (!isCurrent()) return
      page = await currentDocument.getPage(pageNumber)
      if (!isCurrent()) return
      const pageRotation = (page.rotate + rotation) % 360
      const original = page.getViewport({ scale: 1, rotation: pageRotation })
      const requestedScale = zoom === 'fit' ? width / original.width : zoom
      const size = pdfCanvasSize(original.width, original.height, requestedScale, window.devicePixelRatio || 1)
      const viewport = page.getViewport({ scale: size.scale, rotation: pageRotation })
      effectiveZoomRef.current = size.scale
      canvas.width = size.pixelWidth; canvas.height = size.pixelHeight
      canvas.style.width = `${size.displayWidth}px`; canvas.style.height = `${size.displayHeight}px`
      task = page.render({ canvas, viewport, transform: [size.outputScale, 0, 0, size.outputScale, 0, 0], annotationMode: AnnotationMode.DISABLE, background: '#ffffff' })
      renderingTaskRef.current = task
      await task.promise
      if (isCurrent()) { setRendering(false); setRenderLimited(size.limited) }
    })().catch(error => {
      if (isCurrent() && error?.name !== 'RenderingCancelledException') { setRendering(false); setRenderError('这一页无法显示，可以切换到原文或下载文件查看。') }
    }).finally(() => {
      if (renderingTaskRef.current === task) renderingTaskRef.current = null
      page?.cleanup()
    })
    renderingPromiseRef.current = renderingPromise
    void renderingPromise.then(() => { if (renderingPromiseRef.current === renderingPromise) renderingPromiseRef.current = null })
    return () => { disposed = true; task?.cancel() }
  }, [currentDocument, data, mode, pageNumber, zoom, rotation, width])

  useEffect(() => {
    if (!currentDocument || mode !== 'source') return
    let disposed = false
    let page: PDFPageProxy | null = null
    let reader: ReadableStreamDefaultReader | null = null
    setSource(null); setSourceError(''); setSourceLoading(true)
    void (async () => {
      page = await currentDocument.getPage(pageNumber)
      if (disposed) return
      reader = page.streamTextContent({ disableNormalization: true }).getReader()
      const items: unknown[] = []
      let characters = 0
      let stopped = false
      while (!disposed) {
        const chunk = await reader.read()
        if (chunk.done) break
        for (const item of chunk.value.items as unknown[]) {
          items.push(item)
          if (item && typeof item === 'object' && 'str' in item && typeof item.str === 'string') characters += item.str.length
          if (characters > MAX_PDF_SOURCE_CHARACTERS || items.length >= 50_000) { stopped = true; break }
        }
        if (stopped) { await reader.cancel(); break }
      }
      if (disposed) return
      const content = pdfPageText(items)
      setSource({ document: currentDocument, page: pageNumber, ...content, truncated: content.truncated || stopped })
    })().catch(() => {
      if (!disposed) setSourceError('这一页无法提取文本，可以切换到预览或下载文件查看。')
    }).finally(() => {
      if (!disposed) setSourceLoading(false)
      reader?.releaseLock()
      page?.cleanup()
    })
    return () => { disposed = true; if (reader) void reader.cancel().catch(() => undefined) }
  }, [currentDocument, mode, pageNumber])

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentPassword || !password || passwordPending) return
    const value = password
    setPassword(''); setPasswordPending(true)
    currentPassword.update(value)
  }

  function goToPage() {
    if (!currentDocument || pageInput === String(pageNumber)) return
    const next = pdfPageNumber(pageInput, currentDocument.numPages)
    if (next === null) setPageInput(String(pageNumber))
    else setPageNumber(next)
  }

  function adjustZoom(direction: 1 | -1) {
    const current = zoom === 'fit' ? effectiveZoomRef.current : zoom
    setZoom(Math.max(.25, Math.min(3, Math.round((current + direction * .25) * 4) / 4)))
  }

  if (loadError) return <div className="pdf-state document-error" role="alert">{loadError}</div>
  if (currentPassword) return <form className="pdf-password" onSubmit={unlock}>
    <h3>此 PDF 需要密码</h3>
    <p className="document-hint">输入文件密码以查看内容，密码不会保存。</p>
    {currentPassword.incorrect && <p className="document-error" role="alert">密码不正确，请重新输入。</p>}
    <label htmlFor={`${id}-password`}>文件密码</label>
    <input className="text-input" id={`${id}-password`} type="password" autoComplete="off" spellCheck={false} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={passwordPending} />
    <button className="button dark" type="submit" disabled={!password || passwordPending}>{passwordPending && <LoaderCircle size={16} className="spin" />}打开 PDF</button>
  </form>
  if (!currentDocument) return <div className="pdf-state" role="status"><LoaderCircle size={22} className="spin" />正在读取 PDF</div>
  const pageSource = source?.document === currentDocument && source.page === pageNumber ? source : null
  const customZoom = zoom !== 'fit' && !zoomValues.includes(zoom)
  return <div className={`pdf-preview ${mode === 'source' ? 'pdf-source-mode' : ''}`}>
    <div className="pdf-toolbar" role="group" aria-label="PDF 阅读工具">
      <div className="pdf-pagination">
        <button className="icon-button" type="button" aria-label="上一页" title="上一页" disabled={pageNumber <= 1} onClick={() => setPageNumber(page => page - 1)}><ChevronLeft size={18} /></button>
        <label htmlFor={`${id}-page`}>第 <input className="pdf-page-input" id={`${id}-page`} type="text" inputMode="numeric" aria-label="PDF 页码" value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={goToPage} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); goToPage() } }} /> / {currentDocument.numPages} 页</label>
        <button className="icon-button" type="button" aria-label="下一页" title="下一页" disabled={pageNumber >= currentDocument.numPages} onClick={() => setPageNumber(page => page + 1)}><ChevronRight size={18} /></button>
      </div>
      {mode === 'preview' && <div className="pdf-display-controls">
        <button className="icon-button" type="button" aria-label="缩小 PDF" title="缩小" disabled={zoom !== 'fit' && zoom <= .25} onClick={() => adjustZoom(-1)}><ZoomOut size={18} /></button>
        <select className="pdf-zoom-select" aria-label="PDF 缩放" value={zoom} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}>
          <option value="fit">适应宽度</option>
          {zoomValues.map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
          {customZoom && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
        </select>
        <button className="icon-button" type="button" aria-label="放大 PDF" title="放大" disabled={zoom !== 'fit' && zoom >= 3} onClick={() => adjustZoom(1)}><ZoomIn size={18} /></button>
        <button className="icon-button" type="button" aria-label="PDF 适应宽度" title="适应宽度" onClick={() => setZoom('fit')}><Maximize2 size={18} /></button>
        <button className="icon-button" type="button" aria-label="旋转 PDF" title="顺时针旋转" onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={18} /></button>
      </div>}
    </div>
    {mode === 'preview' ? <>
      <div className="pdf-canvas-scroll" ref={scrollRef} aria-busy={rendering} style={{ scrollbarGutter: 'stable' }}>
        {rendering && <div className="pdf-state" role="status" style={{ position: 'absolute', inset: '0 0 auto', pointerEvents: 'none' }}><LoaderCircle size={22} className="spin" />正在显示第 {pageNumber} 页</div>}
        {renderError && <div className="pdf-state document-error" role="alert" style={{ position: 'absolute', inset: '0 0 auto', pointerEvents: 'none' }}>{renderError}</div>}
        <canvas className="pdf-canvas-page" ref={canvasRef} aria-label={`PDF 第 ${pageNumber} 页`} role="img" style={{ display: 'block', visibility: rendering || renderError ? 'hidden' : 'visible' }} />
      </div>
      {renderLimited && <p className="document-hint">此页尺寸较大，已调整显示比例。</p>}
    </> : <div className="pdf-source-pages">
      <p className="document-hint">原文显示当前页提取的文本，不包含页面排版。</p>
      {sourceLoading ? <div className="pdf-state" role="status"><LoaderCircle size={22} className="spin" />正在提取第 {pageNumber} 页文本</div> : sourceError ? <div className="pdf-state document-error" role="alert">{sourceError}</div> : pageSource && <section className="pdf-source-page" aria-label={`PDF 第 ${pageNumber} 页原文`}>
        {pageSource.text.trim() ? <pre>{pageSource.text}</pre> : <p className="document-hint">此页没有可提取文本，可能是扫描图片；可切换到预览查看。</p>}
        {pageSource.truncated && <p className="document-hint">此页文本较长，已显示部分原文；下载可查看完整文件。</p>}
      </section>}
    </div>}
  </div>
}

export default PdfPreview
