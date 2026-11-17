import { useEffect, useState } from 'react'
import { AlertCircle, ArrowUpRight, Check, Copy, Download, Link2, LoaderCircle, Share2, ShieldCheck, X } from 'lucide-react'
import { api, bucketPath, type StoredObject } from './api'
import { FileGlyph, Modal } from './common-components'
import { baseName, formatBytes, formatDate } from './format'
import { parseShareLink } from './share-link'
import { ThemeToggle } from './theme'

type ShareLink = { id: string; url: string; createdAt: string; expiresAt: string | null; followUpdates: boolean }
type PublicFile = { object: StoredObject; expiresAt: string | null; previewUrl: string; downloadUrl: string }

export function ShareDialog({ bucket, object, onClose, notify }: { bucket: string; object: StoredObject; onClose: () => void; notify: (message: string) => void }) {
  const [share, setShare] = useState<ShareLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expiresIn, setExpiresIn] = useState('604800')
  const [followUpdates, setFollowUpdates] = useState(false)
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
      setShare(await api<ShareLink>(bucketPath(bucket, 'shares'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: object.key, expiresIn: expiresIn === 'forever' ? null : Number(expiresIn), followUpdates }) }))
      setCopied(false)
    } catch (error) { setError(error instanceof Error ? error.message : '创建分享失败') }
    finally { setBusy(false) }
  }
  async function enableUpdates() {
    if (!share) return
    setBusy(true); setError('')
    try {
      setShare(await api<ShareLink>(bucketPath(bucket, 'shares'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: object.key, id: share.id, followUpdates: true }) }))
      notify('已开启跟随更新，原链接保持不变')
    } catch (error) { setError(error instanceof Error ? error.message : '更新分享失败') }
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
        <p className="share-note">{share.followUpdates ? '跟随更新：文件更新后，原链接继续提供最新内容。' : '当前版本：文件更新后，原链接失效。'}</p>
        {!share.followUpdates && <div className="share-mode-change"><p className="share-note">开启跟随更新后，持有原链接的人也能访问这个文件以后更新的内容。</p><button className="text-button" type="button" disabled={busy} onClick={enableUpdates}>保持链接并跟随更新<ArrowUpRight size={14} /></button></div>}
      </> : <><div className="share-expiration"><label className="field-label" htmlFor="share-expiration">链接有效期</label><select id="share-expiration" className="text-input" value={expiresIn} onChange={event => setExpiresIn(event.target.value)} disabled={busy}><option value="3600">1 小时</option><option value="86400">1 天</option><option value="604800">7 天</option><option value="2592000">30 天</option><option value="forever">长期有效</option></select></div>
        <div className="share-expiration"><label className="field-label" htmlFor="share-update-mode">文件更新后</label><select id="share-update-mode" className="text-input" value={followUpdates ? 'latest' : 'current'} onChange={event => setFollowUpdates(event.target.value === 'latest')} disabled={busy}><option value="current">使链接失效，仅分享当前版本</option><option value="latest">保持链接，分享最新内容</option></select></div>
        {followUpdates && <p className="share-note">持有链接的人也能访问这个文件以后更新的内容，适合持续追加的文本和日志。</p>}
      </>}
      <p className="share-note"><ShieldCheck size={16} /><span>有效期内可重复预览和下载，下载次数不限。取消分享、链接到期或在此处删除文件后，链接停止访问。</span></p>
      {error && <p className="form-error" role="alert"><AlertCircle size={14} />{error}</p>}
    </div>
    <div className="modal-footer share-footer">{share ? <button className="text-button" disabled={busy} onClick={revoke}>{busy ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}取消分享</button> : <span />}
      <div><button className="button" disabled={busy} onClick={onClose}>关闭</button>{!share && <button className="button dark" disabled={busy || loading} onClick={create}>{busy ? <LoaderCircle size={15} className="spin" /> : <Share2 size={15} />}创建分享链接</button>}</div>
    </div>
  </Modal>
}

export { SharedFile } from './public-sharing'
