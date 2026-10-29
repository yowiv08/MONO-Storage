import { useEffect, useState } from 'react'
import { AlertCircle, ArrowUpRight, Check, Copy, Download, Link2, LoaderCircle, Share2, ShieldCheck, X } from 'lucide-react'
import { api, bucketPath, type StoredObject } from './api'
import { FileGlyph, Modal } from './common-components'
import { baseName, formatBytes, formatDate } from './format'
import { parseShareLink } from './share-link'
import { ThemeToggle } from './theme'

type ShareLink = { id: string; url: string; createdAt: string; expiresAt: string | null }
type PublicFile = { object: StoredObject; expiresAt: string | null; previewUrl: string; downloadUrl: string }

export function ShareDialog({ bucket, object, onClose, notify }: { bucket: string; object: StoredObject; onClose: () => void; notify: (message: string) => void }) {
  const [share, setShare] = useState<ShareLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expiresIn, setExpiresIn] = useState('604800')
  const [copied, setCopied] = useState(false)
  const endpoint = `${bucketPath(bucket, 'shares')}?${new URLSearchParams({ key: object.key })}`
  useEffect(() => {
    const controller = new AbortController()
    api<{ share: ShareLink | null }>(endpoint, { signal: controller.signal }).then(result => setShare(result.share)).catch(error => { if (error.name !== 'AbortError') setError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [endpoint])
  const url = share ? new URL(share.url, location.origin).href : ''
  async function create() {
    setBusy(true); setError('')
    try {
      setShare(await api<ShareLink>(bucketPath(bucket, 'shares'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: object.key, expiresIn: expiresIn === 'forever' ? null : Number(expiresIn) }) }))
      setCopied(false)
    } catch (error) { setError(error instanceof Error ? error.message : '创建分享失败') }
    finally { setBusy(false) }
  }
  async function revoke() {
    setBusy(true); setError('')
    try { await api(endpoint, { method: 'DELETE' }); setShare(null); setCopied(false); notify('分享已取消，原链接已失效') }
    catch (error) { setError(error instanceof Error ? error.message : '取消分享失败') }
    finally { setBusy(false) }
  }
  return <Modal title="分享文件" subtitle="用一个链接，把文件交给需要的人。" onClose={() => { if (!busy) onClose() }}>
    <div className="modal-content share-content">
      <div className="share-file"><span className="share-file-icon"><FileGlyph object={object} size={23} /></span><div><strong>{baseName(object.key)}</strong><span>{formatBytes(object.size)} · {object.contentType}</span></div></div>
      {loading ? <div className="share-loading"><LoaderCircle className="spin" size={20} />正在读取分享状态</div> : share ? <>
        <div className="share-status"><span><Link2 size={15} />分享已开启</span><span>{share.expiresAt ? `${formatDate(share.expiresAt, true)} 到期` : '长期有效'}</span></div>
        <label className="field-label" htmlFor="share-link">分享链接</label>
        <div className="share-link-field"><input id="share-link" value={url} readOnly onFocus={event => event.target.select()} /><button className="icon-button" aria-label="复制分享链接" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); notify('分享链接已复制') } catch { setError('请选中上方链接并手动复制。') } }}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>
        <a className="text-button share-open" href={share.url} target="_blank" rel="noreferrer">打开分享页面<ArrowUpRight size={14} /></a>
      </> : <div className="share-expiration"><label className="field-label" htmlFor="share-expiration">链接有效期</label><select id="share-expiration" className="text-input" value={expiresIn} onChange={event => setExpiresIn(event.target.value)} disabled={busy}><option value="3600">1 小时</option><option value="86400">1 天</option><option value="604800">7 天</option><option value="2592000">30 天</option><option value="forever">长期有效</option></select></div>}
      <p className="share-note"><ShieldCheck size={16} /><span>持有链接的人无需登录即可预览和下载这个文件。你可以随时取消分享；覆盖或删除文件后，原链接也会失效。</span></p>
      {error && <p className="form-error" role="alert"><AlertCircle size={14} />{error}</p>}
    </div>
    <div className="modal-footer share-footer">{share ? <button className="text-button" disabled={busy} onClick={revoke}>{busy ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}取消分享</button> : <span />}
      <div><button className="button" disabled={busy} onClick={onClose}>关闭</button>{!share && <button className="button dark" disabled={busy || loading} onClick={create}>{busy ? <LoaderCircle size={15} className="spin" /> : <Share2 size={15} />}创建分享链接</button>}</div>
    </div>
  </Modal>
}

export { SharedFile } from './public-sharing'
