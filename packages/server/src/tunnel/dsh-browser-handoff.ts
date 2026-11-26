import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { DshBrowserGrant } from '@ompiui/protocol/dsh-remote'

// Only the already authenticated connector can hand the grant to a browser.
// The local page never receives the DS Harness account or device credentials.
export async function serveDshBrowserHandoff(grant: DshBrowserGrant, signal: AbortSignal): Promise<{ url: string; close(): void }> {
  signal.throwIfAborted()
  const id = randomBytes(24).toString('base64url')
  const nonce = randomBytes(16).toString('base64url')
  const origin = new URL(grant.url).origin
  const path = `/${id}`
  let host = ''
  let delivered = false
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.headers.host !== host || req.url !== path || delivered || grant.expiresAt <= Date.now()) {
      res.writeHead(404, { 'cache-control': 'no-store' }).end()
      return
    }
    delivered = true
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      'x-content-type-options': 'nosniff',
    }).end(`<!doctype html><meta charset="utf-8"><title>OMPiUI · DS Harness Remote</title>
<h1>打开 OMPiUI 远程工作台</h1>
<button type="button" id="open">打开 OMPiUI</button><p id="status" role="status">请在授权过期前打开。</p>
<script nonce="${nonce}">
const target = ${JSON.stringify(origin)};
const expiresAt = ${grant.expiresAt};
let grant = ${JSON.stringify(grant.browserGrant)};
let popup;
const button = document.getElementById('open');
const status = document.getElementById('status');
const expire = setTimeout(() => { grant = ''; button.disabled = true; status.textContent = '授权已过期。'; }, Math.max(0, expiresAt - Date.now()));
window.addEventListener('message', event => {
  if (!grant || Date.now() >= expiresAt || event.source !== popup || event.origin !== target || event.data !== 'dsh.web.ready') return;
  popup.postMessage({ type: 'dsh.web.grant', browserGrant: grant }, target);
  grant = '';
  clearTimeout(expire);
  button.disabled = true;
  status.textContent = '已将一次性授权交给远程工作台。';
});
button.addEventListener('click', () => {
  if (!grant || Date.now() >= expiresAt) return;
  if (popup && !popup.closed) { popup.focus(); return; }
  popup = window.open(target + '/__remote/browser', '_blank');
  status.textContent = popup ? '等待远程工作台完成授权…' : '请允许打开弹窗后重试。';
});
</script>`)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  const close = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', close)
    server.close()
    server.closeAllConnections()
  }
  const timer = setTimeout(close, Math.max(0, grant.expiresAt - Date.now()))
  timer.unref()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    signal.throwIfAborted()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Browser handoff is unavailable')
    host = `127.0.0.1:${address.port}`
    signal.addEventListener('abort', close, { once: true })
    return { url: `http://${host}${path}`, close }
  } catch (error) {
    close()
    throw error
  }
}
