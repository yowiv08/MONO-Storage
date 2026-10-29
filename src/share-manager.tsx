import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUpRight, Check, Copy, File, Link2, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { api, bucketPath, type Bucket } from './api'
import { Modal } from './components'
import { baseName, formatBytes, formatDate } from './format'

export type ManagedShare = {
  id: string
  url: string
  createdAt: string
  expiresAt: string | null
  bucket: string
  key: string
  size: number
  contentType: string
  uploaded: string
}

type ShareListing = { shares: ManagedShare[]; cursor: string | null; truncated: boolean }
export type ShareManagerProps = { buckets: Bucket[]; notify: (message: string) => void; onOpenFile: (bucket: string, key: string) => void }

function shareUrl(share: ManagedShare) {
  const url = new URL(share.url, location.origin)
  return url.origin === location.origin ? url.href : new URL(`/s/${encodeURIComponent(share.id)}`, location.origin).href
}

export function ShareManager({ buckets, notify, onOpenFile }: ShareManagerProps) {
  const [listing, setListing] = useState<ShareListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [search, setSearch] = useState('')
  const [copied, setCopied] = useState('')
  const [revision, setRevision] = useState(0)
  const [cancelShare, setCancelShare] = useState<ManagedShare | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const generation = useRef(0)
  const pageController = useRef<AbortController | null>(null)
  const pageBusy = useRef(false)
  const seenCursors = useRef(new Set<string>())

  function refresh() { generation.current++; pageController.current?.abort(); setLoading(true); setListing(null); setError(''); setMoreError(''); setRevision(value => value + 1) }

  useEffect(() => {
    const requestGeneration = ++generation.current
    const controller = new AbortController()
    pageController.current?.abort(); pageBusy.current = false
    setLoading(true); setLoadingMore(false); setError(''); setMoreError(''); setListing(null)
    seenCursors.current = new Set()
    api<ShareListing>('/api/shares', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || generation.current !== requestGeneration) return
      if (result.truncated && !result.cursor) throw new Error('分享列表分页无效，请刷新后重试。')
      if (result.cursor) seenCursors.current.add(result.cursor)
      setListing(result)
    }).catch(error => { if (!controller.signal.aborted && generation.current === requestGeneration) setError(error instanceof Error ? error.message : '暂时无法读取分享链接。') }).finally(() => { if (!controller.signal.aborted && generation.current === requestGeneration) setLoading(false) })
    return () => { controller.abort(); pageController.current?.abort() }
  }, [revision])

  async function loadMore() {
    if (!listing?.truncated || !listing.cursor || loading || pageBusy.current) return
    const requestGeneration = generation.current
    const controller = new AbortController()
    pageController.current = controller; pageBusy.current = true
    setLoadingMore(true); setMoreError('')
    try {
      const result = await api<ShareListing>(`/api/shares?${new URLSearchParams({ cursor: listing.cursor })}`, { signal: controller.signal })
      if (controller.signal.aborted || generation.current !== requestGeneration) return
      if (result.truncated && (!result.cursor || seenCursors.current.has(result.cursor))) throw new Error('分享列表分页未继续前进，请刷新后重试。')
      if (result.cursor) seenCursors.current.add(result.cursor)
      setListing(current => current ? { ...result, shares: Array.from(new Map([...current.shares, ...result.shares].map(share => [share.id, share])).values()) } : result)
    } catch (error) { if (!controller.signal.aborted && generation.current === requestGeneration) setMoreError(error instanceof Error ? error.message : '暂时无法读取更多分享。') }
    finally {
      if (pageController.current === controller) { pageBusy.current = false; pageController.current = null }
      if (!controller.signal.aborted && generation.current === requestGeneration) setLoadingMore(false)
    }
  }

  const copyLink = useCallback(async (share: ManagedShare) => {
    try { await navigator.clipboard.writeText(shareUrl(share)); setCopied(share.id); notify('分享链接已复制') }
    catch { notify('请打开分享页面后复制地址。') }
  }, [notify])

  async function confirmCancel() {
    if (!cancelShare || cancelBusy) return
    setCancelBusy(true); setCancelError('')
    const target = cancelShare
    try {
      await api(`${bucketPath(target.bucket, 'shares')}?${new URLSearchParams({ key: target.key })}`, { method: 'DELETE' })
      setListing(current => current ? { ...current, shares: current.shares.filter(share => share.bucket !== target.bucket || share.key !== target.key) } : current)
      setCancelShare(null); notify('分享已取消，链接停止访问')
    } catch (error) { setCancelError(error instanceof Error ? error.message : '取消分享失败，请稍后重试。') }
    finally { setCancelBusy(false) }
  }

  const query = search.trim().toLocaleLowerCase()
  const visible = (listing?.shares || []).filter(share => !query || `${share.key} ${share.bucket} ${share.id}`.toLocaleLowerCase().includes(query))

  return <div className="share-manager-page">
    <div className="page-title-row"><div><div className="eyebrow">SHARED FILES</div><h1>分享链接</h1><p className="page-description">查看有效分享，复制链接或取消文件分享。</p></div><button className="button" type="button" disabled={loading || loadingMore || cancelBusy} onClick={refresh}><RefreshCw size={16} className={loading ? 'spin' : ''} />刷新</button></div>
    <section className="share-manager-card">
      <div className="share-manager-toolbar"><label className="share-manager-search"><Search size={16} /><input aria-label="搜索已读取的分享链接" value={search} placeholder="搜索已读取的文件、路径或存储桶" onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" type="button" aria-label="清除分享搜索" onClick={() => setSearch('')}><X size={15} /></button>}</label><span>搜索当前已读取的分享；加载更多可继续查找。</span></div>
      {error ? <div className="share-manager-error"><p className="form-error" role="alert"><AlertCircle size={17} />{error}</p><button className="button" type="button" onClick={refresh}><RefreshCw size={15} />重新读取</button></div> : loading ? <div className="share-manager-empty" role="status"><LoaderCircle size={24} className="spin" /><p>正在读取有效分享…</p></div> : <>
        {!visible.length ? <div className="share-manager-empty"><Link2 size={31} /><h3>{query ? '已读取的分享中没有匹配项' : listing?.truncated ? '这页暂时没有有效分享' : '还没有有效的分享链接'}</h3><p>{query ? '可以调整搜索，或加载更多分享后继续查找。' : listing?.truncated ? '继续加载，查看后续的分享记录。' : '在文件的“更多”菜单或预览窗口中创建分享。'}</p></div> : <div className="share-manager-list">{visible.map(share => <article className="share-manager-item" key={share.id}>
          <div className="share-manager-file"><span className="share-manager-file-icon"><File size={22} strokeWidth={1.5} /></span><div><button className="share-manager-file-name" type="button" title={share.key} onClick={() => onOpenFile(share.bucket, share.key)}>{baseName(share.key)}<ArrowUpRight size={14} /></button><p className="share-manager-path">{share.key}</p><div className="share-manager-meta"><span title={buckets.find(bucket => bucket.name === share.bucket)?.description || share.bucket}>{share.bucket}</span><span>{formatBytes(share.size)}</span><span>{share.contentType}</span></div></div></div>
          <div className="share-manager-link"><a href={shareUrl(share)} target="_blank" rel="noreferrer">{shareUrl(share)}</a><button className="icon-button" type="button" aria-label={`复制 ${baseName(share.key)} 的分享链接`} onClick={() => copyLink(share)}>{copied === share.id ? <Check size={16} /> : <Copy size={16} />}</button></div>
          <div className="share-manager-item-footer"><div><span>{share.expiresAt ? `有效至 ${formatDate(share.expiresAt, true)}` : '长期有效'}</span><span>创建于 {formatDate(share.createdAt, true)}</span></div><div className="share-manager-actions"><a className="text-button" href={shareUrl(share)} target="_blank" rel="noreferrer">打开分享<ArrowUpRight size={14} /></a><button className="text-button share-manager-cancel" type="button" disabled={cancelBusy || loadingMore} onClick={() => { setCancelShare(share); setCancelError('') }}>取消分享</button></div></div>
        </article>)}</div>}
        {moreError && <p className="share-manager-page-error form-error" role="alert"><AlertCircle size={16} />{moreError}</p>}
        <div className="share-manager-footer"><span>{listing?.truncated ? '还有更多分享记录' : '已读取全部有效分享'}</span>{listing?.truncated && <button className="button" type="button" disabled={loadingMore || cancelBusy} onClick={loadMore}>{loadingMore ? <LoaderCircle size={15} className="spin" /> : <ArrowDown size={15} />}{loadingMore ? '正在加载' : moreError ? '重试加载更多' : '加载更多'}</button>}</div>
      </>}
    </section>
    {cancelShare && <Modal title="取消文件分享" subtitle="取消后，持有链接的人无法继续访问这个文件。" onClose={() => { if (!cancelBusy) setCancelShare(null) }} className="share-manager-cancel-dialog"><div className="modal-content"><strong>{baseName(cancelShare.key)}</strong><p className="share-manager-confirm-path">{cancelShare.bucket}/{cancelShare.key}</p><p className="share-manager-confirm-note">文件会继续保存在存储桶中。</p>{cancelError && <p className="form-error" role="alert"><AlertCircle size={16} />{cancelError}</p>}</div><div className="modal-footer"><button className="button" type="button" disabled={cancelBusy} onClick={() => setCancelShare(null)}>保留分享</button><button className="button dark" type="button" disabled={cancelBusy} onClick={confirmCancel}>{cancelBusy ? <LoaderCircle size={16} className="spin" /> : <X size={16} />}确认取消分享</button></div></Modal>}
  </div>
}
