import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowUpRight, Box, Check, CheckCircle2, Copy, Database, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, Save, Settings2, ShieldCheck } from 'lucide-react'
import { api, StorageError, type Bucket, type SessionState } from './api'
import { Modal } from './components'
import { formatDate } from './format'
import { TokenManager } from './token-manager'

type LoginRateLimit = { maxAttempts: number; windowSeconds: number }
type WorkspaceConfig = { displayName: string; adminPath: string; createdAt: string; updatedAt: string; loginRateLimit: LoginRateLimit }
type ConfigResponse = { config: WorkspaceConfig; apiToken?: string }

export function SettingsPage({ buckets, session, onSessionChange, onOpenBucket, notify }: {
  buckets: Bucket[]
  session: SessionState
  onSessionChange: (state: SessionState) => void
  onOpenBucket: (name: string) => void
  notify: (message: string) => void
}) {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null)
  const [displayName, setDisplayName] = useState(session.displayName || '')
  const [adminPath, setAdminPath] = useState(session.adminPath || '')
  const [maxAttempts, setMaxAttempts] = useState('10')
  const [windowSeconds, setWindowSeconds] = useState('60')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveConflict, setSaveConflict] = useState(false)
  const [saved, setSaved] = useState(false)
  const [tokenDialog, setTokenDialog] = useState(false)
  const [tokenMode, setTokenMode] = useState<'generated' | 'custom'>('generated')
  const [customToken, setCustomToken] = useState('')
  const [showCustomToken, setShowCustomToken] = useState(false)
  const [confirmedRotation, setConfirmedRotation] = useState(false)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState('')
  const [tokenConflict, setTokenConflict] = useState(false)
  const [newToken, setNewToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [tokenRevision, setTokenRevision] = useState(0)
  const [configurationETag, setConfigurationETag] = useState<string | null>(null)
  const configETag = useRef<string | null>(null)

  function rememberETag(response: Response) { configETag.current = response.headers.get('ETag') }
  function rememberConfigMutation(response: Response) {
    rememberETag(response)
    setConfigurationETag(configETag.current)
  }

  useEffect(() => {
    const controller = new AbortController()
    configETag.current = null
    setLoading(true); setLoadError('')
    api<ConfigResponse>('/api/config', { signal: controller.signal }, (response: Response) => { if (!controller.signal.aborted) rememberETag(response) }).then(result => {
      applyConfig(result.config)
      setDisplayName(result.config.displayName)
      setAdminPath(result.config.adminPath)
      setMaxAttempts(String(result.config.loginRateLimit?.maxAttempts ?? 10))
      setWindowSeconds(String(result.config.loginRateLimit?.windowSeconds ?? 60))
    }).catch(error => { if (error.name !== 'AbortError') setLoadError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [loadRevision])

  function applyConfig(next: WorkspaceConfig) {
    setConfig(next)
    if (location.pathname !== next.adminPath) history.replaceState(null, '', next.adminPath)
    onSessionChange({ ...session, displayName: next.displayName, adminPath: next.adminPath, authenticated: true })
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault()
    if (saving || loading || saveConflict || !config) return
    setSaveError(''); setSaved(false)
    const nextName = displayName.trim()
    const nextPath = adminPath.trim()
    const loginRateLimit = { maxAttempts: Number(maxAttempts), windowSeconds: Number(windowSeconds) }
    if (nextName.length < 2) { setSaveError('工作空间名称至少需要 2 个字符。'); return }
    if (!nextPath.startsWith('/')) { setSaveError('后台入口需要以 / 开头，例如 /console。'); return }
    if (!Number.isInteger(loginRateLimit.maxAttempts) || loginRateLimit.maxAttempts < 1 || loginRateLimit.maxAttempts > 100) { setSaveError('登录尝试次数需要为 1 到 100 的整数。'); return }
    if (!Number.isInteger(loginRateLimit.windowSeconds) || loginRateLimit.windowSeconds < 10 || loginRateLimit.windowSeconds > 3600) { setSaveError('连续时间窗口需要为 10 到 3600 秒的整数。'); return }
    setSaving(true)
    try {
      const result = await api<ConfigResponse>('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(configETag.current ? { 'If-Match': configETag.current } : {}) }, body: JSON.stringify({ displayName: nextName, adminPath: nextPath, loginRateLimit }) }, rememberConfigMutation)
      applyConfig(result.config)
      setDisplayName(result.config.displayName)
      setAdminPath(result.config.adminPath)
      setMaxAttempts(String(result.config.loginRateLimit?.maxAttempts ?? 10))
      setWindowSeconds(String(result.config.loginRateLimit?.windowSeconds ?? 60))
      setSaved(true)
      notify('工作空间配置已保存')
    } catch (error) {
      const conflict = error instanceof StorageError && error.status === 409 && error.code === 'CONFIG_CONFLICT'
      setSaveConflict(conflict)
      setSaveError(conflict ? '配置已在其他页面更新，请重新读取后再保存。' : error instanceof Error ? error.message : '保存配置失败')
    }
    finally { setSaving(false) }
  }

  function openTokenDialog() {
    setTokenMode('generated'); setCustomToken(''); setShowCustomToken(false); setConfirmedRotation(false)
    setTokenError(''); setTokenConflict(false); setNewToken(''); setCopied(false); setTokenDialog(true)
  }

  function closeTokenDialog() {
    if (tokenBusy) return
    setTokenDialog(false); setCustomToken(''); setNewToken(''); setTokenError(''); setConfirmedRotation(false)
  }

  function reloadConfig() {
    if (saving || tokenBusy) return
    configETag.current = null
    setLoading(true)
    setSaved(false); setSaveError(''); setSaveConflict(false); setTokenConflict(false)
    closeTokenDialog()
    setLoadRevision(value => value + 1)
  }

  async function rotateToken(event: FormEvent) {
    event.preventDefault()
    if (tokenBusy || loading || tokenConflict || !confirmedRotation || newToken) return
    setTokenError('')
    const value = tokenMode === 'generated' ? '' : customToken.trim()
    if (tokenMode === 'custom' && (value.length < 24 || value.length > 256)) { setTokenError('自定义管理员密钥长度需要在 24 到 256 个字符之间。'); return }
    setTokenBusy(true)
    try {
      const result = await api<ConfigResponse>('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(configETag.current ? { 'If-Match': configETag.current } : {}) }, body: JSON.stringify({ apiToken: value }) }, rememberETag)
      applyConfig(result.config)
      setCustomToken(''); setShowCustomToken(false)
      setNewToken(result.apiToken || '')
      setTokenRevision(value => value + 1)
      if (!result.apiToken) setTokenError('管理员密钥已更新，但未返回新密钥。请使用你提交的自定义密钥登录。')
      else notify('管理员密钥已更新，请保存新密钥')
    } catch (error) {
      const conflict = error instanceof StorageError && error.status === 409 && error.code === 'CONFIG_CONFLICT'
      setTokenConflict(conflict)
      setTokenError(conflict ? '配置已在其他页面更新，请重新读取后再更换管理员密钥。' : error instanceof Error ? error.message : '更新管理员密钥失败')
    }
    finally { setTokenBusy(false) }
  }

  const changed = Boolean(config && (displayName.trim() !== config.displayName || adminPath.trim() !== config.adminPath || Number(maxAttempts) !== (config.loginRateLimit?.maxAttempts ?? 10) || Number(windowSeconds) !== (config.loginRateLimit?.windowSeconds ?? 60)))

  return <div className="settings-page">
    <div className="eyebrow">SETTINGS</div><h1>设置</h1><p className="page-description">修改工作空间和登录限速，管理 API Token 与管理员密钥。</p>
    <section className="settings-card">
      <div className="settings-section-heading"><Settings2 size={19} /><h3>工作空间</h3></div>
      {loading ? <div className="settings-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取配置</div> : loadError ? <div className="settings-load-error"><p className="form-error" role="alert"><AlertCircle size={16} />{loadError}</p><button className="button" type="button" onClick={reloadConfig}><RefreshCw size={15} />重新读取配置</button></div> : <form className="settings-form" onSubmit={saveConfig}>
        <div className="setting-field"><label className="field-label" htmlFor="settings-display-name">工作空间名称</label><input id="settings-display-name" className="text-input" value={displayName} maxLength={80} required minLength={2} disabled={saving} aria-describedby="settings-name-hint" onChange={event => { setDisplayName(event.target.value); setSaved(false) }} /><p className="setting-hint" id="settings-name-hint">显示在侧边栏和浏览器标题中，长度为 2 到 80 个字符。</p></div>
        <div className="setting-field"><label className="field-label" htmlFor="settings-admin-path">后台入口</label><input id="settings-admin-path" className="text-input mono" value={adminPath} required autoComplete="off" spellCheck={false} disabled={saving} aria-describedby="settings-path-hint" onChange={event => { setAdminPath(event.target.value); setSaved(false) }} /><p className="setting-hint" id="settings-path-hint">例如 /console。保存后当前页面会切换到新入口，旧入口停止访问。请更新收藏的后台地址。</p></div>
        <fieldset className="settings-rate-limit"><legend className="field-label">登录限速</legend><div className="settings-rate-limit-fields"><div className="setting-field"><label className="field-label" htmlFor="settings-login-attempts">最大登录尝试次数</label><input id="settings-login-attempts" className="text-input" type="number" min={1} max={100} step={1} required disabled={saving} value={maxAttempts} aria-describedby="settings-login-limit-hint" onChange={event => { setMaxAttempts(event.target.value); setSaved(false) }} /></div><div className="setting-field"><label className="field-label" htmlFor="settings-login-window">连续时间窗口（秒）</label><input id="settings-login-window" className="text-input" type="number" min={10} max={3600} step={1} required disabled={saving} value={windowSeconds} aria-describedby="settings-login-limit-hint" onChange={event => { setWindowSeconds(event.target.value); setSaved(false) }} /></div></div><p className="setting-hint" id="settings-login-limit-hint">每个来源 IP 在任意连续窗口内最多允许上述次数的登录尝试，成功和失败都会计入。登录限速不能关闭；保存后立即生效。</p></fieldset>
        {saveError && <p className="form-error" role="alert"><AlertCircle size={16} />{saveError}</p>}
        {saveConflict && <button className="button" type="button" onClick={reloadConfig}><RefreshCw size={15} />重新读取配置</button>}
        <div className="settings-actions"><span className="settings-save-status" role="status">{saved ? <><CheckCircle2 size={16} />配置已保存</> : config?.updatedAt ? `上次更新：${formatDate(config.updatedAt, true)}` : ''}</span><div><button className="button" type="button" disabled={saving || !changed} onClick={() => { if (config) { setDisplayName(config.displayName); setAdminPath(config.adminPath); setMaxAttempts(String(config.loginRateLimit?.maxAttempts ?? 10)); setWindowSeconds(String(config.loginRateLimit?.windowSeconds ?? 60)); if (!saveConflict) setSaveError(''); setSaved(false) } }}>还原修改</button><button className="button dark" type="submit" disabled={saving || saveConflict || !changed}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{saving ? '正在保存' : '保存配置'}</button></div></div>
      </form>}
    </section>
    <section className="settings-card">
      <div className="settings-section-heading"><ShieldCheck size={19} /><h3>访问认证</h3></div>
      <div className="setting-row"><div><strong>{session.local ? '本地开发模式' : '私有访问已启用'}</strong><p>{session.local ? '文件和配置保存在当前项目的本地存储中。' : '网页登录和 API 调用均需要认证。'}</p></div><span className="tag"><LockKeyhole size={12} />私有访问</span></div>
      <div className="setting-row"><div><strong>管理员密钥</strong><p>用于后台登录，拥有所有存储桶和配置的完整权限。当前密钥不会再次显示，忘记时可以生成新密钥。</p></div><button className="button" type="button" disabled={loading || Boolean(loadError) || saving || saveConflict} onClick={openTokenDialog}><KeyRound size={15} />更换管理员密钥</button></div>
    </section>
    <TokenManager key={tokenRevision} buckets={buckets} notify={notify} onRegistryChange={rememberETag} configurationETag={configurationETag} />
    <section className="settings-card">
      <div className="settings-section-heading"><Database size={19} /><h3>已连接的存储桶</h3></div>
      {buckets.map(item => <div className="setting-row" key={item.name}><div><strong>{item.name}</strong><p>{item.description || '对象存储桶'}</p></div><span className="tag"><LockKeyhole size={12} />私有</span><button className="button" type="button" onClick={() => onOpenBucket(item.name)}>打开<ArrowUpRight size={14} /></button></div>)}
      <p className="setting-footnote">新增存储桶需先在 Cloudflare 创建 R2 桶，再添加 Worker 绑定并更新存储桶配置。</p>
    </section>
    <section className="settings-card"><div className="settings-section-heading"><Box size={19} /><h3>关于 MONO</h3></div><div className="setting-row"><div><strong>{session.displayName}</strong><p>版本 1.0.0 · 对象存储与 Web 控制台</p></div><span className="tag">Workers + R2</span></div></section>
    {tokenDialog && <Modal title={newToken ? '保存新的管理员密钥' : '更换管理员密钥'} subtitle={newToken ? '新密钥仅在这里显示，请先复制保存。' : '你可以自动生成密钥，也可以设置自己的密钥。'} onClose={closeTokenDialog} className="token-dialog">
      {newToken ? <>
        <div className="modal-content token-result"><div className="token-result-status"><CheckCircle2 size={20} /><strong>管理员密钥已更新，当前页面保持登录</strong></div><p className="setting-hint">后续后台登录请使用下面的新密钥。关闭窗口后，无法再次查看它。应用调用 API 时建议创建权限受限的 API Token。</p><label className="field-label" htmlFor="settings-new-token">新的管理员密钥</label><div className="token-result-field"><input id="settings-new-token" className="text-input mono" value={newToken} readOnly spellCheck={false} onFocus={event => event.target.select()} /><button className="button" type="button" onClick={async () => { try { await navigator.clipboard.writeText(newToken); setCopied(true); notify('新管理员密钥已复制') } catch { setTokenError('请选中上方密钥并手动复制。') } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button></div>{tokenError && <p className="form-error" role="alert"><AlertCircle size={16} />{tokenError}</p>}</div>
        <div className="modal-footer"><button className="button dark" type="button" onClick={closeTokenDialog}><EyeOff size={15} />隐藏并关闭</button></div>
      </> : <form onSubmit={rotateToken}>
        <div className="modal-content token-form"><fieldset className="token-mode"><legend className="field-label">密钥生成方式</legend><label><input type="radio" name="token-mode" value="generated" checked={tokenMode === 'generated'} disabled={tokenBusy} onChange={() => setTokenMode('generated')} /><span>自动生成随机密钥</span></label><label><input type="radio" name="token-mode" value="custom" checked={tokenMode === 'custom'} disabled={tokenBusy} onChange={() => setTokenMode('custom')} /><span>使用自定义密钥</span></label></fieldset>
          {tokenMode === 'custom' && <div className="setting-field"><label className="field-label" htmlFor="settings-custom-token">自定义管理员密钥</label><div className="secret-input"><input id="settings-custom-token" type={showCustomToken ? 'text' : 'password'} value={customToken} required minLength={24} maxLength={256} autoComplete="new-password" disabled={tokenBusy} spellCheck={false} aria-describedby="settings-token-hint" onChange={event => setCustomToken(event.target.value)} /><button className="secret-action" type="button" disabled={tokenBusy} aria-label={showCustomToken ? '隐藏自定义管理员密钥' : '显示自定义管理员密钥'} onClick={() => setShowCustomToken(value => !value)}>{showCustomToken ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><p className="setting-hint" id="settings-token-hint">长度为 24 到 256 个字符，建议使用随机字符串。</p></div>}
          <div className="token-rotation-note"><AlertCircle size={18} /><p>更换后，旧管理员密钥、所有 API Token、其他设备上的登录和现有分享链接都会失效。当前页面会保持登录。</p></div>
          <label className="token-confirm"><input type="checkbox" checked={confirmedRotation} disabled={tokenBusy} onChange={event => setConfirmedRotation(event.target.checked)} /><span>我已了解上述影响，确认更换管理员密钥。</span></label>
          {tokenError && <p className="form-error" role="alert"><AlertCircle size={16} />{tokenError}</p>}
          {tokenConflict && <button className="button" type="button" onClick={reloadConfig}><RefreshCw size={15} />重新读取配置</button>}
        </div>
        <div className="modal-footer token-dialog-actions"><button className="button" type="button" disabled={tokenBusy} onClick={closeTokenDialog}>取消</button><button className="button dark" type="submit" disabled={tokenBusy || tokenConflict || !confirmedRotation}>{tokenBusy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{tokenBusy ? '正在更换' : '确认更换管理员密钥'}</button></div>
      </form>}
    </Modal>}
  </div>
}
