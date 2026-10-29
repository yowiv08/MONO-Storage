import { useId, type KeyboardEvent } from 'react'
import { Copy, Download, KeyRound, Share2 } from 'lucide-react'
import { objectUrl, type StoredObject } from './api'
import { Modal, Preview } from './components'
import { baseName, formatBytes, formatDate, typeLabel } from './format'
import { previewKind, sourceModeLabel, supportsDocumentSource } from './preview-kind'

export type FileViewTab = 'preview' | 'source' | 'info'

export function FileViewer({ bucket, object, tab, onTabChange, onClose, onShare, onTokens, notify }: {
  bucket: string
  object: StoredObject
  tab: FileViewTab
  onTabChange: (tab: FileViewTab) => void
  onClose: () => void
  onShare: () => void
  onTokens: () => void
  notify: (message: string) => void
}) {
  const id = useId()
  const kind = previewKind(object.key, object.contentType)
  const hasSource = supportsDocumentSource(kind)
  const tabs: FileViewTab[] = hasSource ? ['preview', 'source', 'info'] : ['preview', 'info']
  async function copyPath() {
    try { await navigator.clipboard.writeText(object.key); notify('对象路径已复制') }
    catch { notify('浏览器不允许复制，请手动选择路径。') }
  }
  function switchTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const offset = event.key === 'ArrowLeft' ? -1 : 1
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! : tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length]
    onTabChange(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }
  return <Modal title={baseName(object.key)} subtitle={`${formatBytes(object.size)} · ${typeLabel(object.key, object.contentType)} · 私有文件`} onClose={onClose} className="file-viewer">
    <div className="file-viewer-tabs" role="tablist" aria-label="文件查看方式" onKeyDown={switchTab}>
      <button role="tab" id={`${id}-preview-tab`} aria-controls={`${id}-panel`} aria-selected={tab === 'preview'} tabIndex={tab === 'preview' ? 0 : -1} data-tab="preview" onClick={() => onTabChange('preview')}>{hasSource ? '格式预览' : '内容预览'}</button>
      {hasSource && <button role="tab" id={`${id}-source-tab`} aria-controls={`${id}-panel`} aria-selected={tab === 'source'} tabIndex={tab === 'source' ? 0 : -1} data-tab="source" onClick={() => onTabChange('source')}>{sourceModeLabel(kind)}</button>}
      <button role="tab" id={`${id}-info-tab`} aria-controls={`${id}-panel`} aria-selected={tab === 'info'} tabIndex={tab === 'info' ? 0 : -1} data-tab="info" onClick={() => onTabChange('info')}>文件信息</button>
    </div>
    <div className="file-viewer-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`}>
      {tab !== 'info' && <Preview key={object.key} bucket={bucket} object={object} mode={tab === 'source' ? 'source' : 'preview'} showModeControls={false} />}
      {tab === 'info' && <dl className="file-info-list">
        <div className="file-info-wide"><dt>对象路径</dt><dd className="file-info-path"><span>{object.key}</span><button className="icon-button" aria-label="复制对象路径" onClick={copyPath}><Copy size={16} /></button></dd></div>
        <div><dt>存储桶</dt><dd>{bucket}</dd></div><div><dt>文件大小</dt><dd>{formatBytes(object.size)}</dd></div>
        <div><dt>文件类型</dt><dd>{object.contentType}</dd></div><div><dt>上传时间</dt><dd>{formatDate(object.uploaded, true)}</dd></div>
        <div><dt>访问权限</dt><dd>私有访问</dd></div><div><dt>存储类型</dt><dd>标准存储</dd></div>
        <div className="file-info-wide"><dt>ETag</dt><dd className="file-info-etag">{object.etag}</dd></div>
        {Object.entries(object.metadata).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
      </dl>}
    </div>
    <div className="file-viewer-footer"><span className="file-viewer-hint"><kbd>Esc</kbd>关闭窗口</span><div className="file-viewer-actions"><button className="button" onClick={onTokens}><KeyRound size={16} />API Token</button><button className="button" onClick={onShare}><Share2 size={16} />分享文件</button><a className="button dark" href={objectUrl(bucket, object.key, true)} download><Download size={16} />下载文件</a></div></div>
  </Modal>
}
