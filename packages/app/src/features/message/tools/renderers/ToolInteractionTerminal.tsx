import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { toolInteractionKey, type ToolInteractionDescriptor } from '@ompiui/protocol'
import { MaximizeIcon, MinimizeIcon } from '../../../../components/Icons'
import { createTerminalViewport } from '../../../../components/terminalViewport'
import { useFullscreen } from '../../../../contexts'
import { useInputCapabilities } from '../../../../hooks/useInputCapabilities'
import { openPiSocket, type PiSocket } from '../../../../omp/ompSocket'
import {
  getToolInteractionInput, issueToolInteractionTicket, parseToolInteractionFrame, toolInteractionWebSocketUrl,
} from '../../../../omp/toolInteraction'

const EXTRA_KEYS = [
  ['Enter', '\r'], ['Ctrl+C', '\x03'], ['Tab', '\t'], ['Esc', '\x1b'],
  ['←', '\x1b[D'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['→', '\x1b[C'],
] as const

/** Moves a single stable portal target, not its xterm/controller, between inline and fullscreen hosts. */
function ViewportHost({ container, fullHeight = false }: { container: HTMLElement; fullHeight?: boolean }) {
  const attach = useCallback((host: HTMLDivElement | null) => { if (host) host.appendChild(container) }, [container])
  return <div ref={attach} className={fullHeight ? 'h-full min-h-0 p-4' : 'min-h-0'} />
}

export function ToolInteractionTerminal({ descriptor, serverId, readOnly = false, onFullscreenChange }: {
  descriptor: ToolInteractionDescriptor
  serverId: string
  readOnly?: boolean
  onFullscreenChange?: (open: boolean) => void
}) {
  const { t } = useTranslation('message')
  const { preferTouchUi } = useInputCapabilities()
  const [container] = useState(() => document.createElement('div'))
  const [notice, setNotice] = useState<string | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected' | 'closed'>('connecting')
  const [exited, setExited] = useState(descriptor.status === 'exited')
  const input = useMemo(() => getToolInteractionInput(serverId, descriptor), [serverId, descriptor.runtimeId, descriptor.sessionId, descriptor.toolCallId, descriptor.executionId])
  const inputState = useSyncExternalStore(input.subscribe, input.getSnapshot)
  const viewportRef = useRef<ReturnType<typeof createTerminalViewport> | null>(null)
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const descriptorRef = useRef(descriptor)
  descriptorRef.current = descriptor
  const fullscreenId = `tool-interaction:${serverId}:${toolInteractionKey(descriptor)}`
  const { activeId, openFullscreen, closeFullscreen } = useFullscreen()
  const fullscreen = activeId === fullscreenId

  useEffect(() => {
    onFullscreenChange?.(fullscreen)
    return () => { if (fullscreen) onFullscreenChange?.(false) }
  }, [fullscreen, onFullscreenChange])
  useEffect(() => () => closeFullscreen(fullscreenId), [closeFullscreen, fullscreenId])

  const sendInput = useCallback((text: string) => {
    if (readOnlyRef.current) return
    const result = input.enqueue(text)
    setNotice(result === 'queued' ? null : result === 'full' ? 'inputFull' : 'inputNotSent')
  }, [input])

  useEffect(() => {
    let active = true
    let socket: PiSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    let cursor: number | undefined
    let expectedCursor: number | undefined
    let finalCursor: number | undefined = descriptorRef.current.status === 'exited' ? descriptorRef.current.cursor : undefined
    let attempts = 0
    let drain = Promise.resolve()
    let socketGeneration = 0
    const viewport = createTerminalViewport(container.querySelector('[data-tool-terminal-viewport]') as HTMLElement,
      preferTouchUi, sendInput, (cols, rows) => { if (!readOnlyRef.current) input.resize(cols, rows) })
    viewportRef.current = viewport
    // xterm handles Escape first. Only actual terminal key events are isolated from global modal shortcuts.
    const isolateEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && event.target === viewport.terminal.textarea) event.stopPropagation()
    }
    container.addEventListener('keydown', isolateEscape)

    const scheduleReconnect = () => {
      clearTimeout(watchdog)
      input.disconnect()
      if (!active) return
      if (finalCursor !== undefined && cursor === finalCursor) { setConnection('closed'); return }
      if (attempts >= 4) { input.pause(); setConnection('disconnected'); setNotice('connectionLost'); return }
      setConnection('connecting')
      reconnectTimer = setTimeout(() => { void connect() }, Math.min(8000, 500 * 2 ** attempts++))
    }
    const connect = async () => {
      const generation = ++socketGeneration
      try {
        // Resume only the output actually parsed by this viewport, including the last socket's tail.
        await drain
        if (!active) return
        expectedCursor = cursor
        const ticket = await issueToolInteractionTicket(descriptorRef.current, abort.signal)
        if (!active || generation !== socketGeneration) return
        const current = openPiSocket(toolInteractionWebSocketUrl(descriptorRef.current, ticket.ticket, cursor))
        socket = current
        watchdog = setTimeout(() => current.close(4008, 'Tool stream hello timed out'), 10_000)
        current.onclose = () => { if (active && socket === current) scheduleReconnect() }
        current.onerror = () => { /* close drives bounded recovery; bridge has its own open watchdog */ }
        current.onmessage = event => {
          if (!active || socket !== current || typeof event.data !== 'string') return
          let parsed: unknown
          try { parsed = JSON.parse(event.data) } catch { current.close(4002, 'Invalid tool frame'); return }
          event.annotateTraffic?.(parsed)
          const frame = parseToolInteractionFrame(parsed)
          if (!frame) { current.close(4002, 'Invalid tool frame'); return }
          if (frame.type === 'hello') {
            if (toolInteractionKey(frame.descriptor) !== toolInteractionKey(descriptorRef.current)) {
              setNotice('identityMismatch'); input.pause(); current.onclose = null; current.close(); setConnection('disconnected'); return
            }
            clearTimeout(watchdog)
            setConnection('connected')
            if (frame.descriptor.status === 'exited') { finalCursor = frame.descriptor.cursor; setExited(true); input.close() }
            input.connect(current)
            return
          }
          if (frame.type === 'lease') { input.lease(frame.lease); if (input.state === 'writer') setNotice(null); viewport.fit(); return }
          if (frame.type === 'input_ack') { input.acknowledge(frame.sequence, frame.lastAcceptedSequence); return }
          if (frame.type === 'problem') {
            input.pause()
            setNotice('inputPaused')
            // Runtime/identity/expired executions cannot be revived by another ticket.
            if (/NOT_FOUND|RUNTIME|STALE|EXITED|IDENTITY/.test(frame.code)) {
              current.onclose = null; current.close(); setConnection('disconnected')
            }
            return
          }
          if (frame.type === 'exit') {
            if (toolInteractionKey(frame.descriptor) !== toolInteractionKey(descriptorRef.current)) return
            finalCursor = frame.descriptor.cursor
            setExited(true)
            input.close()
            void drain.then(() => {
              if (active && socket === current && cursor === finalCursor) {
                current.onclose = null; current.close(); setConnection('closed')
              }
            })
            return
          }
          if (!frame.reset && expectedCursor !== undefined && frame.cursor <= expectedCursor) {
            void drain.then(() => { if (active && socket === current) input.send({ type: 'output_ack', cursor: cursor! }) })
            return
          }
          if (!frame.reset && expectedCursor !== undefined && frame.fromCursor !== expectedCursor) {
            current.close(4008, 'Tool output cursor gap'); return
          }
          expectedCursor = frame.cursor
          drain = drain.then(() => new Promise<void>(resolve => {
            if (!active) { resolve(); return }
            if (frame.reset) { viewport.terminal.reset(); setNotice('replayReset') }
            viewport.terminal.write(frame.data, () => {
              cursor = frame.cursor
              // ACK uses the originating socket, never a newly attached controller.
              if (active && socket === current) {
                try { current.send(JSON.stringify({ type: 'output_ack', cursor })) } catch { /* reconnect from committed cursor */ }
                if (finalCursor !== undefined && cursor === finalCursor) {
                  current.onclose = null; current.close(); setConnection('closed')
                }
              }
              resolve()
            })
          }))
        }
      } catch (error) {
        if (!active) return
        const status = (error as { status?: number }).status
        if (status === 404 || status === 409 || status === 410 || status === 401 || status === 403) {
          input.pause(); setConnection('disconnected'); setNotice('unavailable'); return
        }
        scheduleReconnect()
      }
    }
    void connect()
    return () => {
      active = false
      abort.abort()
      clearTimeout(reconnectTimer); clearTimeout(watchdog)
      if (socket) { socket.onclose = null; socket.onmessage = null; socket.close() }
      input.disconnect() // View detach is neither release nor process cancellation.
      container.removeEventListener('keydown', isolateEscape)
      viewportRef.current = null
      viewport.dispose()
    }
  }, [container, input, preferTouchUi, sendInput])

  const canWrite = !readOnly && !exited && inputState === 'writer' && connection === 'connected'
  useEffect(() => {
    if (readOnly || exited) input.close()
    if (viewportRef.current) viewportRef.current.terminal.options.disableStdin = !canWrite
  }, [canWrite, exited, input, readOnly])
  useLayoutEffect(() => {
    container.className = fullscreen ? 'h-full min-h-0' : 'min-h-0'
    viewportRef.current?.fit()
  }, [container, fullscreen])

  const toggleFullscreen = () => {
    if (fullscreen) closeFullscreen(fullscreenId)
    // A new host also handles reopening during the modal's close animation; the portal target stays stable.
    else openFullscreen({ id: fullscreenId, showHeader: false, content: <ViewportHost key={crypto.randomUUID()} container={container} fullHeight /> })
  }
  const actionClass = 'rounded px-2 py-1 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200/60 disabled:opacity-40 disabled:cursor-not-allowed'
  let actions: ReactNode = null
  if (!readOnly && !exited) actions = <>
    {inputState === 'writer' ? <button type="button" className={actionClass} disabled={input.pendingBytes > 0} onClick={() => input.release()}>{t('toolInteraction.release')}</button>
      : <button type="button" className={actionClass} disabled={connection !== 'connected' || inputState === 'reconnecting'} onClick={() => { input.claim(); setNotice(null) }}>{t('toolInteraction.claim')}</button>}
    <button type="button" className={actionClass} disabled={!canWrite} onClick={() => input.cancel()}>{t('toolInteraction.cancel')}</button>
  </>

  return <>
    {!fullscreen && <ViewportHost key="inline" container={container} />}
    {fullscreen && <div className="h-10" aria-hidden="true" />}
    {createPortal(<div className="flex h-full min-h-0 flex-col bg-bg-100 font-mono" data-tool-interaction={descriptor.executionId}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 pb-1">
        {actions}
        <button type="button" className={actionClass} onClick={toggleFullscreen} aria-label={t(fullscreen ? 'toolInteraction.exitFullscreen' : 'toolInteraction.fullscreen')}>
          {fullscreen ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
      </div>
      <div data-tool-terminal-viewport className={fullscreen ? 'min-h-0 flex-1' : 'h-72 min-h-0'} aria-label={t('toolInteraction.terminal')} />
      <div className="flex shrink-0 flex-wrap gap-1 pt-1">
        {EXTRA_KEYS.map(([label, data]) => <button key={label} type="button" className={actionClass} disabled={!canWrite}
          onPointerDown={event => event.preventDefault()} onClick={() => { sendInput(data); viewportRef.current?.terminal.focus() }}>{label}</button>)}
      </div>
      {notice && <div role="status" className="shrink-0 pt-1 text-[length:var(--fs-xs)] text-text-500">{t(`toolInteraction.${notice}`)}</div>}
      {inputState === 'paused' && input.pendingBytes > 0 && <button type="button" className={actionClass} onClick={() => input.discardPending()}>{t('toolInteraction.discardPending')}</button>}
    </div>, container)}
  </>
}
