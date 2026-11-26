import { DshRemoteAccount } from './dsh-remote-account.ts'
import { DshControl, dshConnectionId, dshDeviceId, parseDshSecure, verifyDshPeer } from './dsh-control.ts'
import { DshNoise, parseDshBrowserGrant, requireDshOmpiuiWeb, type DshBrowserGrant } from '@ompiui/protocol/dsh-remote'

export async function openDshBrowser(account: DshRemoteAccount, hostId: string, signal: AbortSignal): Promise<{
  grant: DshBrowserGrant; closed: Promise<number>; close(): void
}> {
  dshDeviceId(hostId)
  const attempt = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const hostKey = await verifyDshPeer(account, 'host', hostId, attempt)
  const { control, identity } = await DshControl.open(account, signal)
  let noise: DshNoise | undefined
  let connection: string | undefined
  const close = () => {
    // Best effort: let the host release the web lease before this control socket goes away.
    if (noise && connection) {
      try { control.sendSecure(connection, hostId, noise, 'rpc.request', { method: 'dsh.web.close', params: {} }) } catch { /* Closing is best effort. */ }
    }
    noise?.destroy()
    control.close()
  }
  try {
    control.send('connect.request', { hostDeviceId: hostId, preferredTransports: ['relay'] })
    const accepted = await control.next(attempt)
    if (accepted?.type !== 'connect.accepted') throw new Error('The DS Harness Remote host did not accept the connection')
    const connectionId = dshConnectionId(accepted.payload.connectionId)
    connection = connectionId
    noise = new DshNoise(identity, hostKey, connectionId, hostId, identity.deviceId)
    const target = { connectionId, targetDeviceId: hostId }
    control.send('transport.selected', { ...target, transport: 'relay' })
    control.send('secure.handshake', { ...target, step: 1, data: noise.write() })
    let message = await control.next(attempt)
    while (message?.type === 'transport.selected') message = await control.next(attempt)
    if (message?.type !== 'secure.handshake' || message.payload.connectionId !== connectionId
      || message.payload.targetDeviceId !== identity.deviceId || message.payload.step !== 2) throw new Error('The DS Harness Remote host failed the secure handshake')
    noise.read(message.payload.data)
    const channel = noise
    const rpc = async (method: string) => {
      const requestId = control.sendSecure(connectionId, hostId, channel, 'rpc.request', { method, params: {} })
      for (let next = await control.next(attempt); next; next = await control.next(attempt)) {
        if (next.type === 'error' && (next.payload.connectionId === undefined || next.payload.connectionId === connectionId)) break
        if (next.type !== 'relay' || next.payload.connectionId !== connectionId || next.payload.targetDeviceId !== identity.deviceId) continue
        const response = parseDshSecure(channel, next.payload)
        if (response.payload.requestId !== requestId) continue
        if (response.type !== 'rpc.response') throw new Error('The DS Harness Remote host could not open a web tunnel')
        return response.payload.result
      }
      throw new Error('The DS Harness Remote connection ended before the web handoff')
    }
    requireDshOmpiuiWeb(await rpc('harness.transport.describe'))
    const grant = parseDshBrowserGrant(await rpc('dsh.web.open'))
    void (async () => {
      try {
        for (let update = await control.next(signal); update; update = await control.next(signal)) {
          if (update.type === 'error' && (update.payload.connectionId === undefined || update.payload.connectionId === connectionId)) break
        }
      } finally { close() }
    })().catch(() => undefined)
    return { grant, close, closed: control.closed }
  } catch (error) {
    close()
    throw error
  }
}
