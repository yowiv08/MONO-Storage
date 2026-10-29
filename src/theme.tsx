import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'

type Theme = 'light' | 'dark'
const preferenceKey = 'mono-theme'

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(preferenceKey)
    return value === 'light' || value === 'dark' ? value : null
  } catch { return null }
}

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme | null>(savedTheme)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = preference || (systemDark ? 'dark' : 'light')

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const updateSystem = () => setSystemDark(media.matches)
    const updatePreference = (event: StorageEvent) => {
      if (event.key === preferenceKey || event.key === null) setPreference(savedTheme())
    }
    media.addEventListener('change', updateSystem)
    window.addEventListener('storage', updatePreference)
    return () => {
      media.removeEventListener('change', updateSystem)
      window.removeEventListener('storage', updatePreference)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.documentElement.style.removeProperty('background-color')
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17191d' : '#fafafa')
  }, [theme])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setPreference(next)
    try { localStorage.setItem(preferenceKey, next) } catch { }
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}

export function ThemeToggle({ floating = false }: { floating?: boolean }) {
  const context = useContext(ThemeContext)
  if (!context) return null
  const dark = context.theme === 'dark'
  const label = `切换到${dark ? '白天' : '黑夜'}模式`
  return <button type="button" className={`theme-toggle${floating ? ' theme-toggle-floating' : ''}`} aria-label={label} title={label} onClick={context.toggle}>
    {dark ? <Sun size={17} strokeWidth={1.7} aria-hidden="true" /> : <Moon size={17} strokeWidth={1.7} aria-hidden="true" />}
  </button>
}
