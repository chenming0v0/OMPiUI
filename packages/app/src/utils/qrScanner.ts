type ScannerBridge = { scan(id: string, prompt: string): void }
type ScanResult = { id: string; contents?: string; error?: string }

declare global {
  interface Window {
    __ompiui_qr_scanner?: ScannerBridge
  }
}

export async function scanPairingQr(prompt: string): Promise<string | null> {
  for (let attempt = 0; !window.__ompiui_qr_scanner && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const bridge = window.__ompiui_qr_scanner
  if (!bridge) throw new Error('scanUnavailable')
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ScanResult>).detail
      if (detail.id !== id) return
      window.removeEventListener('ompiui-qr-result', listener)
      if (detail.error) reject(new Error(detail.error))
      else resolve(detail.contents ?? null)
    }
    window.addEventListener('ompiui-qr-result', listener)
    try {
      bridge.scan(id, prompt)
    } catch (error) {
      window.removeEventListener('ompiui-qr-result', listener)
      reject(error)
    }
  })
}
