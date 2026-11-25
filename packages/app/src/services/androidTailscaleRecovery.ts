import { getAndroidTailscaleStatus, isAndroidTailscalePlatform, isTailnetUrl, type AndroidTailscaleStatus } from '../utils/androidTailscale'
import { APP_RESUMED_EVENT, TAILSCALE_READY_EVENT, TAILSCALE_STATUS_EVENT } from '../utils/tailscaleEvents'
import { serverStore } from '../store/serverStore'

/** 组网恢复独立于设置页；节点就绪后立即更新已保存服务器的连通状态。 */
export function startAndroidTailscaleRecovery(): () => void {
  if (!isAndroidTailscalePlatform()) return () => {}
  let stopped = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let status: AndroidTailscaleStatus | undefined
  const visible = () => document.visibilityState !== 'hidden'
  const poll = async () => {
    clearTimeout(timer)
    if (stopped || pending || !visible()) return
    pending = true
    try {
      status = await getAndroidTailscaleStatus()
    } catch {
      // 具体错误由认证页显示；瞬态失败仍继续恢复已启用的节点。
    } finally {
      pending = false
      if (!stopped && visible()) {
        const connecting = status?.enabled && status.BackendState !== 'Running' && !status.startupInterrupted
        timer = setTimeout(() => void poll(), connecting ? 1_000 : 10_000)
      }
    }
  }
  const resume = () => { void poll() }
  const changed = (event: Event) => {
    status = (event as CustomEvent<AndroidTailscaleStatus>).detail
    resume()
  }
  const ready = () => {
    for (const server of serverStore.getServers()) {
      if (isTailnetUrl(server.url)) void serverStore.checkHealth(server.id)
    }
  }
  window.addEventListener(TAILSCALE_STATUS_EVENT, changed)
  window.addEventListener(TAILSCALE_READY_EVENT, ready)
  window.addEventListener(APP_RESUMED_EVENT, resume)
  window.addEventListener('online', resume)
  document.addEventListener('visibilitychange', resume)
  resume()
  return () => {
    stopped = true
    clearTimeout(timer)
    window.removeEventListener(TAILSCALE_STATUS_EVENT, changed)
    window.removeEventListener(TAILSCALE_READY_EVENT, ready)
    window.removeEventListener(APP_RESUMED_EVENT, resume)
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', resume)
  }
}
