import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from 'react'

interface UseVerticalSplitResizeOptions {
  containerRef: RefObject<HTMLElement | null>
  primaryRef: RefObject<HTMLElement | null>
  cssVariableName: `--${string}`
  minPrimaryHeight: number
  minSecondaryHeight: number
  defaultPrimaryHeightRatio?: number
}

interface UseVerticalSplitResizeResult {
  splitHeight: number | null
  isResizing: boolean
  resetSplitHeight: () => void
  handleResizeStart: (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => void
  handleTouchResizeStart: (event: ReactTouchEvent) => void
  adjustSplitHeight: (delta: number) => void
}

export function useVerticalSplitResize({
  containerRef,
  primaryRef,
  cssVariableName,
  minPrimaryHeight,
  minSecondaryHeight,
  defaultPrimaryHeightRatio = 0.4,
}: UseVerticalSplitResizeOptions): UseVerticalSplitResizeResult {
  const [splitHeight, setSplitHeight] = useState<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const rafRef = useRef<number>(0)
  const currentHeightRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (!isResizing && primaryRef.current && splitHeight !== null) {
      primaryRef.current.style.setProperty(cssVariableName, `${splitHeight}px`)
      currentHeightRef.current = splitHeight
    }
  }, [cssVariableName, isResizing, primaryRef, splitHeight])

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  const resetSplitHeight = useCallback(() => {
    setSplitHeight(null)
    currentHeightRef.current = null
  }, [])

  const applyHeight = useCallback(
    (containerHeight: number, startHeight: number, startY: number, currentY: number) => {
      const primaryEl = primaryRef.current
      if (!primaryEl) return

      const deltaY = currentY - startY
      const nextHeight = startHeight + deltaY
      const maxHeight = Math.max(0, containerHeight - minSecondaryHeight)
      const effectiveMinHeight = Math.min(minPrimaryHeight, maxHeight)
      const clampedHeight = Math.min(Math.max(nextHeight, effectiveMinHeight), maxHeight)

      primaryEl.style.setProperty(cssVariableName, `${clampedHeight}px`)
      currentHeightRef.current = clampedHeight
    },
    [cssVariableName, minPrimaryHeight, minSecondaryHeight, primaryRef],
  )

  const finishResize = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    setIsResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''

    if (currentHeightRef.current !== null) {
      setSplitHeight(currentHeightRef.current)
    }
  }, [])

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()

      const container = containerRef.current
      if (!container || !primaryRef.current) return

      // 触摸走 handleTouchResizeStart，避免 pointerdown + touchstart 双重启动
      if ('pointerType' in event && event.pointerType === 'touch') return

      // 指针捕获：即使指针在窗口外释放，pointerup 也会送达分隔条（事件照常冒泡到
      // document 监听），防止 isResizing 永久卡死
      if ('pointerId' in event) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // jsdom 等不支持的环境忽略
        }
      }

      setIsResizing(true)

      const containerRect = container.getBoundingClientRect()
      const startY = event.clientY
      const startHeight = currentHeightRef.current ?? containerRect.height * defaultPrimaryHeightRatio

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
        }

        rafRef.current = requestAnimationFrame(() => {
          applyHeight(containerRect.height, startHeight, startY, moveEvent.clientY)
        })
      }

      const handlePointerUp = () => {
        finishResize()
        document.removeEventListener('pointermove', handlePointerMove)
        document.removeEventListener('pointerup', handlePointerUp)
        document.removeEventListener('pointercancel', handlePointerUp)
      }

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('pointermove', handlePointerMove)
      document.addEventListener('pointerup', handlePointerUp)
      document.addEventListener('pointercancel', handlePointerUp)
    },
    [applyHeight, containerRef, defaultPrimaryHeightRatio, finishResize, primaryRef],
  )

  const handleTouchResizeStart = useCallback(
    (event: ReactTouchEvent) => {
      const container = containerRef.current
      if (!container || !primaryRef.current) return

      setIsResizing(true)

      const containerRect = container.getBoundingClientRect()
      const startY = event.touches[0].clientY
      const startHeight = currentHeightRef.current ?? containerRect.height * defaultPrimaryHeightRatio

      const handleTouchMove = (moveEvent: TouchEvent) => {
        moveEvent.preventDefault()
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
        }

        rafRef.current = requestAnimationFrame(() => {
          applyHeight(containerRect.height, startHeight, startY, moveEvent.touches[0].clientY)
        })
      }

      const handleTouchEnd = () => {
        finishResize()
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
      }

      document.addEventListener('touchmove', handleTouchMove, { passive: false })
      document.addEventListener('touchend', handleTouchEnd)
    },
    [applyHeight, containerRef, defaultPrimaryHeightRatio, finishResize, primaryRef],
  )

  const adjustSplitHeight = useCallback((delta: number) => {
    const container = containerRef.current
    const primary = primaryRef.current
    if (!container || !primary) return
    const containerHeight = container.getBoundingClientRect().height
    const current = currentHeightRef.current ?? primary.getBoundingClientRect().height
    const maxHeight = Math.max(0, containerHeight - minSecondaryHeight)
    const effectiveMinHeight = Math.min(minPrimaryHeight, maxHeight)
    const next = Math.min(Math.max(current + delta, effectiveMinHeight), maxHeight)
    primary.style.setProperty(cssVariableName, `${next}px`)
    currentHeightRef.current = next
    setSplitHeight(next)
  }, [containerRef, cssVariableName, minPrimaryHeight, minSecondaryHeight, primaryRef])

  return {
    splitHeight,
    isResizing,
    resetSplitHeight,
    handleResizeStart,
    handleTouchResizeStart,
    adjustSplitHeight,
  }
}
