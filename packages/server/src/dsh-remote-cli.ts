import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pkg from '../package.json' with { type: 'json' }
import { dataRoot } from './logger.ts'
import { serveDshBrowserHandoff } from './tunnel/dsh-browser-handoff.ts'
import { DSH_REMOTE_ORIGIN, DshRemoteAccount } from './tunnel/dsh-remote-account.ts'
import { openDshBrowser } from './tunnel/dsh-client.ts'
import { dshDeviceId } from './tunnel/dsh-control.ts'

const HELP = `Usage: omp-worker dsh-remote <command>

  Host (this work computer):
  register             Bind the work computer. Reads the one-time host code from stdin.
  status               Show the local host enrollment and whether remote access is enabled.
  revoke               Revoke the host enrollment.

  Client (this device):
  login list           List available sign-in methods on this connection device.
  login <provider>     Sign in as a connection device. Use the same account as the host.
  logout               Revoke this connection device's authorization.
  hosts                List the work computers this device is authorized to access.
  open <host-id>       Open OMPiUI in a browser on this connection device.

Generate a host code at ${DSH_REMOTE_ORIGIN}/app and start the work computer with 'omp-worker web --dsh-remote'.`

async function hostRemoteEnabled(): Promise<boolean> {
  const saved = await readFile(join(dataRoot(), 'dsh-remote', 'enabled.json'), 'utf8').catch(() => undefined)
  return saved === 'true'
}

export async function runDshRemoteCli(args: readonly string[]): Promise<void> {
  const [command, value] = args
  const hostCommand = command === 'register' || command === 'status' || command === 'revoke'
  const clientCommand = command === 'login' || command === 'logout' || command === 'hosts' || command === 'open'
  const expectsValue = command === 'login' || command === 'open'
  if ((!hostCommand && !clientCommand) || args.length !== (expectsValue ? 2 : 1)) {
    console.info(HELP)
    if (args.length && command !== '--help' && command !== '-h') process.exitCode = 1
    return
  }
  const account = new DshRemoteAccount(dataRoot(), pkg.version, fetch, clientCommand ? 'client' : 'host')
  try {
    if (command === 'login') {
      if (value === 'list') {
        for (const provider of await account.listLoginProviders()) console.info(`${provider.id}: ${provider.name}`)
        return
      }
      if ((await account.status()).registered) throw new Error('This connection device is already signed in. Use logout before changing accounts.')
      const qr = await account.startLogin(value)
      console.info(`Authorize this connection device at ${qr.scanUrl}`)
      const signal = AbortSignal.timeout(qr.expiresIn * 1_000)
      while (!signal.aborted) {
        const state = await account.finishLogin(qr.qrId, signal)
        if (state === 'complete') { console.info('This connection device is authorized'); return }
        if (state === 'expired') break
        await delay(2_000, undefined, { signal }).catch(() => undefined)
      }
      throw new Error('DS Harness Remote sign-in expired')
    } else if (command === 'hosts') {
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })
        const page = await account.deviceRequest(`/api/v1/devices?${query}`) as { items?: unknown; nextCursor?: unknown } | null
        if (!Array.isArray(page?.items)) throw new Error('DS Harness Remote returned an invalid host list')
        for (const item of page.items) {
          if (typeof item?.name !== 'string') throw new Error('DS Harness Remote returned an invalid host name')
          console.info(`${dshDeviceId(item.deviceId)}  ${item.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128)}`)
        }
        if (page.nextCursor == null) break
        if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor) || cursors.size >= 200) {
          throw new Error('DS Harness Remote returned an invalid host list cursor')
        }
        cursor = page.nextCursor
        cursors.add(cursor)
      } while (cursor)
    } else if (command === 'open') {
      const stop = new AbortController()
      const interrupt = () => stop.abort()
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      let handoff: Awaited<ReturnType<typeof serveDshBrowserHandoff>> | undefined
      let connection: Awaited<ReturnType<typeof openDshBrowser>> | undefined
      try {
        connection = await openDshBrowser(account, value, stop.signal)
        handoff = await serveDshBrowserHandoff(connection.grant, stop.signal)
        console.info('Open this one-time link in a browser on this device. Keep this process running while using OMPiUI:')
        console.info(handoff.url)
        try { await connection.closed } catch { /* Connection lifetime has ended. */ }
      } finally {
        handoff?.close()
        connection?.close()
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', interrupt)
      }
    } else if (command === 'register') {
      if (process.stdin.isTTY) process.stderr.write('DS Harness Remote host registration code: ')
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
      try {
        const code = await lines[Symbol.asyncIterator]().next()
        if (code.done) throw new Error('No host registration code was provided')
        const { deviceId } = await account.register(code.value)
        console.info(`DS Harness Remote host registered: ${deviceId}. Remote access is not open.`)
      } finally {
        lines.close()
      }
    } else if (command === 'revoke' || command === 'logout') {
      await account.revoke()
      console.info(`DS Harness Remote ${account.role} authorization removed`)
    } else {
      const status = await account.status()
      const enabled = status.registered && await hostRemoteEnabled()
      const state = !status.registered ? 'unregistered' : enabled ? 'enabled' : 'disabled'
      console.info(status.registered
        ? `DS Harness Remote host registered: ${status.deviceId}. state=${state} enabled=${enabled}.`
        : 'No current DS Harness Remote host registration. state=unregistered enabled=false')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'DS Harness Remote authorization failed')
    process.exitCode = 1
  }
}
