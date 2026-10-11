import { parseConnectLink } from '../store/serverStore'
import { redeemPairCode } from '../omp/transport'

export type ConnectionLink = {
  url: string
  token?: string
  pair?: string
}

/** 支持直接链接、桌面状态行和聊天中复制的 Markdown 链接。 */
export function parseConnectionLink(input: string): ConnectionLink | null {
  const candidates = input.match(/(?:https?:\/\/|(?:ompiui|piui):\/\/connect\?)[^\s<>"`()，。；]+/gi) ?? []
  for (const value of candidates) {
    try {
      const candidate = value.replace(/\]+$/, '')
      const share = parseConnectLink(candidate)
      const url = new URL(share?.url ?? candidate)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      if (share) return { url: share.url, token: share.token }
      const pair = url.searchParams.get('pair')
      if (!pair) continue
      return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, pair }
    } catch {
      // 跳过不是有效认证信息的链接，继续查找后面的链接。
    }
  }
  return null
}

export async function resolveConnectionLink(link: ConnectionLink): Promise<{ url: string; token?: string }> {
  if (link.pair) return redeemPairCode(link.pair, link.url, AbortSignal.timeout(15_000))
  return { url: link.url, token: link.token }
}
