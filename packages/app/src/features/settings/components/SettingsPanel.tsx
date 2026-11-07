import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import './settingsPanel.css'

const FooterTargetContext = createContext<{
  target: HTMLDivElement | null
  scrollRef: RefObject<HTMLDivElement | null>
} | null>(null)

interface SettingsPanelProps {
  id: string
  labelledBy: string
  scrollRef: RefObject<HTMLDivElement | null>
  scrollClassName: string
  children: ReactNode
}

/** 内容与操作栏分别占据布局空间，滚动列表不会穿过操作栏。 */
export function SettingsPanel({ id, labelledBy, scrollRef, scrollClassName, children }: SettingsPanelProps) {
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null)
  const footerContext = useMemo(() => ({ target: footerTarget, scrollRef }), [footerTarget, scrollRef])

  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <FooterTargetContext.Provider value={footerContext}>
        <div ref={scrollRef} className={scrollClassName}>
          {children}
        </div>
      </FooterTargetContext.Provider>
      <div ref={setFooterTarget} className="shrink-0" />
    </div>
  )
}

type FooterPlacement = {
  mode: 'stationary' | 'floating' | 'docked'
  x: number
  y: number
  width: number
  height: number
}

export function SettingsPanelFooter({ children, dock = false, visible = true }: {
  children: ReactNode
  dock?: boolean
  visible?: boolean
}) {
  const context = useContext(FooterTargetContext)
  const anchorRef = useRef<HTMLDivElement>(null)
  const positionRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<FooterPlacement>({ mode: 'stationary', x: 0, y: 0, width: 0, height: 0 })
  const placementRef = useRef(placement)
  const originRef = useRef<DOMRect | null>(null)
  const animationRef = useRef<Animation | null>(null)

  useLayoutEffect(() => {
    const scroll = context?.scrollRef.current
    const position = positionRef.current
    const bar = barRef.current
    const reserve = position?.parentElement
    if (!context?.target || !scroll || !position || !bar || !reserve || !visible) return

    let frame: number | null = null
    let firstUpdate = true
    const update = () => {
      frame = null
      const next: FooterPlacement = { mode: 'stationary', x: 0, y: 0, width: 0, height: bar.offsetHeight }
      const anchor = anchorRef.current
      if (dock && anchor) {
        const anchorRect = anchor.getBoundingClientRect()
        const reserveRect = reserve.getBoundingClientRect()
        next.mode = anchorRect.bottom <= scroll.getBoundingClientRect().bottom ? 'docked' : 'floating'
        next.width = anchorRect.width
        next.x = anchorRect.left - reserveRect.left
        // 归位时底部占位收为零，以不随占位高度变化的底边计算位置。
        if (next.mode === 'docked') next.y = anchorRect.top - reserveRect.bottom
      }
      const previous = placementRef.current
      if (!firstUpdate && previous.mode !== next.mode) originRef.current = bar.getBoundingClientRect()
      firstUpdate = false
      if (previous.mode === next.mode && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height) return
      placementRef.current = next
      setPlacement(next)
    }
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(update)
    }

    update()
    scroll.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(scroll)
    observer.observe(bar)
    if (anchorRef.current?.parentElement) observer.observe(anchorRef.current.parentElement)

    return () => {
      scroll.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      animationRef.current?.cancel()
      originRef.current = null
    }
  }, [context, dock, visible])

  // 外层随滚动定位，内层仅在悬浮与归位切换时播放位移动画。
  useLayoutEffect(() => {
    const origin = originRef.current
    const bar = barRef.current
    originRef.current = null
    if (!origin || !bar || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    animationRef.current?.cancel()
    const destination = bar.getBoundingClientRect()
    animationRef.current = bar.animate([
      { transform: `translate(${origin.left - destination.left}px, ${origin.top - destination.top}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }, [placement.mode])

  if (!context?.target) return visible ? children : null

  return (
    <>
      {dock && <div ref={anchorRef} className="settings-panel-footer-anchor" style={{ height: placement.height }} aria-hidden="true" />}
      {createPortal(
        <div className="settings-panel-footer-reserve" data-dock={dock} data-mode={dock ? placement.mode : 'stationary'} hidden={!visible}>
          <div
            ref={positionRef}
            className="settings-panel-footer-position"
            style={dock && placement.width > 0 ? { width: placement.width, transform: `translate(${placement.x}px, ${placement.y}px)` } : undefined}
          >
            <div ref={barRef} className="settings-panel-footer-bar" data-mode={dock ? placement.mode : 'stationary'}>
              {children}
            </div>
          </div>
        </div>,
        context.target,
      )}
    </>
  )
}
