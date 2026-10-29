import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpRight, Bell, Box, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CloudUpload, Code2, Copy, Database, File, Folder, FolderPlus, HardDrive, KeyRound, LayoutGrid, List, LoaderCircle, LockKeyhole, LogOut, Menu, MoreHorizontal, Plus, RefreshCw, Search, Settings2, Share2, Trash2, Upload, X, AlertCircle } from 'lucide-react'
import { api, bucketPath, objectUrl, StorageError, uploadFile, type Bucket, type Listing, type SessionState, type StoredObject } from './api'
import { ApiGuide, FileGlyph, Login, Modal, Toast } from './components'
import { baseName, fileKind, formatBytes, formatDate, typeLabel } from './format'
import { ShareDialog, SharedFile } from './sharing'
import { FileViewer, type FileViewTab } from './file-viewer'
import { FileActionsMenu } from './file-actions-menu'
import { ThemeToggle } from './theme'
import { SettingsPage } from './settings'
import { TokenManager } from './token-manager'
import { consolePages, NavigationMenu, settingsPage, workspacePages, type ConsolePage } from './navigation-menu'
import { useBucketStats } from './storage-stats'
import { ShareManager } from './share-manager'
import { deleteSelectedFiles, fetchFileArchive } from './batch-api'
import { archiveSelectionError, selectedBatchFiles } from './batch-files'

type Entry = { key: string; folder: boolean; object?: StoredObject }
type UploadItem = { id: string; file: File; key: string; loaded: number; state: 'waiting' | 'uploading' | 'done' | 'error' | 'cancelled'; error?: string }
type Sort = 'name' | 'newest' | 'size'
type RowMenuState = { key: string; anchor: HTMLButtonElement } | null

export default function App() {
  return <StorageConsole />
}

function StorageConsole() {
  const [session, setSession] = useState<SessionState | null>(null)
  const [initialError, setInitialError] = useState('')
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [bucket, setBucket] = useState('')
  const [page, setPage] = useState<ConsolePage>('objects')
  const [prefix, setPrefix] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState('')
  const [revision, setRevision] = useState(0)
  const [statsRevision, setStatsRevision] = useState(0)
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState<Sort>('name')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [preview, setPreview] = useState<StoredObject | null>(null)
  const [previewTab, setPreviewTab] = useState<FileViewTab>('preview')
  const [shareObject, setShareObject] = useState<StoredObject | null>(null)
  const [folderModal, setFolderModal] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [deleteEntries, setDeleteEntries] = useState<Entry[]>([])
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteBucket, setDeleteBucket] = useState('')
  const [deleteCompleted, setDeleteCompleted] = useState(0)
  const [deleteTotal, setDeleteTotal] = useState(0)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadRunning, setUploadRunning] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [uploadPrefix, setUploadPrefix] = useState('')
  const [uploadBucket, setUploadBucket] = useState('')
  const [dragging, setDragging] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null)
  const [navigationAnchor, setNavigationAnchor] = useState<HTMLButtonElement | null>(null)
  const navigationMenuId = useId()
  const navigationTriggerRef = useRef<HTMLButtonElement>(null)
  const [help, setHelp] = useState(false)
  const [fileTokenTarget, setFileTokenTarget] = useState<{ bucket: string; object: StoredObject } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const controllers = useRef<Map<string, AbortController>>(new Map())
  const listingIdentity = useRef('')
  const operationLock = useRef(false)
  const archiveController = useRef<AbortController | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)

  const notify = useCallback((message: string) => setToast(message), [])
  const refresh = () => { setRevision(value => value + 1); setStatsRevision(value => value + 1) }
  const stats = useBucketStats(bucket, prefix, statsRevision, Boolean(session?.authenticated && location.pathname !== '/'))
  const loadSession = useCallback(() => {
    setInitialError('')
    api<SessionState>('/api/session').then(setSession).catch(error => setInitialError(error.message))
  }, [])

  useEffect(loadSession, [loadSession])
  useEffect(() => {
    document.title = location.pathname === '/' && session?.configured ? 'MONO · 文件分享' : session?.displayName ? `${session.displayName} · 对象存储` : 'MONO · 对象存储'
  }, [session?.displayName, session?.configured])
  useEffect(() => {
    const unauthorized = () => { archiveController.current?.abort(); setSession(current => current ? { ...current, authenticated: false } : current); setPreview(null); setShareObject(null); setFileTokenTarget(null); setNavigationAnchor(null); setSelection(new Set()); setBatchMode(false) }
    window.addEventListener('mono:unauthorized', unauthorized)
    return () => window.removeEventListener('mono:unauthorized', unauthorized)
  }, [])
  useEffect(() => {
    if (!session?.authenticated || location.pathname === '/') return
    api<{ buckets: Bucket[] }>('/api/buckets').then(result => {
      setBuckets(result.buckets)
      setBucket(current => result.buckets.some(item => item.name === current) ? current : result.buckets[0]?.name || '')
    }).catch(error => setInitialError(error.message))
  }, [session])
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 280); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    if (!bucket || !session?.authenticated || location.pathname === '/') return
    const controller = new AbortController()
    const identity = `${bucket}:${prefix}:${query}:${revision}`
    listingIdentity.current = identity
    setLoading(true); setListError(''); setSelection(new Set()); setArchiveError('')
    const params = new URLSearchParams({ prefix: prefix + query, limit: '100' })
    if (query) params.set('recursive', 'true')
    api<Listing>(`${bucketPath(bucket, 'objects')}?${params}`, { signal: controller.signal }).then(result => { if (listingIdentity.current === identity) setListing(result) }).catch(error => { if (error.name !== 'AbortError') setListError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [bucket, prefix, query, revision, session?.authenticated])
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (uploadRunning || archiveBusy || deleteBusy) event.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [uploadRunning, archiveBusy, deleteBusy])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; archiveController.current?.abort() }
  }, [])

  const entries = useMemo<Entry[]>(() => {
    if (!listing) return []
    const folders: Entry[] = listing.folders.map(key => ({ key, folder: true }))
    const files: Entry[] = listing.objects.filter(object => filter === 'all' || fileKind(object.key, object.contentType) === filter).map(object => ({ key: object.key, folder: false, object }))
    files.sort((a, b) => sort === 'newest' ? new Date(b.object!.uploaded).getTime() - new Date(a.object!.uploaded).getTime() : sort === 'size' ? b.object!.size - a.object!.size : a.key.localeCompare(b.key, 'zh-CN', { numeric: true }))
    return [...(filter === 'all' ? folders.sort((a, b) => a.key.localeCompare(b.key, 'zh-CN')) : []), ...files]
  }, [listing, filter, sort])
  const fileEntries = entries.filter(entry => !entry.folder)
  const listingReady = Boolean(listing) && !loading && !listError && listing?.prefix === prefix + query && search.trim() === query && listingIdentity.current === `${bucket}:${prefix}:${query}:${revision}`
  const batchBusy = archiveBusy || deleteBusy
  const selectedFiles = listingReady ? selectedBatchFiles(listing?.objects || [], selection, new Set(fileEntries.map(entry => entry.key))) : []
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0)
  const archiveLimitError = selectedFiles.length ? archiveSelectionError(selectedFiles) : ''
  const currentBucket = buckets.find(item => item.name === bucket)
  const allSelected = listingReady && fileEntries.length > 0 && fileEntries.every(entry => selection.has(entry.key))
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = !allSelected && selectedFiles.length > 0 }, [allSelected, selectedFiles.length, view])
  const uploadCount = uploads.filter(item => item.state === 'done').length

  function navigate(path: string) { if (operationLock.current) return; setPrefix(path); setSearch(''); setQuery(''); setPreview(null); setSelection(new Set()); setBatchMode(false); setArchiveError(''); setFilter('all'); setRowMenu(null) }
  function openTopbarPage(next: ConsolePage) {
    if (operationLock.current) return
    setPage(next); setSidebarOpen(false); setPreview(null); setShareObject(null); setFileTokenTarget(null); setRowMenu(null); setNavigationAnchor(null); setSelection(new Set()); setBatchMode(false); setArchiveError('')
    if (next === 'objects') navigate('')
  }
  function toggleNavigationMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (operationLock.current) return
    const anchor = event.currentTarget
    setRowMenu(null)
    setNavigationAnchor(current => current === anchor ? null : anchor)
  }
  function changeBucket(name: string) { if (operationLock.current) return; setBucket(name); navigate(''); setListing(null); setRevision(value => value + 1); setPage('objects'); setSidebarOpen(false); setNavigationAnchor(null) }
  function toggleSelection(key: string) { if (operationLock.current || !listingReady) return; setBatchMode(true); setArchiveError(''); setSelection(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function selectLoadedFiles(invert = false) { if (operationLock.current || !listingReady) return; setBatchMode(true); setArchiveError(''); setSelection(current => new Set(fileEntries.filter(entry => !invert || !current.has(entry.key)).map(entry => entry.key))) }
  function clearSelection(exit = false) { if (operationLock.current) return; setSelection(new Set()); setArchiveError(''); if (exit) setBatchMode(false) }
  function changeSearch(value: string) { if (operationLock.current) return; setSearch(value); setSelection(new Set()); setArchiveError('') }
  function changeFilter(value: string) { if (operationLock.current) return; setFilter(value); setSelection(new Set()); setArchiveError('') }
  function showFile(object: StoredObject, tab: FileViewTab = 'preview') { if (operationLock.current) return; setPreviewTab(tab); setPreview(object); setRowMenu(null) }
  function openFileTokens(object: StoredObject) { if (operationLock.current) return; setPreview(null); setShareObject(null); setRowMenu(null); setNavigationAnchor(null); setFileTokenTarget({ bucket, object }) }
  function openEntry(entry: Entry) { if (operationLock.current) return; if (entry.folder) navigate(entry.key); else if (batchMode) toggleSelection(entry.key); else showFile(entry.object!) }
  function openDelete(items: Entry[]) { if (operationLock.current || !items.length) return; setDeleteEntries([...items]); setDeleteBucket(bucket); setDeleteError(''); setDeleteCompleted(0); setDeleteTotal(items.length); setRowMenu(null) }
  function toggleRowMenu(event: ReactMouseEvent<HTMLButtonElement>, entry: Entry) {
    event.stopPropagation()
    if (operationLock.current) return
    if (rowMenu?.key === entry.key) { setRowMenu(null); return }
    setRowMenu({ key: entry.key, anchor: event.currentTarget })
  }

  async function loadMore() {
    if (!listing?.cursor || loadingMore || operationLock.current) return
    const identity = listingIdentity.current
    setLoadingMore(true)
    const params = new URLSearchParams({ prefix: prefix + query, limit: '100', cursor: listing.cursor })
    if (query) params.set('recursive', 'true')
    try {
      const next = await api<Listing>(`${bucketPath(bucket, 'objects')}?${params}`)
      if (identity === listingIdentity.current) setListing(current => current ? { ...next, objects: [...current.objects, ...next.objects], folders: [...new Set([...current.folders, ...next.folders])] } : next)
    } catch (error) { notify(error instanceof Error ? error.message : '加载失败') }
    finally { setLoadingMore(false) }
  }

  function addFiles(files: File[]) {
    if (!files.length || operationLock.current) return
    const targetPrefix = uploadOpen ? uploadPrefix : prefix
    const next = files.map(file => ({ id: crypto.randomUUID(), file, key: targetPrefix + (file.webkitRelativePath || file.name), loaded: 0, state: 'waiting' as const }))
    setUploads(current => uploadOpen ? [...current, ...next] : next)
    if (!uploadOpen) { setUploadPrefix(prefix); setUploadBucket(bucket); setOverwrite(false) }
    setUploadOpen(true)
  }

  const updateUpload = (id: string, update: Partial<UploadItem>) => setUploads(current => current.map(item => item.id === id ? { ...item, ...update } : item))
  async function beginUpload() {
    if (uploadRunning || operationLock.current) return
    const queue = uploads.filter(item => item.state === 'waiting' || item.state === 'error' || item.state === 'cancelled')
    if (!queue.length) return
    setUploadRunning(true)
    let done = 0
    for (const item of queue) {
      const controller = new AbortController()
      controllers.current.set(item.id, controller)
      updateUpload(item.id, { state: 'uploading', loaded: 0, error: undefined })
      try {
        await uploadFile(uploadBucket, item.key, item.file, overwrite, controller.signal, loaded => updateUpload(item.id, { loaded }))
        updateUpload(item.id, { state: 'done', loaded: item.file.size }); done++
      } catch (error) {
        updateUpload(item.id, { state: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error', error: error instanceof Error ? error.message : '上传失败' })
      } finally { controllers.current.delete(item.id) }
    }
    setUploadRunning(false)
    if (done) { refresh(); notify(`${done} 个文件已存入 ${uploadBucket}`) }
  }

  async function createFolder(event: FormEvent) {
    event.preventDefault(); if (operationLock.current) return; setFolderError('')
    const name = folderName.trim()
    if (!name || name.includes('/') || name === '.' || name === '..') { setFolderError('请输入文件夹名称，不要包含 /。'); return }
    setFolderBusy(true)
    try { await api(bucketPath(bucket, 'folders'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: `${prefix}${name}/` }) }); setFolderModal(false); refresh(); notify('文件夹已创建') }
    catch (error) { setFolderError(error instanceof Error ? error.message : '创建失败') }
    finally { setFolderBusy(false) }
  }

  async function confirmDelete() {
    if (operationLock.current || uploadRunning || !deleteEntries.length) return
    operationLock.current = true
    setDeleteBusy(true); setDeleteError('')
    const targetBucket = deleteBucket
    let remaining = [...deleteEntries]
    let completed = deleteCompleted
    const recordDeleted = (keys: string[]) => {
      const removed = new Set(keys)
      remaining = remaining.filter(entry => !removed.has(entry.key))
      completed += keys.length
      if (!mounted.current) return
      if (remaining.length) setDeleteEntries(remaining)
      setDeleteCompleted(completed)
      setSelection(current => new Set([...current].filter(key => !removed.has(key))))
      setListing(current => current ? { ...current, objects: current.objects.filter(file => !removed.has(file.key)), folders: current.folders.filter(key => !removed.has(key)) } : current)
    }
    try {
      const keys = remaining.filter(entry => !entry.folder).map(entry => entry.key)
      await deleteSelectedFiles(targetBucket, keys, recordDeleted, () => mounted.current)
      for (const entry of remaining.filter(entry => entry.folder)) {
        if (!mounted.current) throw new DOMException('删除操作已停止', 'AbortError')
        await api(`${bucketPath(targetBucket, 'folders')}?${new URLSearchParams({ key: entry.key })}`, { method: 'DELETE' })
        recordDeleted([entry.key])
      }
      if (mounted.current) { setDeleteEntries([]); setSelection(new Set()); notify(`已删除 ${completed} 个对象`); refresh() }
    } catch (error) {
      if (mounted.current) {
        setDeleteEntries(remaining)
        setDeleteError(`${completed ? `已确认删除 ${completed} / ${deleteTotal} 个对象；还有 ${remaining.length} 个未完成。` : ''}${error instanceof Error ? error.message : '删除失败'} 请核对后重试。`)
        if (completed > deleteCompleted) setStatsRevision(value => value + 1)
      }
    } finally { operationLock.current = false; if (mounted.current) setDeleteBusy(false) }
  }

  async function downloadSelection() {
    if (operationLock.current || uploadRunning || !selectedFiles.length) return
    const files = selectedFiles.map(file => ({ ...file }))
    const limitError = archiveSelectionError(files)
    if (limitError) { setArchiveError(limitError); return }
    const controller = new AbortController()
    archiveController.current = controller
    operationLock.current = true
    setArchiveBusy(true); setArchiveError(''); setRowMenu(null); setNavigationAnchor(null)
    try {
      const blob = await fetchFileArchive(bucket, files, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `MONO-${bucket}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
      document.body.append(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      notify(`${files.length} 个文件已打包，下载已开始`)
    } catch (error) {
      if (mounted.current) {
        if (controller.signal.aborted) notify('打包下载已取消')
        else setArchiveError(error instanceof Error ? error.message : '打包下载失败，请重试。')
      }
    } finally {
      if (archiveController.current === controller) archiveController.current = null
      operationLock.current = false
      if (mounted.current) setArchiveBusy(false)
    }
  }

  async function copySelectionPaths() {
    if (operationLock.current || !selectedFiles.length) return
    const keys = selectedFiles.map(file => file.key)
    try { await navigator.clipboard.writeText(keys.join('\n')); notify(`${keys.length} 个文件路径已复制，每行一个`) }
    catch { setArchiveError('复制失败，请允许剪贴板访问后重试。') }
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }

  if (initialError) return <div className="startup-error"><ThemeToggle floating /><Box size={36} strokeWidth={1.2} /><h1>暂时无法连接存储空间</h1><p>{initialError}</p><button className="button dark" onClick={loadSession}><RefreshCw size={15} />重试连接</button></div>
  if (!session) return <div className="startup-loading"><Box size={38} strokeWidth={1.2} /><span>MONO</span><LoaderCircle size={18} className="spin" /></div>
  if (location.pathname === '/') return <SharedFile />
  if (session.adminPath && location.pathname !== session.adminPath) return <div className="not-found-page"><h1>404</h1><p>页面不存在</p></div>
  if (!session.authenticated) return <><ThemeToggle floating /><Login onLogin={loadSession} /></>

  const rowActions = (entry: Entry) => <div className="row-actions"><button type="button" className="icon-button row-more" disabled={batchBusy} aria-label={`${baseName(entry.key)} 的更多操作`} aria-haspopup="menu" aria-expanded={rowMenu?.key === entry.key} onClick={event => toggleRowMenu(event, entry)}><MoreHorizontal size={18} /></button>{rowMenu?.key === entry.key && <FileActionsMenu anchor={rowMenu.anchor} onClose={() => setRowMenu(null)}>{entry.object && <><button role="menuitem" onClick={() => showFile(entry.object!)}><ArrowUpRight size={14} />预览</button><button role="menuitem" onClick={() => showFile(entry.object!, 'info')}><File size={14} />文件信息</button><a role="menuitem" href={objectUrl(bucket, entry.key, true)} download onClick={() => setRowMenu(null)}><ArrowDownToLine size={14} />下载</a><button role="menuitem" onClick={() => { setShareObject(entry.object!); setRowMenu(null) }}><Share2 size={14} />分享文件</button><button role="menuitem" onClick={() => openFileTokens(entry.object!)}><KeyRound size={14} />文件 API Token</button><button role="menuitem" onClick={async () => { try { await navigator.clipboard.writeText(entry.key); notify('对象路径已复制') } catch { notify('请手动复制对象路径') } setRowMenu(null) }}><Copy size={14} />复制路径</button></>}<button role="menuitem" className="delete-menu" onClick={() => openDelete([entry])}><Trash2 size={14} />{entry.folder ? '删除空文件夹' : '删除'}</button></FileActionsMenu>}</div>

  return <div className="app-shell">
    {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#" onClick={event => { event.preventDefault(); if (operationLock.current) return; setPage('objects'); navigate('') }}><span className="brand-symbol"><Box size={23} strokeWidth={1.5} /></span><span className="brand-word">MONO<span>OBJECT STORAGE</span></span><button className="mobile-sidebar-close icon-button" onClick={event => { event.preventDefault(); event.stopPropagation(); setSidebarOpen(false) }} aria-label="关闭导航"><X size={18} /></button></a>
      <div className="workspace-switch"><span className="workspace-avatar">M</span><div><strong>{session.displayName}</strong><span>个人工作空间</span></div><span className="workspace-lock"><LockKeyhole size={13} /></span></div>
      <div className="sidebar-section-label">工作空间</div>
      <nav className="primary-nav" aria-label="工作空间">{workspacePages.map(({ id, label, Icon }) => <button key={id} className={page === id ? 'active' : ''} disabled={batchBusy} aria-current={page === id ? 'page' : undefined} onClick={() => openTopbarPage(id)}><Icon size={18} strokeWidth={1.6} />{label}{id === 'objects' && <span className="nav-count">{buckets.length}</span>}{id === 'api' && <ArrowUpRight className="nav-arrow" size={14} />}</button>)}</nav>
      <div className="sidebar-buckets"><div className="sidebar-section-label">存储桶<span>{String(buckets.length).padStart(2, '0')}</span></div>{buckets.map(item => <button key={item.name} className={`bucket-nav ${bucket === item.name ? 'active' : ''}`} disabled={batchBusy} onClick={() => changeBucket(item.name)}><span className="bucket-dot" /><span>{item.name}</span>{bucket === item.name && <ChevronRight size={13} />}</button>)}</div>
      <div className="sidebar-bottom"><nav className="sidebar-settings-nav" aria-label="设置入口"><button type="button" className={page === settingsPage.id ? 'active' : ''} disabled={batchBusy} aria-current={page === settingsPage.id ? 'page' : undefined} onClick={() => openTopbarPage(settingsPage.id)}><settingsPage.Icon size={18} strokeWidth={1.6} />{settingsPage.label}</button></nav><div className="profile"><span className="profile-avatar">M</span><div><strong>存储管理员</strong><span>{session.local ? '本地工作空间' : '已安全登录'}</span></div><button className="icon-button" aria-label="退出登录" disabled={batchBusy} onClick={async () => { await api('/api/session', { method: 'DELETE' }); setSession(current => current ? { ...current, authenticated: false } : current) }}><LogOut size={16} /></button></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
          <nav className="topbar-breadcrumb" aria-label="页面导航">
            {page !== settingsPage.id && <><button type="button" className="topbar-workspace" disabled={batchBusy} title="选择菜单并跳转" aria-haspopup="menu" aria-expanded={navigationAnchor?.classList.contains('topbar-workspace') || false} aria-controls={navigationMenuId} onClick={toggleNavigationMenu}>工作空间</button><ChevronRight size={13} aria-hidden="true" /></>}
            <button type="button" ref={navigationTriggerRef} className="topbar-section" disabled={batchBusy} aria-current="page" title="选择菜单并跳转" aria-haspopup="menu" aria-expanded={navigationAnchor?.classList.contains('topbar-section') || false} aria-controls={navigationMenuId} onClick={toggleNavigationMenu}>{page === settingsPage.id && <settingsPage.Icon size={16} strokeWidth={1.6} aria-hidden="true" />}{consolePages.find(item => item.id === page)?.label}<ChevronDown size={13} aria-hidden="true" /></button>
          </nav>
        </div>
        <div className="topbar-right"><ThemeToggle /><span className="connection-pill"><span className="status-dot" />{session.local ? '本地存储' : 'R2 已连接'}</span><span className="topbar-divider" /><button type="button" className="icon-button topbar-help" aria-label="打开使用帮助" title="使用帮助" onClick={() => setHelp(true)}><CircleHelp size={18} strokeWidth={1.5} /></button><span className="topbar-avatar">M</span></div>
      </header>
      {navigationAnchor && <NavigationMenu anchor={navigationAnchor} page={page} buckets={buckets} bucket={bucket} id={navigationMenuId} selectionFocusTarget={navigationTriggerRef.current} onNavigate={openTopbarPage} onOpenBucket={changeBucket} onClose={() => setNavigationAnchor(null)} />}
      <main className="main-content">
      {page === 'api' ? <ApiGuide bucket={bucket} notify={notify} /> : page === 'shares' ? <ShareManager buckets={buckets} notify={notify} onOpenFile={async (name, key) => { changeBucket(name); try { const object = await api<StoredObject>(`${objectUrl(name, key)}&metadata=true`); showFile(object) } catch (error) { notify(error instanceof Error ? error.message : '无法打开文件') } }} /> : page === 'settings' ? <SettingsPage buckets={buckets} session={session} onSessionChange={setSession} onOpenBucket={changeBucket} notify={notify} /> : <>
        <div className="page-title-row"><div><div className="eyebrow">A PLACE FOR EVERYTHING</div><h1>对象存储<span className="title-dot">.</span></h1><p className="page-description">存放文件，保持简单。</p></div><button className="button dark upload-main" disabled={batchBusy} onClick={() => { if (uploadRunning || (uploadOpen && uploads.length)) setUploadOpen(true); else { setUploads([]); setUploadPrefix(prefix); setUploadBucket(bucket); setUploadOpen(true); setOverwrite(false) } }}><Plus size={17} strokeWidth={1.7} />上传文件</button></div>
        <div className="storage-summary"><div className="summary-item"><span className="summary-icon"><Database size={20} strokeWidth={1.4} /></span><div><span className="summary-label">当前存储桶</span><strong className="bucket-summary-name">{bucket || '—'}<span className="summary-inline-tag" title={session.local ? '本地存储' : 'Cloudflare R2'}>{session.local ? '本地' : 'R2'}</span></strong></div></div><div className="summary-item stats-summary"><span className="summary-icon"><File size={20} strokeWidth={1.4} /></span><div><span className="summary-label">{prefix ? '当前目录文件总数' : '桶内文件总数'}</span><strong>{stats?.pages ? stats.objectCount.toLocaleString('zh-CN') : stats?.complete ? 0 : '—'}<span className="summary-unit">个</span></strong>{!stats?.complete && <span className="stats-progress" role="status">{stats?.error ? '统计中断 · 已统计部分文件' : stats?.pages ? `统计中 · 已统计 ${stats.pages} 页` : '统计中…'}</span>}</div></div><div className="summary-item stats-summary"><span className="summary-icon"><HardDrive size={20} strokeWidth={1.4} /></span><div><span className="summary-label">{prefix ? '当前目录总大小' : '文件总大小'}</span><strong>{stats?.pages || stats?.complete ? formatBytes(stats.totalBytes) : '—'}</strong><span className="stats-progress">{stats?.error ? '未完成统计' : stats?.complete ? prefix ? '包含当前目录及子文件夹' : '包含所有子文件夹' : stats?.pages ? '已统计大小 · 继续统计中' : prefix ? '正在统计当前目录' : '正在统计整个存储桶'}</span>{stats?.error && <button className="stats-retry" type="button" aria-label={`重新统计：${stats.error}`} title={stats.error} onClick={() => setStatsRevision(value => value + 1)}><RefreshCw size={13} />重新统计</button>}</div></div><div className="summary-item summary-access"><span className="summary-icon"><LockKeyhole size={20} strokeWidth={1.4} /></span><div><span className="summary-label">访问权限</span><strong>私有<span className="summary-unit">安全访问</span></strong></div></div></div>
        <section className="objects-card" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)) }}>
          {dragging && <div className="drop-overlay"><CloudUpload size={42} strokeWidth={1.2} /><h3>松开，文件就到这里。</h3><p>{bucket}/{prefix}</p></div>}
          <div className="objects-body"><div className="objects-topline"><div className="object-location"><span className="bucket-header-icon"><Box size={18} strokeWidth={1.5} /></span><span>{bucket}</span><span className="tag storage-tag">标准存储</span></div><button className="text-button" disabled={batchBusy} onClick={() => openTopbarPage(settingsPage.id)}>{settingsPage.label}<ArrowUpRight size={13} /></button></div>
          <div className="file-toolbar"><div className="breadcrumb"><button disabled={batchBusy} onClick={() => navigate('')} className={!prefix ? 'current' : ''}><HardDrive size={14} />全部文件</button>{prefix.split('/').filter(Boolean).map((segment, index, all) => <span className="breadcrumb-part" key={index}><ChevronRight size={12} /><button disabled={batchBusy} className={index === all.length - 1 ? 'current' : ''} onClick={() => navigate(all.slice(0, index + 1).join('/') + '/')}>{segment}</button></span>)}</div><div className="file-toolbar-actions"><button type="button" className={`button small batch-toggle ${batchMode ? 'active' : ''}`} aria-pressed={batchMode} disabled={batchBusy || !listingReady || loadingMore} onClick={() => { if (batchMode) clearSelection(true); else { setBatchMode(true); setRowMenu(null) } }}><CheckCircle2 size={15} />{batchMode ? '完成批量操作' : '批量操作'}</button><button className="button small" disabled={batchBusy} onClick={() => { setFolderName(''); setFolderError(''); setFolderModal(true) }}><FolderPlus size={15} />新建文件夹</button><button className="icon-button" aria-label="刷新对象列表" disabled={loading || loadingMore || batchBusy} onClick={refresh}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div></div>
          <div className="filter-toolbar"><label className="search-input"><Search size={16} strokeWidth={1.6} /><input placeholder="按对象路径前缀搜索…" aria-label="搜索对象路径前缀" value={search} disabled={batchBusy} onChange={event => changeSearch(event.target.value)} />{search && <button aria-label="清除搜索" disabled={batchBusy} onClick={() => changeSearch('')}><X size={13} /></button>}</label><div className="filter-controls"><label className="select-control"><select aria-label="筛选文件类型" value={filter} disabled={batchBusy} onChange={event => changeFilter(event.target.value)}><option value="all">全部类型</option><option value="image">图片</option><option value="text">文本</option><option value="pdf">PDF</option><option value="video">视频</option><option value="audio">音频</option><option value="file">其他文件</option></select><ChevronDown size={13} /></label><div className="view-toggle"><button className={view === 'list' ? 'active' : ''} aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={16} /></button><button className={view === 'grid' ? 'active' : ''} aria-label="网格视图" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={15} /></button></div></div></div>
          {batchMode && <div className="batch-panel" aria-label="批量文件操作">
            <div className="batch-selection-controls"><span>仅选择当前已加载、符合筛选的文件</span><div><button type="button" className="text-button" disabled={batchBusy || loading || loadingMore || !fileEntries.length} onClick={() => selectLoadedFiles()}>全选已加载文件</button><button type="button" className="text-button" disabled={batchBusy || loading || loadingMore || !fileEntries.length} onClick={() => selectLoadedFiles(true)}>反选</button><button type="button" className="text-button" disabled={batchBusy || !selectedFiles.length} onClick={() => clearSelection()}>清空选择</button></div></div>
            <div className="selection-bar batch-selection-bar"><div className="batch-selection-summary" role="status"><CheckCircle2 size={17} /><strong>已选择 {selectedFiles.length} 个文件</strong><span>{formatBytes(selectedBytes)}</span></div><div className="batch-actions"><button type="button" className="button small" disabled={batchBusy || uploadRunning || loading || loadingMore || !selectedFiles.length || Boolean(archiveLimitError)} onClick={downloadSelection}>{archiveBusy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}{archiveBusy ? '正在打包…' : '打包下载'}</button><button type="button" className="button small" disabled={batchBusy || loading || loadingMore || !selectedFiles.length} onClick={copySelectionPaths}><Copy size={15} />复制路径</button><button type="button" className="button small batch-delete" disabled={batchBusy || uploadRunning || loading || loadingMore || !selectedFiles.length} onClick={() => openDelete(selectedFiles.map(object => ({ key: object.key, folder: false, object })))}><Trash2 size={15} />批量删除</button>{archiveBusy && <button type="button" className="text-button" onClick={() => archiveController.current?.abort()}>取消下载</button>}</div></div>
            <p className={archiveError || archiveLimitError ? 'batch-hint batch-error' : 'batch-hint'} role={archiveError || archiveLimitError ? 'alert' : undefined}>{archiveError || archiveLimitError || '打包下载保留目录结构，每次最多 500 个文件、总大小 512 MiB。'}</p>
          </div>}
          {listError ? <div className="empty-state"><AlertCircle size={34} strokeWidth={1.2} /><h3>文件暂时没有加载出来</h3><p>{listError}</p><button className="button" onClick={refresh}><RefreshCw size={14} />重新加载</button></div> : loading ? <div className="file-skeleton">{Array.from({ length: 6 }, (_, index) => <div key={index}><span /><span /><span /></div>)}</div> : !entries.length ? <div className="empty-state"><div className="empty-icon"><Box size={34} strokeWidth={1.2} /></div><h3>{query || filter !== 'all' ? '没有找到匹配的文件' : '这里，留给你的文件。'}</h3><p>{query ? '试试更短的路径前缀，或清除搜索条件。' : filter !== 'all' ? '这个目录没有该类型的文件。' : '上传第一份文件，或者直接将文件拖到这里。'}</p>{query || filter !== 'all' ? <button className="button" disabled={batchBusy} onClick={() => { changeSearch(''); changeFilter('all') }}>清除筛选</button> : <button className="button dark" disabled={batchBusy} onClick={() => inputRef.current?.click()}><Plus size={15} />上传文件</button>}</div> : view === 'list' ? <div className="table-scroll"><table className="object-table"><thead><tr><th className="checkbox-cell"><input ref={selectAllRef} type="checkbox" aria-label="选择当前显示的全部文件" title="选择当前已加载、符合筛选的全部文件" checked={allSelected} disabled={batchBusy || !listingReady || loadingMore || !fileEntries.length} onChange={() => { if (allSelected) clearSelection(); else selectLoadedFiles() }} /></th><th className="name-th"><button onClick={() => setSort('name')}>名称{sort === 'name' && <ArrowUp size={11} />}</button></th><th className="size-th"><button onClick={() => setSort('size')}>大小{sort === 'size' && <ArrowDown size={11} />}</button></th><th className="type-th">类型</th><th className="date-th"><button onClick={() => setSort('newest')}>上传时间{sort === 'newest' && <ArrowDown size={11} />}</button></th><th className="actions-th" /></tr></thead><tbody>{entries.map(entry => <tr key={entry.key} className={selection.has(entry.key) ? 'selected' : ''}><td className="checkbox-cell" onClick={event => event.stopPropagation()}>{!entry.folder ? <input type="checkbox" aria-label={`选择 ${baseName(entry.key)}`} disabled={batchBusy || !listingReady || loadingMore} checked={selection.has(entry.key)} onChange={() => toggleSelection(entry.key)} /> : <span className="folder-checkbox-space" />}</td><td className="name-cell"><button className="file-name-button" disabled={batchBusy} aria-pressed={batchMode && entry.object ? selection.has(entry.key) : undefined} onClick={event => { event.stopPropagation(); openEntry(entry) }}><span className={`file-icon ${entry.folder ? 'folder-icon' : ''}`}><FileGlyph folder={entry.folder} object={entry.object} /></span><span className="file-name-text"><strong>{query ? entry.key : baseName(entry.key)}</strong>{entry.object && <span>私有</span>}</span>{entry.folder && <ChevronRight className="folder-next" size={13} />}</button></td><td className="size-cell">{entry.object ? formatBytes(entry.object.size) : '—'}</td><td className="type-cell"><span className="file-type-tag">{entry.object ? typeLabel(entry.key, entry.object.contentType) : '文件夹'}</span></td><td className="date-cell">{entry.object ? formatDate(entry.object.uploaded) : '—'}</td><td className="actions-cell">{rowActions(entry)}</td></tr>)}</tbody></table></div> : <div className="object-grid">{entries.map(entry => <article className={`object-tile ${selection.has(entry.key) ? 'active' : ''}`} key={entry.key}><div className="tile-top">{entry.object ? <input type="checkbox" aria-label={`选择 ${baseName(entry.key)}`} disabled={batchBusy || !listingReady || loadingMore} checked={selection.has(entry.key)} onChange={() => toggleSelection(entry.key)} /> : <span />}{rowActions(entry)}</div><button className={`tile-preview ${entry.folder ? 'tile-folder' : ''}`} disabled={batchBusy} aria-pressed={batchMode && entry.object ? selection.has(entry.key) : undefined} onClick={() => openEntry(entry)}>{entry.object && fileKind(entry.key, entry.object.contentType) === 'image' ? <img src={objectUrl(bucket, entry.key)} alt={baseName(entry.key)} loading="lazy" /> : <FileGlyph folder={entry.folder} object={entry.object} size={40} />}</button><button className="tile-name" disabled={batchBusy} aria-pressed={batchMode && entry.object ? selection.has(entry.key) : undefined} onClick={() => openEntry(entry)} title={entry.key}>{baseName(entry.key)}</button><div className="tile-meta"><span>{entry.object ? formatBytes(entry.object.size) : '文件夹'}</span><span>{entry.object ? typeLabel(entry.key, entry.object.contentType) : <ChevronRight size={13} />}</span></div></article>)}</div>}
          <div className="list-footer"><span>{loading ? '正在读取存储桶…' : `${entries.length} 个项目${query ? ' · 按路径前缀匹配' : ''}${listing?.truncated ? ' · 还有更多对象' : ''}`}</span>{listing?.truncated && <button className="text-button" disabled={loadingMore || batchBusy} onClick={loadMore}>{loadingMore ? <LoaderCircle size={14} className="spin" /> : null}加载更多<ArrowDown size={13} /></button>}<span className="list-footer-hint">拖拽文件到此处上传</span></div>
          </div>
        </section><div className="page-footer"><span>MONO<span className="footer-separator">/</span>简单存储，自由访问。</span><button className="text-button" disabled={batchBusy} onClick={() => openTopbarPage('api')}>通过 API 连接你的应用<ArrowUpRight size={13} /></button></div>
      </>}
      </main>
    </div>
    <input type="file" multiple ref={inputRef} className="visually-hidden" onChange={onFileChange} aria-label="选择上传文件" />
    <input type="file" multiple ref={folderInputRef} className="visually-hidden" {...{ webkitdirectory: '' } as Record<string, string>} onChange={onFileChange} aria-label="选择上传文件夹" />
    {folderModal && <Modal title="新建文件夹" subtitle={`在 ${bucket}/${prefix} 中创建一个目录`} onClose={() => { if (!folderBusy) setFolderModal(false) }}><form onSubmit={createFolder}><div className="modal-content"><label className="field-label" htmlFor="folder-name">文件夹名称</label><input className="text-input" id="folder-name" autoFocus placeholder="例如 documents" value={folderName} onChange={event => setFolderName(event.target.value)} maxLength={200} required />{folderError && <p className="form-error"><AlertCircle size={14} />{folderError}</p>}<p className="input-hint">文件夹会显示在对象列表中，支持中文名称。</p></div><div className="modal-footer"><button type="button" className="button" onClick={() => setFolderModal(false)} disabled={folderBusy || batchBusy}>取消</button><button className="button dark" disabled={folderBusy || batchBusy}>{folderBusy ? <LoaderCircle size={15} className="spin" /> : <FolderPlus size={15} />}创建文件夹</button></div></form></Modal>}
    {deleteEntries.length > 0 && <Modal title={deleteCompleted ? `继续删除剩余 ${deleteEntries.length} 个对象？` : deleteEntries.length === 1 ? '删除这个对象？' : `删除 ${deleteEntries.length} 个对象？`} subtitle="删除后无法恢复，请确认这些文件不再需要。" onClose={() => { if (!deleteBusy) setDeleteEntries([]) }}><div className="modal-content"><p className="batch-delete-scope">存储桶：{deleteBucket}</p><div className="delete-file-list">{deleteEntries.slice(0, 5).map(entry => <div key={entry.key}><FileGlyph folder={entry.folder} object={entry.object} /><span>{entry.key}</span></div>)}{deleteEntries.length > 5 && <span className="muted">及另外 {deleteEntries.length - 5} 个对象</span>}</div>{deleteBusy && <p className="batch-delete-progress" role="status"><LoaderCircle size={15} className="spin" />正在删除 · 已完成 {deleteCompleted} / {deleteTotal}</p>}{deleteError && <p className="form-error" role="alert"><AlertCircle size={14} />{deleteError}</p>}</div><div className="modal-footer"><button className="button" onClick={() => setDeleteEntries([])} disabled={deleteBusy}>保留文件</button><button className="button dark" disabled={deleteBusy || archiveBusy || uploadRunning} onClick={confirmDelete}>{deleteBusy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}{deleteBusy ? '正在删除' : deleteError ? '确认重试删除' : '确认删除'}</button></div></Modal>}
    {uploadOpen && <Modal title="上传文件" subtitle="让每一份文件，都妥善存放。" onClose={() => setUploadOpen(false)} wide><div className="modal-content upload-content"><div className="upload-destination"><Box size={15} /><span>上传到</span><strong>{uploadBucket}/{uploadPrefix}</strong><span className="tag">私有</span></div><div className="upload-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)) }}><span className="upload-symbol"><Upload size={26} strokeWidth={1.3} /></span><h3>把文件拖到这里</h3><p>任意文件类型 · 支持多个文件与大文件分片上传</p><div><button className="button dark small" onClick={() => inputRef.current?.click()}><Plus size={14} />选择文件</button><button className="button small" onClick={() => folderInputRef.current?.click()}>选择文件夹</button></div></div>{uploads.length > 0 && <div className="upload-file-list">{uploads.map(item => <div className="upload-file" key={item.id}><span className="file-icon"><FileGlyph object={{ key: item.key, contentType: item.file.type } as StoredObject} /></span><div className="upload-file-info"><strong title={item.key}>{item.file.webkitRelativePath || item.file.name}</strong><div className="upload-file-status"><span>{formatBytes(item.file.size)}</span>{item.state === 'uploading' && <span>{Math.round(item.loaded / Math.max(1, item.file.size) * 100)}%</span>}{item.state === 'done' && <span>已保存</span>}{item.state === 'error' && <span className="upload-error">{item.error}</span>}{item.state === 'cancelled' && <span>已取消</span>}</div>{item.state === 'uploading' && <div className="upload-progress"><div style={{ width: `${Math.round(item.loaded / Math.max(1, item.file.size) * 100)}%` }} /></div>}</div>{item.state === 'done' ? <CheckCircle2 size={17} /> : item.state === 'uploading' ? <button className="icon-button" onClick={() => controllers.current.get(item.id)?.abort()} aria-label={`取消上传 ${item.file.name}`}><X size={15} /></button> : !uploadRunning ? <button className="icon-button" onClick={() => setUploads(current => current.filter(file => file.id !== item.id))} aria-label={`移除 ${item.file.name}`}><X size={15} /></button> : <LoaderCircle className="spin" size={16} />}</div>)}</div>}<label className="overwrite-option"><input type="checkbox" checked={overwrite} disabled={uploadRunning} onChange={event => setOverwrite(event.target.checked)} /><span>覆盖同名文件<span>默认保留已有文件</span></span></label></div><div className="modal-footer upload-footer"><span>{uploadRunning ? '正在上传，请保持页面打开' : uploadCount > 0 ? `${uploadCount} / ${uploads.length} 个文件已保存` : uploads.length ? `${uploads.length} 个文件 · ${formatBytes(uploads.reduce((sum, item) => sum + item.file.size, 0))}` : '文件将存入当前目录'}</span><div><button className="button" onClick={() => setUploadOpen(false)}>{uploadRunning ? '后台上传' : '关闭'}</button><button className="button dark" disabled={uploadRunning || !uploads.some(item => item.state !== 'done')} onClick={beginUpload}>{uploadRunning ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}{uploadRunning ? '正在上传' : uploads.some(item => item.state === 'error' || item.state === 'cancelled') ? '重试上传' : '开始上传'}</button></div></div></Modal>}
    {!uploadOpen && uploadRunning && <button className="upload-floating" onClick={() => setUploadOpen(true)}><LoaderCircle size={17} className="spin" />正在上传 {uploads.find(item => item.state === 'uploading')?.file.name || ''}<ChevronRight size={15} /></button>}
    {preview && !shareObject && <FileViewer bucket={bucket} object={preview} tab={previewTab} onTabChange={setPreviewTab} onClose={() => setPreview(null)} onShare={() => setShareObject(preview)} onTokens={() => openFileTokens(preview)} notify={notify} />}
    {shareObject && <ShareDialog key={`${bucket}:${shareObject.key}`} bucket={bucket} object={shareObject} onClose={() => setShareObject(null)} notify={notify} />}
    {fileTokenTarget && <Modal title="文件 API Token" subtitle={baseName(fileTokenTarget.object.key)} onClose={() => setFileTokenTarget(null)} className="file-token-dialog"><div className="modal-content"><TokenManager buckets={buckets} file={{ bucket: fileTokenTarget.bucket, key: fileTokenTarget.object.key }} notify={notify} /></div><div className="modal-footer"><button type="button" className="button" onClick={() => setFileTokenTarget(null)}>关闭</button></div></Modal>}
    {help && <Modal title="简单存储，开始于这里。" subtitle="MONO 使用帮助" onClose={() => setHelp(false)} className="help-dialog"><div className="modal-content help-content"><div><span>01</span><section><h3>存放文件</h3><p>点击“上传文件”，或将文件拖到对象列表。支持上传整个文件夹，大文件会自动分片。</p></section></div><div><span>02</span><section><h3>查看与管理</h3><p>点击文件名或缩略图直接预览，在“文件信息”中查看路径和元数据。点击“批量操作”后可选择多个文件，支持全选已加载文件、反选、打包下载、复制路径和批量删除。列表和网格视图都支持，删除前需确认。</p></section></div><div><span>03</span><section><h3>连接你的应用</h3><p>在“API 访问”查看上传、下载、查询和删除的调用示例。生产环境使用 Bearer Token 认证。</p></section></div>{session.local && <p className="help-local-note">当前为本地存储，数据持久化在项目的 .wrangler/state 中。部署到 Cloudflare 后，文件存入你绑定的 R2 桶。</p>}</div><div className="modal-footer"><button className="button dark" onClick={() => setHelp(false)}>知道了<Check size={15} /></button></div></Modal>}
    {toast && <Toast message={toast} onClose={() => setToast('')} />}
  </div>
}
