import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { DshBrowserGrant } from '@ompiui/protocol/dsh-remote'

export type DshRemoteViewerCloseReason = 'closed' | 'grant-expired' | 'viewer-timeout' | 'unavailable'
type ViewerEvent = { handoffId: string; reason: DshRemoteViewerCloseReason }

// Native commands can finish out of order. Serialize them within this webview only.
let viewerCommands = Promise.resolve()
function enqueue(command: () => Promise<void>): Promise<void> {
  const next = viewerCommands.then(command)
  viewerCommands = next.catch(() => undefined)
  return next
}

/** Opens the system browser handoff; does not return proof of redemption. */
export function openDshRemoteViewer(handoffId: string, grant: DshBrowserGrant, signal: AbortSignal): Promise<void> {
  return enqueue(() => {
    signal.throwIfAborted()
    return invoke('dsh_remote_viewer_open', { handoffId, grant })
  })
}

/** Stops only this handoff; the caller must also close the authenticated host lease. */
export function closeDshRemoteViewer(handoffId: string): Promise<void> {
  return enqueue(() => invoke('dsh_remote_viewer_close', { handoffId }))
}

export async function watchDshRemoteViewer(handoffId: string, handlers: {
  closed: (reason: DshRemoteViewerCloseReason) => void; delivered: () => void
}): Promise<UnlistenFn> {
  const window = getCurrentWebviewWindow()
  const closed = await window.listen<ViewerEvent>('dsh-remote-viewer-closed', ({ payload }) => {
    if (payload.handoffId === handoffId) handlers.closed(payload.reason)
  })
  try {
    const delivered = await window.listen<{ handoffId: string }>('dsh-remote-viewer-delivered', ({ payload }) => {
      if (payload.handoffId === handoffId) handlers.delivered()
    })
    return () => { closed(); delivered() }
  } catch (error) {
    closed()
    throw error
  }
}
