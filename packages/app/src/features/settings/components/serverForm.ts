const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/

/** 显示名长度上限，避免列表项把右侧操作按钮挤穿 */
export const SERVER_NAME_MAX_LENGTH = 40

export function isHttpsIpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    return parsed.protocol === 'https:' && (IPV4_PATTERN.test(hostname) || hostname.includes(':'))
  } catch {
    return false
  }
}

/** 没填名称时，用地址里的主机和端口当显示名。 */
export function hostNameOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
