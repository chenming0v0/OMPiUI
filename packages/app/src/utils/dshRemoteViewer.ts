import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DshBrowserGrant } from '@ompiui/protocol/dsh-remote'

export type DshRemoteViewerCloseReason = 'closed' | 'grant-expired' | 'viewer-timeout' | 'unavailable'

/** Opens the system browser handoff; does not return proof of redemption. */
export function openDshRemoteViewer(grant: DshBrowserGrant): Promise<void> {
  return invoke('dsh_remote_viewer_open', { grant })
}

/** Stops native handoff; the caller must also close the authenticated host lease. */
export function closeDshRemoteViewer(): Promise<void> {
  return invoke('dsh_remote_viewer_close')
}

export function onDshRemoteViewerClosed(handler: (reason: DshRemoteViewerCloseReason) => void): Promise<UnlistenFn> {
  return listen<DshRemoteViewerCloseReason>('dsh-remote-viewer-closed', event => handler(event.payload))
}
