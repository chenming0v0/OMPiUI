import { isTauri } from './tauri'

export async function openTailscaleLogin(url: string): Promise<void> {
  if (!url.startsWith('https://login.tailscale.com/')) throw new Error('Invalid Tailscale authorization URL')
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
