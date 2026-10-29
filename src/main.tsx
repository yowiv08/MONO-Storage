import React, { useEffect, useState, type ComponentType } from 'react'
import ReactDOM from 'react-dom/client'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Login, SetupWizard } from './auth-views'
import { SharedFile } from './public-sharing'
import { api, type SessionState } from './public-api'
import { ThemeProvider, ThemeToggle } from './theme'
import './styles.css'

function Portal() {
  const shared = /^\/s\/([a-f0-9]{32})$/.exec(location.pathname)
  const [session, setSession] = useState<SessionState | null>(null)
  const [setupRequired, setSetupRequired] = useState(false)
  const [Console, setConsole] = useState<ComponentType | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (shared) return
    const controller = new AbortController()
    setError(''); setSession(null)
    const load = async () => {
      if (location.pathname === '/') {
        const setup = await api<{ setupRequired: boolean }>('/api/setup', { signal: controller.signal })
        if (!controller.signal.aborted) { setSetupRequired(setup.setupRequired); setSession({ authenticated: false }) }
        return
      }
      const current = await api<SessionState>('/api/session', { signal: controller.signal })
      if (!controller.signal.aborted) setSession(current)
      if (!current.authenticated) return
      const panel = await api<{ entry: string }>('/api/panel', { signal: controller.signal })
      if (!/^\/api\/panel-assets\/console-[a-zA-Z0-9_-]+\.js$/.test(panel.entry)) throw new Error('暂时无法打开后台。')
      const loaded = await import(/* @vite-ignore */ panel.entry) as { default: ComponentType }
      if (!controller.signal.aborted) setConsole(() => loaded.default)
    }
    load().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '暂时无法打开页面。') })
    return () => controller.abort()
  }, [revision])
  if (shared) return <SharedFile id={shared[1]} />
  if (error) return <div className="startup-error"><ThemeToggle floating /><h1>暂时无法打开页面</h1><p>{error}</p><button className="button dark" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />重试</button></div>
  if (!session || session.authenticated && !Console) return <div className="startup-loading"><span>MONO</span><LoaderCircle size={18} className="spin" /></div>
  if (location.pathname === '/') return setupRequired ? <SetupWizard onComplete={state => { if (state.adminPath) location.assign(state.adminPath) }} /> : <SharedFile />
  if (Console && session.authenticated) return <Console />
  return <><ThemeToggle floating /><Login onLogin={() => setRevision(value => value + 1)} /></>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider><Portal /></ThemeProvider></React.StrictMode>,
)
