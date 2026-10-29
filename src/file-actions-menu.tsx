import { type ReactNode } from 'react'
import { PopupMenu } from './popup-menu'

export function FileActionsMenu({ anchor, children, onClose }: {
  anchor: HTMLButtonElement
  children: ReactNode
  onClose: () => void
}) {
  return <PopupMenu anchor={anchor} onClose={onClose} label="文件操作" className="row-dropdown" align="end">{children}</PopupMenu>
}