import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { DshBrowserGrant } from '@ompiui/protocol/dsh-remote'
import { isTauriMobile } from './tauri'

export type DshRemoteViewerCloseReason = 'closed' | 'grant-expired' | 'viewer-timeout' | 'unavailable'
type ViewerEvent = { handoffId: string; reason: DshRemoteViewerCloseReason }

// 安卓上远程页面开在 App 自己里面（DshRemoteViewerBridge.kt）：App 一直在前台，控制连接不会被系统暂停。
type AppViewer = { open(id: string, request: string): void; close(id: string): void }
type AppViewerEvent = { id: string; type: 'delivered' | 'closed'; reason?: DshRemoteViewerCloseReason }
const APP_VIEWER_EVENT = 'ompiui-dsh-viewer'

declare global {
  interface Window {
    __ompiui_dsh_viewer?: AppViewer
  }
}

/** 远程页面是否开在 App 自己里面，而不是交给系统浏览器。 */
export function opensDshRemoteInApp(): boolean {
  return isTauriMobile() && /Android/i.test(navigator.userAgent)
}

async function appViewer(): Promise<AppViewer | undefined> {
  if (!opensDshRemoteInApp()) return undefined
  // 原生接口在页面加载后才挂上来，刚启动时可能要等一下。
  for (let attempt = 0; !window.__ompiui_dsh_viewer && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!window.__ompiui_dsh_viewer) throw new Error('The in-app remote viewer is unavailable')
  return window.__ompiui_dsh_viewer
}

// Native commands can finish out of order. Serialize them within this webview only.
let viewerCommands = Promise.resolve()
function enqueue(command: () => Promise<void>): Promise<void> {
  const next = viewerCommands.then(command)
  viewerCommands = next.catch(() => undefined)
  return next
}

/** Opens the remote page (in the app on Android, else the system browser handoff); does not return proof of redemption. */
export function openDshRemoteViewer(handoffId: string, grant: DshBrowserGrant, signal: AbortSignal,
  labels: { title: string; close: string }): Promise<void> {
  return enqueue(async () => {
    signal.throwIfAborted()
    const viewer = await appViewer()
    signal.throwIfAborted()
    if (viewer) viewer.open(handoffId, JSON.stringify({ ...grant, title: labels.title, closeLabel: labels.close }))
    else await invoke('dsh_remote_viewer_open', { handoffId, grant })
  })
}

/** Stops only this handoff; the caller must also close the authenticated host lease. */
export function closeDshRemoteViewer(handoffId: string): Promise<void> {
  return enqueue(async () => {
    const viewer = await appViewer()
    if (viewer) viewer.close(handoffId)
    else await invoke('dsh_remote_viewer_close', { handoffId })
  })
}

export async function watchDshRemoteViewer(handoffId: string, handlers: {
  closed: (reason: DshRemoteViewerCloseReason) => void; delivered: () => void
}): Promise<UnlistenFn> {
  if (opensDshRemoteInApp()) {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<AppViewerEvent>).detail
      if (detail?.id !== handoffId) return
      if (detail.type === 'delivered') handlers.delivered()
      else handlers.closed(detail.reason ?? 'closed')
    }
    window.addEventListener(APP_VIEWER_EVENT, listener)
    return () => window.removeEventListener(APP_VIEWER_EVENT, listener)
  }
  const webview = getCurrentWebviewWindow()
  const closed = await webview.listen<ViewerEvent>('dsh-remote-viewer-closed', ({ payload }) => {
    if (payload.handoffId === handoffId) handlers.closed(payload.reason)
  })
  try {
    const delivered = await webview.listen<{ handoffId: string }>('dsh-remote-viewer-delivered', ({ payload }) => {
      if (payload.handoffId === handoffId) handlers.delivered()
    })
    return () => { closed(); delivered() }
  } catch (error) {
    closed()
    throw error
  }
}
