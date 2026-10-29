import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function PopupMenu({ anchor, children, onClose, label = '操作菜单', className = '', align = 'end', id, width = 196 }: {
  anchor: HTMLButtonElement
  children: ReactNode
  onClose: () => void
  label?: string
  className?: string
  align?: 'start' | 'end'
  id?: string
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const focusedAnchor = useRef<HTMLButtonElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    function placeMenu() {
      if (!menu || !anchor.isConnected) { closeRef.current(); return }
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const viewportWidth = viewport?.width || document.documentElement.clientWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const edge = 8
      const gap = 6
      const availableHeight = Math.max(0, viewportHeight - edge * 2)
      menu.style.width = `${Math.max(0, Math.min(width, viewportWidth - edge * 2))}px`
      menu.style.maxHeight = `${availableHeight}px`

      const trigger = anchor.getBoundingClientRect()
      const measured = menu.getBoundingClientRect()
      const spaceBelow = viewportTop + viewportHeight - edge - trigger.bottom - gap
      const spaceAbove = trigger.top - gap - viewportTop - edge
      const openAbove = measured.height > spaceBelow && spaceAbove > spaceBelow
      const space = openAbove ? spaceAbove : spaceBelow
      menu.style.maxHeight = `${Math.min(availableHeight, Math.max(space, Math.min(96, availableHeight)))}px`
      const height = menu.getBoundingClientRect().height
      const proposedTop = openAbove ? trigger.top - gap - height : trigger.bottom + gap
      const proposedLeft = align === 'start' ? trigger.left : trigger.right - measured.width
      setPosition({
        top: Math.max(viewportTop + edge, Math.min(proposedTop, viewportTop + viewportHeight - height - edge)),
        left: Math.max(viewportLeft + edge, Math.min(proposedLeft, viewportLeft + viewportWidth - measured.width - edge)),
      })
    }
    function dismissOutside(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && (menu?.contains(target) || anchor.contains(target))) return
      closeRef.current()
    }
    function dismissOnScroll(event: Event) {
      if (event.target instanceof Node && menu?.contains(event.target)) return
      closeRef.current()
    }
    placeMenu()
    document.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('scroll', dismissOnScroll, true)
    window.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('scroll', dismissOnScroll)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', placeMenu)
      window.visualViewport?.removeEventListener('resize', placeMenu)
      window.visualViewport?.removeEventListener('scroll', dismissOnScroll)
    }
  }, [anchor, align, width])

  useLayoutEffect(() => {
    if (!position || focusedAnchor.current === anchor || !ref.current) return
    const current = ref.current.querySelector<HTMLElement>('[role="menuitem"][aria-current="page"]')
    const target = current || ref.current.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')
    target?.focus({ preventScroll: true })
    if (target) {
      const menu = ref.current
      const menuBounds = menu.getBoundingClientRect()
      const targetBounds = target.getBoundingClientRect()
      const visibleTop = menuBounds.top + menu.clientTop + 5
      const visibleBottom = menuBounds.top + menu.clientTop + menu.clientHeight - 5
      if (targetBounds.bottom > visibleBottom) menu.scrollTop += targetBounds.bottom - visibleBottom
      else if (targetBounds.top < visibleTop) menu.scrollTop -= visibleTop - targetBounds.top
    }
    focusedAnchor.current = anchor
  }, [anchor, position])

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      closeRef.current()
      anchor.focus({ preventScroll: true })
      return
    }
    if (event.key === 'Tab') {
      anchor.focus({ preventScroll: true })
      closeRef.current()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])') || [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current === -1 ? event.key === 'ArrowUp' ? items.length - 1 : 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(<div ref={ref} id={id} className={`popup-menu ${className}`.trim()} role="menu" aria-label={label} style={{ position: 'fixed', ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={handleKey} onClick={event => event.stopPropagation()}>{children}</div>, document.body)
}
