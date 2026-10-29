import { useEffect, useState } from 'react'
import { AlertCircle, ArrowUpRight, Download, Link2, LoaderCircle } from 'lucide-react'
import { api, type StoredObject } from './public-api'
import { FileGlyph, Modal, Preview } from './common-components'
import { formatBytes, formatDate } from './format'
import { parseShareLink } from './share-link'
import { ThemeToggle } from './theme'

type PublicFile = { object: StoredObject; expiresAt: string | null; previewUrl: string; downloadUrl: string }

export function SharedFile({ id }: { id?: string }) {
  const [file, setFile] = useState<PublicFile | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)
  const [input, setInput] = useState('')
  const [selectedId, setSelectedId] = useState(id || '')
  const [lookup, setLookup] = useState(0)
  const [loading, setLoading] = useState(Boolean(id))
  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    setFile(null); setError(''); setLoading(true); setPreview(false)
    api<PublicFile>(`/api/shares/${selectedId}`, { signal: controller.signal }).then(result => { setFile(result); document.title = `${result.object.key} · 文件分享` }).catch(error => { if (error.name !== 'AbortError') { setError(error.message); document.title = id ? '分享已失效' : 'MONO · 文件分享' } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [selectedId, lookup, id])
  return <div className="public-share-page"><ThemeToggle floating /><div className="public-share-brand">MONO<span>FILE SHARING</span></div><main className="public-share-card">
    {!id && <form className="share-lookup-form" onSubmit={event => { event.preventDefault(); try { const next = parseShareLink(input, location.origin); setSelectedId(next); setLookup(value => value + 1) } catch (error) { setSelectedId(''); setFile(null); setLoading(false); document.title = 'MONO · 文件分享'; setError(error instanceof Error ? error.message : '分享链接无效') } }}>
      <div className="eyebrow">GET YOUR FILE</div><h1>通过链接，获取文件。</h1><p>粘贴收到的分享链接，即可预览或下载文件。</p><label className="field-label" htmlFor="public-share-link">分享链接</label><input id="public-share-link" className="text-input" type="text" placeholder="粘贴分享链接或分享编号" autoComplete="off" maxLength={2048} value={input} onChange={event => setInput(event.target.value)} required />
      <button className="button dark" disabled={loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <Link2 size={16} />}获取文件<ArrowUpRight size={16} /></button>
    </form>}
    {error ? <div className="public-share-error" role="alert"><AlertCircle size={24} strokeWidth={1.4} /><h2>{id ? '这份分享已失效。' : '暂时无法获取文件'}</h2><p>{error}</p></div> : loading ? <div className="share-loading"><LoaderCircle size={24} className="spin" />正在读取文件</div> : file ? <div className={!id ? 'share-lookup-result' : ''}>
      <div className="eyebrow">SHARED WITH YOU</div><div className="public-file-icon"><FileGlyph object={file.object} size={44} /></div><h1>{file.object.key}</h1><p>{formatBytes(file.object.size)}<span className="share-meta-dot">·</span>{file.object.contentType}</p>
      <div className="public-file-actions"><a className="button dark" href={file.downloadUrl} download><Download size={16} />下载文件</a><button className="button" onClick={() => setPreview(true)}>在线预览<ArrowUpRight size={15} /></button></div>
      <div className="public-share-expiry"><Link2 size={14} />{file.expiresAt ? `分享有效至 ${formatDate(file.expiresAt, true)}` : '此分享长期有效'}</div>
    </div> : null}
  </main><p className="public-share-bottom">简单存储，自由分享。</p>
    {preview && file && <Modal title={file.object.key} subtitle={formatBytes(file.object.size)} onClose={() => setPreview(false)} wide className="shared-file-viewer"><Preview bucket="" object={file.object} sourceUrl={file.previewUrl} /><div className="modal-footer"><button className="button" onClick={() => setPreview(false)}>关闭</button><a className="button dark" href={file.downloadUrl} download><Download size={15} />下载文件</a></div></Modal>}
  </div>
}
