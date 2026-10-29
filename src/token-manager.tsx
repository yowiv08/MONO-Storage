import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, Check, Copy, Eye, EyeOff, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { StorageError, type Bucket } from './api'
import { Modal } from './components'
import { formatDate } from './format'
import { createAccessToken, listAccessTokens, revokeAccessToken, updateAccessToken, type AccessTokenInfo } from './token-api'
import { permissionPreset, permissionsForScope, tokenPermissionDefinitions, type TokenPermission, type TokenScope } from '../shared/token-permissions'

export type TokenManagerProps = {
  buckets: Bucket[]
  file?: { bucket: string; key: string }
  notify: (message: string) => void
  onRegistryChange?: (response: Response) => void
  configurationETag?: string | null
}

function scopeLabel(scope: TokenScope) {
  return scope.type === 'all' ? '所有存储桶' : scope.type === 'bucket' ? `存储桶：${scope.bucket}` : `文件：${scope.bucket}/${scope.key}`
}

function tokenStatus(token: AccessTokenInfo) {
  return token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? '已过期' : token.enabled ? '已启用' : '已停用'
}

function localDateTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function isTokenConflict(error: unknown) {
  return error instanceof StorageError && error.status === 409 && ['TOKEN_CONFLICT', 'CONFIG_CONFLICT'].includes(error.code)
}

export function TokenManager({ buckets, file, notify, onRegistryChange, configurationETag }: TokenManagerProps) {
  const fieldId = useId()
  const [tokens, setTokens] = useState<AccessTokenInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [revision, setRevision] = useState(0)
  const etag = useRef<string | null>(null)
  const [busyId, setBusyId] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<AccessTokenInfo | null>(null)
  const [name, setName] = useState('')
  const [scopeType, setScopeType] = useState<TokenScope['type']>('all')
  const [scopeBucket, setScopeBucket] = useState('')
  const [scopeKey, setScopeKey] = useState('')
  const [permissions, setPermissions] = useState<TokenPermission[]>(['read'])
  const [enabled, setEnabled] = useState(true)
  const [expiryMode, setExpiryMode] = useState('never')
  const [expiryDate, setExpiryDate] = useState('')
  const [secretMode, setSecretMode] = useState<'generated' | 'custom'>('generated')
  const [customSecret, setCustomSecret] = useState('')
  const [showCustomSecret, setShowCustomSecret] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [editorConflict, setEditorConflict] = useState(false)
  const [createdSecret, setCreatedSecret] = useState('')
  const [createdToken, setCreatedToken] = useState<AccessTokenInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<AccessTokenInfo | null>(null)
  const [revokeError, setRevokeError] = useState('')
  const [revokeConflict, setRevokeConflict] = useState(false)

  const draftScope: TokenScope = editing?.scope || (file ? { type: 'file', ...file } : scopeType === 'all' ? { type: 'all' } : scopeType === 'bucket' ? { type: 'bucket', bucket: scopeBucket } : { type: 'file', bucket: scopeBucket, key: scopeKey.trim() })
  const allowed = permissionsForScope(draftScope)
  const visiblePermissions = tokenPermissionDefinitions.filter(item => allowed.includes(item.id))

  function rememberETag(response: Response) { etag.current = response.headers.get('ETag') }
  function rememberMutation(response: Response) { rememberETag(response); onRegistryChange?.(response) }
  function refresh() {
    etag.current = null; setLoading(true); setListError('')
    setEditorConflict(false); setRevokeConflict(false)
    setRevision(value => value + 1)
  }

  useEffect(() => {
    const controller = new AbortController()
    etag.current = null; setLoading(true); setListError('')
    listAccessTokens(file ? { bucket: file.bucket, key: file.key } : undefined, controller.signal, response => { if (!controller.signal.aborted) rememberETag(response) }).then(result => {
      if (!controller.signal.aborted) setTokens(result.tokens)
    }).catch(error => { if (error.name !== 'AbortError') setListError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [file?.bucket, file?.key, revision])

  useEffect(() => {
    if (configurationETag) etag.current = configurationETag
  }, [configurationETag])

  function openEditor(token?: AccessTokenInfo) {
    setEditing(token || null)
    const scope = token?.scope || (file ? { type: 'file' as const, ...file } : { type: 'all' as const })
    setName(token?.name || '')
    setScopeType(scope.type)
    setScopeBucket(scope.type === 'all' ? buckets[0]?.name || '' : scope.bucket)
    setScopeKey(scope.type === 'file' ? scope.key : '')
    setPermissions(token ? [...token.permissions] : ['read'])
    setEnabled(token?.enabled ?? true)
    setExpiryMode(token?.expiresAt ? 'custom' : 'never')
    setExpiryDate(token?.expiresAt ? localDateTime(token.expiresAt) : '')
    setSecretMode('generated'); setCustomSecret(''); setShowCustomSecret(false)
    setEditorError(''); setEditorConflict(false); setCreatedSecret(''); setCreatedToken(null); setCopied(false)
    setEditorOpen(true)
  }

  function closeEditor() {
    if (editorBusy) return
    setEditorOpen(false); setCustomSecret(''); setCreatedSecret(''); setCreatedToken(null); setEditorError('')
  }

  function changeScope(type: TokenScope['type']) {
    setScopeType(type)
    const next: TokenScope = type === 'all' ? { type: 'all' } : type === 'bucket' ? { type: 'bucket', bucket: scopeBucket } : { type: 'file', bucket: scopeBucket, key: scopeKey.trim() }
    const nextAllowed = permissionsForScope(next)
    setPermissions(current => current.filter(permission => nextAllowed.includes(permission)))
  }

  function togglePermission(permission: TokenPermission) {
    setPermissions(current => {
      const next = new Set(current)
      if (next.has(permission)) {
        next.delete(permission)
        if (permission === 'read') next.delete('share')
      } else {
        next.add(permission)
        if (permission === 'share') next.add('read')
      }
      return Array.from(next)
    })
  }

  async function saveToken(event: FormEvent) {
    event.preventDefault()
    if (editorBusy || loading || editorConflict || listError || createdToken) return
    setEditorError('')
    if (!name.trim()) { setEditorError('请填写 Token 名称，便于区分用途。'); return }
    if (draftScope.type !== 'all' && !draftScope.bucket) { setEditorError('请选择要授权的存储桶。'); return }
    if (draftScope.type === 'file' && !draftScope.key) { setEditorError('请填写完整的对象路径。'); return }
    if (!permissions.length) { setEditorError('请至少选择一项权限。'); return }
    const expiryChanged = !editing || (editing.expiresAt ? expiryMode !== 'custom' || expiryDate !== localDateTime(editing.expiresAt) : expiryMode !== 'never')
    let expiresAt: string | null = null
    if (expiryChanged && expiryMode !== 'never') {
      const date = expiryMode === 'custom' ? new Date(expiryDate) : new Date(Date.now() + Number(expiryMode) * 86_400_000)
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setEditorError('有效期需要晚于当前时间。'); return }
      expiresAt = date.toISOString()
    }
    const custom = customSecret.trim()
    if (!editing && secretMode === 'custom' && (custom.length < 24 || custom.length > 256)) { setEditorError('自定义 Token 长度需要在 24 到 256 个字符之间。'); return }
    setEditorBusy(true)
    try {
      if (editing) {
        await updateAccessToken(editing.id, { name: name.trim(), permissions, enabled, ...(expiryChanged ? { expiresAt } : {}) }, etag.current, rememberMutation)
        setEditorOpen(false); notify('Token 已更新'); refresh()
      } else {
        const result = await createAccessToken({ name: name.trim(), scope: draftScope, permissions, expiresAt, ...(secretMode === 'custom' ? { token: custom } : {}) }, etag.current, rememberMutation)
        setCustomSecret(''); setShowCustomSecret(false)
        setCreatedToken(result.token)
        if (!result.secret) {
          setEditorError('Token 已创建，但未收到密钥。请关闭窗口并重新读取列表。')
          refresh()
          return
        }
        setCreatedSecret(result.secret)
        notify('Token 已创建，请复制保存密钥'); refresh()
      }
    } catch (error) {
      const conflict = isTokenConflict(error)
      setEditorConflict(conflict)
      setEditorError(conflict ? 'Token 列表已在其他页面更新，请重新读取后再保存。' : error instanceof Error ? error.message : '保存 Token 失败')
    } finally { setEditorBusy(false) }
  }

  async function toggleEnabled(token: AccessTokenInfo) {
    if (busyId || loading || listError) return
    setBusyId(token.id); setListError('')
    try {
      await updateAccessToken(token.id, { enabled: !token.enabled }, etag.current, rememberMutation)
      notify(token.enabled ? 'Token 已停用' : 'Token 已启用'); refresh()
    } catch (error) {
      setListError(isTokenConflict(error) ? 'Token 列表已更新，请重新读取后再操作。' : error instanceof Error ? error.message : '修改 Token 状态失败')
    } finally { setBusyId('') }
  }

  async function confirmRevoke() {
    if (!revoking || busyId || loading || revokeConflict || listError) return
    setBusyId(revoking.id); setRevokeError('')
    try {
      await revokeAccessToken(revoking.id, etag.current, rememberMutation)
      setRevoking(null); notify('Token 已撤销'); refresh()
    } catch (error) {
      const conflict = isTokenConflict(error)
      setRevokeConflict(conflict)
      setRevokeError(conflict ? 'Token 列表已更新，请重新读取后再撤销。' : error instanceof Error ? error.message : '撤销 Token 失败')
    } finally { setBusyId('') }
  }

  return <section className={`settings-card token-manager ${file ? 'token-manager-file' : ''}`}>
    <div className="settings-section-heading token-manager-heading"><KeyRound size={19} /><h3>{file ? '文件 API Token' : 'API Token'}</h3><div className="token-manager-heading-actions"><button className="icon-button" type="button" aria-label="重新读取 Token 列表" disabled={loading || Boolean(busyId) || editorBusy} onClick={refresh}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button><button className="button" type="button" disabled={loading || Boolean(listError) || Boolean(busyId)} onClick={() => openEditor()}><Plus size={16} />创建 Token</button></div></div>
    <p className="token-manager-note">{file ? '这里的 Token 只授权当前文件，可独立设置读取、写入、删除和分享权限。' : '给应用分配独立的访问密钥，限定存储范围和权限。API Token 用于接口调用，后台登录使用管理员密钥。'}</p>
    {listError && <div className="token-manager-error"><p className="form-error" role="alert"><AlertCircle size={16} />{listError}</p><button className="button" type="button" disabled={Boolean(busyId)} onClick={refresh}><RefreshCw size={15} />重新读取 Token 列表</button></div>}
    {loading ? <div className="settings-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取 Token</div> : !tokens.length && !listError ? <div className="token-empty"><KeyRound size={25} /><strong>还没有{file ? '此文件的' : ''} API Token</strong><p>创建后可复制密钥，供应用调用 API。</p></div> : <div className="token-list">{tokens.map(token => <article className="token-item" key={token.id}>
      <div className="token-item-header"><strong>{token.name}</strong><span className={`tag token-status ${tokenStatus(token) === '已启用' ? 'token-status-enabled' : ''}`}>{tokenStatus(token)}</span></div>
      <p className="token-item-scope">{scopeLabel(token.scope)}</p>
      <div className="token-permission-tags">{token.permissions.map(permission => <span className="tag" key={permission}>{tokenPermissionDefinitions.find(item => item.id === permission)?.label || permission}</span>)}</div>
      <div className="token-item-footer"><span className="token-item-expiry">{token.expiresAt ? `有效至 ${formatDate(token.expiresAt, true)}` : '永久有效'}</span><div className="token-item-actions"><button className="text-button" type="button" disabled={loading || Boolean(busyId) || Boolean(listError)} onClick={() => tokenStatus(token) === '已过期' ? openEditor(token) : toggleEnabled(token)}>{busyId === token.id ? <LoaderCircle size={14} className="spin" /> : null}{tokenStatus(token) === '已过期' ? '修改有效期' : token.enabled ? '停用' : '启用'}</button><button className="text-button" type="button" disabled={loading || Boolean(busyId) || Boolean(listError)} onClick={() => openEditor(token)}><Pencil size={14} />编辑</button><button className="text-button token-revoke" type="button" disabled={loading || Boolean(busyId) || Boolean(listError)} onClick={() => { setRevoking(token); setRevokeError(''); setRevokeConflict(false) }}><Trash2 size={14} />撤销</button></div></div>
    </article>)}</div>}
    {editorOpen && <Modal title={createdSecret ? '保存 API Token' : editing ? '编辑 API Token' : '创建 API Token'} subtitle={createdSecret ? '密钥仅显示一次，关闭前请复制保存。' : file ? '仅授权当前文件。' : '选择授权范围、权限和有效期。'} onClose={closeEditor} className="token-editor-dialog">
      {createdSecret && createdToken ? <><div className="modal-content token-secret-result"><div className="token-result-status"><ShieldCheck size={21} /><strong>{createdToken.name} 已创建</strong></div><p className="setting-hint">{scopeLabel(createdToken.scope)}。此密钥不会出现在 Token 列表中，关闭后无法再次查看。</p><label className="field-label" htmlFor={`${fieldId}-result`}>API Token 密钥</label><div className="token-result-field"><input id={`${fieldId}-result`} className="text-input mono" value={createdSecret} readOnly spellCheck={false} onFocus={event => event.target.select()} /><button className="button" type="button" onClick={async () => { try { await navigator.clipboard.writeText(createdSecret); setCopied(true); notify('API Token 已复制') } catch { setEditorError('请选中上方密钥并手动复制。') } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button></div>{editorError && <p className="form-error" role="alert"><AlertCircle size={16} />{editorError}</p>}</div><div className="modal-footer"><button className="button dark" type="button" onClick={closeEditor}><EyeOff size={15} />隐藏并关闭</button></div></> : <form onSubmit={saveToken}>
        <div className="modal-content token-editor-form">
          <div className="setting-field"><label className="field-label" htmlFor={`${fieldId}-name`}>Token 名称</label><input id={`${fieldId}-name`} className="text-input" value={name} required maxLength={80} disabled={editorBusy} placeholder="例如：网站只读访问" onChange={event => setName(event.target.value)} /></div>
          <div className="setting-field"><label className="field-label" htmlFor={`${fieldId}-scope`}>授权范围</label>{editing || file ? <div className="token-scope-fixed">{scopeLabel(draftScope)}</div> : <><select id={`${fieldId}-scope`} className="text-input" value={scopeType} disabled={editorBusy} onChange={event => changeScope(event.target.value as TokenScope['type'])}><option value="all">所有存储桶</option><option value="bucket">单个存储桶</option><option value="file">单个文件</option></select>{scopeType !== 'all' && <div className="token-scope-fields"><label className="field-label" htmlFor={`${fieldId}-bucket`}>存储桶</label><select id={`${fieldId}-bucket`} className="text-input" value={scopeBucket} disabled={editorBusy} required onChange={event => setScopeBucket(event.target.value)}>{!buckets.length && <option value="">没有可用存储桶</option>}{buckets.map(bucket => <option key={bucket.name} value={bucket.name}>{bucket.name}</option>)}</select>{scopeType === 'file' && <><label className="field-label" htmlFor={`${fieldId}-key`}>对象路径</label><input id={`${fieldId}-key`} className="text-input" value={scopeKey} required disabled={editorBusy} placeholder="例如：documents/report.pdf" spellCheck={false} onChange={event => setScopeKey(event.target.value)} /></>}</div>}</>}{editing && <p className="setting-hint">授权范围创建后固定。需要修改范围时，请创建新的 Token。</p>}</div>
          <fieldset className="token-permissions-field"><legend className="field-label">访问权限</legend><div className="token-presets">{(['read', 'write', 'read_write', 'all'] as const).map((preset, index) => <button type="button" className="button small" key={preset} disabled={editorBusy} onClick={() => setPermissions(permissionPreset(preset, draftScope))}>{['只读', '只写', '读写', 'ALL'][index]}</button>)}</div><div className="token-permissions-grid">{visiblePermissions.map(item => <label className="token-permission-option" key={item.id}><input type="checkbox" checked={permissions.includes(item.id)} disabled={editorBusy} onChange={() => togglePermission(item.id)} /><span><strong>{item.label}</strong><small>{draftScope.type === 'file' && item.id === 'read' ? '查看信息、预览和下载当前文件。' : item.description}</small></span></label>)}</div><p className="setting-hint">可以单独勾选权限。管理分享需要读取权限，选择分享时会同时启用读取。</p></fieldset>
          <div className="token-expiry-fields"><div className="setting-field"><label className="field-label" htmlFor={`${fieldId}-expiry`}>有效期</label><select id={`${fieldId}-expiry`} className="text-input" value={expiryMode} disabled={editorBusy} onChange={event => setExpiryMode(event.target.value)}><option value="never">永久有效</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="custom">指定到期时间</option></select></div>{expiryMode === 'custom' && <div className="setting-field"><label className="field-label" htmlFor={`${fieldId}-expiry-date`}>到期时间</label><input id={`${fieldId}-expiry-date`} className="text-input" type="datetime-local" value={expiryDate} required disabled={editorBusy} onChange={event => setExpiryDate(event.target.value)} /></div>}</div>
          {editing && tokenStatus(editing) === '已过期' && <p className="setting-hint">这个 Token 已过期。如需恢复访问，请设置新的有效期，并勾选启用。</p>}
          {editing ? <label className="token-enabled-option"><input type="checkbox" checked={enabled} disabled={editorBusy} onChange={event => setEnabled(event.target.checked)} /><span>启用这个 Token</span></label> : <fieldset className="token-mode"><legend className="field-label">密钥生成方式</legend><label><input type="radio" name={`${fieldId}-secret-mode`} checked={secretMode === 'generated'} disabled={editorBusy} onChange={() => setSecretMode('generated')} /><span>自动生成随机密钥</span></label><label><input type="radio" name={`${fieldId}-secret-mode`} checked={secretMode === 'custom'} disabled={editorBusy} onChange={() => setSecretMode('custom')} /><span>使用自定义密钥</span></label>{secretMode === 'custom' && <div className="setting-field"><label className="field-label" htmlFor={`${fieldId}-custom-secret`}>自定义 Token</label><div className="secret-input"><input id={`${fieldId}-custom-secret`} type={showCustomSecret ? 'text' : 'password'} value={customSecret} required minLength={24} maxLength={256} autoComplete="new-password" disabled={editorBusy} spellCheck={false} onChange={event => setCustomSecret(event.target.value)} /><button className="secret-action" type="button" disabled={editorBusy} aria-label={showCustomSecret ? '隐藏自定义 Token' : '显示自定义 Token'} onClick={() => setShowCustomSecret(value => !value)}>{showCustomSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><p className="setting-hint">长度为 24 到 256 个字符，建议使用随机字符串。</p></div>}</fieldset>}
          {editorError && <p className="form-error" role="alert"><AlertCircle size={16} />{editorError}</p>}
          {editorConflict && <button className="button" type="button" disabled={editorBusy || loading} onClick={refresh}><RefreshCw size={15} />重新读取 Token 列表</button>}
        </div><div className="modal-footer token-dialog-actions"><button className="button" type="button" disabled={editorBusy} onClick={closeEditor}>{createdToken ? '关闭' : '取消'}</button><button className="button dark" type="submit" disabled={editorBusy || loading || editorConflict || Boolean(listError) || Boolean(createdToken)}>{editorBusy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{editorBusy ? '正在保存' : editing ? '保存修改' : '创建 Token'}</button></div>
      </form>}
    </Modal>}
    {revoking && <Modal title="撤销 API Token" subtitle="撤销后，使用此密钥的应用将无法继续访问。" onClose={() => { if (!busyId) setRevoking(null) }} className="token-revoke-dialog"><div className="modal-content"><strong>{revoking.name}</strong><p className="setting-hint">{scopeLabel(revoking.scope)}</p><p className="setting-hint">此操作立即生效。需要恢复访问时，请创建新的 Token。</p>{revokeError && <p className="form-error" role="alert"><AlertCircle size={16} />{revokeError}</p>}{(revokeConflict || listError) && <button className="button" type="button" disabled={loading || Boolean(busyId)} onClick={refresh}><RefreshCw size={15} />重新读取 Token 列表</button>}</div><div className="modal-footer token-dialog-actions"><button className="button" type="button" disabled={Boolean(busyId)} onClick={() => setRevoking(null)}>取消</button><button className="button dark" type="button" disabled={Boolean(busyId) || loading || revokeConflict || Boolean(listError)} onClick={confirmRevoke}>{busyId ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}确认撤销</button></div></Modal>}
  </section>
}
