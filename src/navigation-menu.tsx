import { Check, Code2, Database, HardDrive, Link2, Settings2 } from 'lucide-react'
import type { Bucket } from './api'
import { PopupMenu } from './popup-menu'

export type ConsolePage = 'objects' | 'api' | 'shares' | 'settings'

export const workspacePages = [
  { id: 'objects', label: '对象存储', Icon: HardDrive },
  { id: 'shares', label: '分享链接', Icon: Link2 },
  { id: 'api', label: 'API 访问', Icon: Code2 },
] as const

export const settingsPage = { id: 'settings', label: '设置', Icon: Settings2 } as const
export const consolePages = [...workspacePages, settingsPage] as const

export function NavigationMenu({ anchor, page, buckets, bucket, id, selectionFocusTarget, onNavigate, onOpenBucket, onClose }: {
  anchor: HTMLButtonElement
  page: ConsolePage
  buckets: Bucket[]
  bucket: string
  id: string
  selectionFocusTarget?: HTMLButtonElement | null
  onNavigate: (page: ConsolePage) => void
  onOpenBucket: (name: string) => void
  onClose: () => void
}) {
  function select(action: () => void) {
    onClose()
    action()
    ;(selectionFocusTarget || anchor).focus({ preventScroll: true })
  }

  return <PopupMenu anchor={anchor} onClose={onClose} label="切换页面" className="navigation-menu" align="start" width={238} id={id}>
    <div className="navigation-menu-label" role="presentation">工作空间</div>
    {workspacePages.map(({ id: value, label, Icon }) => <button key={value} type="button" role="menuitem" aria-current={page === value ? 'page' : undefined} onClick={() => select(() => onNavigate(value))}>
      <Icon size={17} strokeWidth={1.6} /><span>{label}</span>{page === value && <Check className="navigation-menu-check" size={16} />}
    </button>)}
    {buckets.length > 0 && <>
      <div className="navigation-menu-divider" role="separator" />
      <div className="navigation-menu-label" role="presentation">存储桶</div>
      {buckets.map(item => <button key={item.name} type="button" role="menuitem" title={item.description || item.name} onClick={() => select(() => onOpenBucket(item.name))}>
        <Database size={17} strokeWidth={1.6} /><span>{item.name}</span>{page === 'objects' && bucket === item.name && <Check className="navigation-menu-check" size={16} />}
      </button>)}
    </>}
    <div className="navigation-menu-divider" role="separator" />
    <button type="button" role="menuitem" aria-current={page === settingsPage.id ? 'page' : undefined} onClick={() => select(() => onNavigate(settingsPage.id))}>
      <settingsPage.Icon size={17} strokeWidth={1.6} /><span>{settingsPage.label}</span>{page === settingsPage.id && <Check className="navigation-menu-check" size={16} />}
    </button>
  </PopupMenu>
}
