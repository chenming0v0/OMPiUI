import { isTauri } from './tauri'
import { isAndroidTailscalePlatform, openAndroidTailscaleLogin } from './androidTailscale'

/**
 * 授权链接来自本机 tsnet 或自建控制服务器（Headscale 等），
 * 只要求 https 且不含用户信息，不再锁死 login.tailscale.com。
 */
export function isValidTailscaleAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

export async function openTailscaleLogin(url: string): Promise<void> {
  if (!isValidTailscaleAuthUrl(url)) throw new Error('Invalid Tailscale authorization URL')
  if (isAndroidTailscalePlatform()) {
    await openAndroidTailscaleLogin(url)
  } else if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
