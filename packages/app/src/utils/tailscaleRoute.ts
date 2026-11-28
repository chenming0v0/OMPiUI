import { isAndroidTailscalePlatform, isTailnetUrl, resolveAndroidTailscaleUrl } from './androidTailscale'
import { isDesktopTailscalePlatform, resolveDesktopTailscaleUrl } from './desktopTailscale'

/**
 * 发请求前把 Tailnet 地址映射到应用内置节点的回环路由。
 * 手机走原生桥，桌面走本机后端；浏览器和非 Tailnet 地址原样返回。
 */
export async function resolveTailscaleUrl(input: string): Promise<string> {
  if (!isTailnetUrl(input)) return input
  if (isAndroidTailscalePlatform()) return resolveAndroidTailscaleUrl(input)
  if (isDesktopTailscalePlatform()) return resolveDesktopTailscaleUrl(input)
  return input
}
