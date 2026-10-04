/**
 * OMP 子代理进度数值的紧凑展示（HUD 行与 TaskRenderer/SubSessionView 共用）。
 */

/** OMP 给每个子代理注入的包装提示词，不能当会话标题。 */
const WRAPPING_ASSIGNMENT = /^complete assignment thoroughly\b/i

/** 取第一个能当标题的候选：非空、非包装提示词，只留首行。 */
export function subagentDisplayTitle(...candidates: Array<string | undefined | null>): string | undefined {
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    const line = value.split('\n').map(part => part.trim()).find(Boolean)
    if (!line || WRAPPING_ASSIGNMENT.test(line)) continue
    return line
  }
  return undefined
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatCompactDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}
