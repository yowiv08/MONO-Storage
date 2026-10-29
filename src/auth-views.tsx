import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowUpRight, Check, Copy, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react'
import { api, StorageError, type SessionState } from './public-api'
import { ThemeToggle } from './theme'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryAt, setRetryAt] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const submitting = useRef(false)

  useEffect(() => {
    if (!retryAt) return
    const update = () => {
      const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
      setRemaining(seconds)
      if (!seconds) setRetryAt(0)
    }
    update()
    const timer = setInterval(update, 250)
    return () => clearInterval(timer)
  }, [retryAt])

  async function login(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || retryAt > Date.now()) return
    submitting.current = true; setError(''); setBusy(true)
    try {
      await api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      setToken(''); setRetryAt(0); setRemaining(0); onLogin()
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败')
      if (error instanceof StorageError && error.status === 429) {
        const seconds = Number.isFinite(error.retryAfter) && error.retryAfter !== null ? Math.max(1, Math.ceil(error.retryAfter)) : 60
        setRemaining(seconds); setRetryAt(Date.now() + seconds * 1000)
      }
    } finally { submitting.current = false; setBusy(false) }
  }

  return <div className="login-page"><div className="login-brand">MONO<span>STORAGE</span></div><form className="login-card" onSubmit={login}>
    <div className="login-icon"><LockKeyhole size={26} strokeWidth={1.4} /></div><div className="eyebrow">YOUR PRIVATE WORKSPACE</div><h1>文件，井井有条。</h1><p>输入管理员密钥，打开你的存储空间。</p>
    <label htmlFor="access-token">管理员密钥</label><input id="access-token" type="password" autoComplete="off" placeholder="输入你的管理员密钥" value={token} onChange={event => setToken(event.target.value)} maxLength={256} disabled={busy} required />
    <button className="button dark" disabled={busy || remaining > 0}>{busy ? <LoaderCircle size={16} className="spin" /> : null}{remaining > 0 ? `${remaining} 秒后可重试` : '进入控制台'}<ArrowUpRight size={16} /></button>
    {error && <div className="form-error" role="alert"><AlertCircle size={14} />{error}</div>}
    {remaining > 0 && <div className="login-note" role="status">登录尝试已达到限制，请等待 {remaining} 秒。</div>}
    <div className="login-note"><LockKeyhole size={12} />你的密钥不会保存在浏览器中</div>
  </form><span className="login-bottom">A PLACE FOR EVERYTHING.</span></div>
}

export function SetupWizard({ onComplete }: { onComplete: (state: SessionState) => void }) {
  const [displayName, setDisplayName] = useState('MONO Storage')
  const [adminPath, setAdminPath] = useState('/admin')
  const [apiToken, setApiToken] = useState('')
  const [showApiToken, setShowApiToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdToken, setCreatedToken] = useState('')
  const [created, setCreated] = useState<SessionState | null>(null)
  const [copied, setCopied] = useState(false)
  const submitting = useRef(false)

  function generate() {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    setApiToken(`mono_${Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join('')}`)
    setShowApiToken(true)
  }

  async function copyToken() {
    try { await navigator.clipboard.writeText(createdToken); setCopied(true) }
    catch { setError('浏览器暂时无法复制，请选中密钥并手动保存。') }
  }

  async function setup(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || created) return
    submitting.current = true; setError(''); setBusy(true)
    try {
      const response = await api<SessionState & { apiToken: string }>('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName, adminPath, apiToken: apiToken || undefined }) })
      const { apiToken: createdApiToken, ...state } = response
      setCreated(state); setCreatedToken(createdApiToken); setApiToken('')
    } catch (error) { setError(error instanceof Error ? error.message : '初始化失败') }
    finally { submitting.current = false; setBusy(false) }
  }

  if (created && createdToken) return <div className="setup-page"><ThemeToggle floating /><div className="setup-brand">MONO<span>OBJECT STORAGE</span></div><div className="setup-card setup-complete">
    <div className="setup-success-icon"><Check size={28} /></div><div className="eyebrow">INSTALLATION COMPLETE</div><h1>存储空间准备好了。</h1><p>请保存管理员密钥，离开此页面后不会再次显示。</p>
    <div className="one-time-token"><div><span>管理员密钥 · 只显示这一次</span><code>{createdToken}</code></div><button className="button" onClick={copyToken}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制密钥'}</button></div>
    <div className="setup-summary"><div><span>后台路径</span><strong>{created.adminPath}</strong></div><div><span>显示名称</span><strong>{created.displayName}</strong></div></div>
    {error && <div className="form-error" role="alert"><AlertCircle size={14} />{error}</div>}
    <button className="button dark setup-enter" onClick={() => onComplete(created)}>进入控制台<ArrowUpRight size={16} /></button>
  </div><span className="setup-bottom">YOUR PRIVATE OBJECT STORAGE.</span></div>

  return <div className="setup-page"><ThemeToggle floating /><div className="setup-brand">MONO<span>OBJECT STORAGE</span></div><form className="setup-card" onSubmit={setup}>
    <div className="setup-icon"><KeyRound size={26} strokeWidth={1.4} /></div><div className="eyebrow">FIRST-TIME INSTALLATION</div><h1>先把这里，变成你的。</h1><p className="setup-lead">设置管理员密钥和后台入口，完成后即可进入存储空间。</p>
    <div className="setup-fields-row"><div className="setup-field"><label htmlFor="display-name">控制台名称</label><input id="display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={80} disabled={busy} required /><span>显示在浏览器标题和工作空间中。</span></div><div className="setup-field"><label htmlFor="admin-path">后台路径</label><input id="admin-path" value={adminPath} onChange={event => setAdminPath(event.target.value)} placeholder="/admin" disabled={busy} required /><span>请收藏这个路径，之后从这里登录。</span></div></div>
    <div className="setup-field"><label htmlFor="api-token">管理员密钥 <em>可选</em></label><div className="secret-input"><input id="api-token" type={showApiToken ? 'text' : 'password'} autoComplete="new-password" placeholder="留空，由系统生成随机密钥" value={apiToken} onChange={event => setApiToken(event.target.value)} minLength={24} maxLength={256} disabled={busy} /><button type="button" className="secret-action" disabled={busy} aria-label={showApiToken ? '隐藏管理员密钥' : '显示管理员密钥'} onClick={() => setShowApiToken(current => !current)}>{showApiToken ? <EyeOff size={15} /> : <Eye size={15} />}</button><button type="button" className="secret-action" disabled={busy} aria-label="生成随机管理员密钥" onClick={generate}><RefreshCw size={15} /></button></div><span>用于后台登录，只显示一次，请保存好。</span></div>
    {error && <div className="form-error" role="alert"><AlertCircle size={14} />{error}</div>}
    <button className="button dark setup-submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存配置并初始化<ArrowUpRight size={16} /></button>
  </form><span className="setup-bottom">YOUR PRIVATE OBJECT STORAGE.</span></div>
}
