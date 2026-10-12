export function retryDelay(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16))
  return Math.round(ceiling * (0.8 + Math.random() * 0.2))
}

export function waitNetworkDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
