import { setTimeout as delay } from 'node:timers/promises'
import { DshRemoteAccount } from './dsh-remote-account.ts'
import { DshControl, type DshControlSocketFactory, dshConnectionId, dshDeviceId, parseDshSecure, verifyDshPeer } from './dsh-control.ts'
import { DSH_WEB_LEASE_ENDED, DshNoise, isDshWebLeaseEnd, parseDshBrowserGrant, requireDshOmpiuiWeb, type DshBrowserGrant, type DshWebLeaseEnd } from '@ompiui/protocol/dsh-remote'

export async function openDshBrowser(account: DshRemoteAccount, hostId: string, signal: AbortSignal, socketFactory?: DshControlSocketFactory): Promise<{
  grant: DshBrowserGrant; closed: Promise<DshWebLeaseEnd | undefined>; close(): Promise<void>
}> {
  dshDeviceId(hostId)
  const attempt = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const hostKey = await verifyDshPeer(account, 'host', hostId, attempt)
  // Once established, caller cancellation closes the lease before killing the socket.
  const lifetime = new AbortController()
  const abortConnect = () => lifetime.abort(attempt.reason)
  attempt.addEventListener('abort', abortConnect, { once: true })
  if (attempt.aborted) abortConnect()
  const { control, identity } = await DshControl.open(account, lifetime.signal, undefined, socketFactory).catch(error => {
    attempt.removeEventListener('abort', abortConnect)
    throw error
  })
  let noise: DshNoise | undefined
  const closeWire = () => { noise?.destroy(); noise = undefined; control.close() }
  try {
    attempt.throwIfAborted()
    control.send('connect.request', { hostDeviceId: hostId, preferredTransports: ['relay'] })
    const accepted = await control.next(attempt)
    if (accepted?.type !== 'connect.accepted') throw new Error('The DS Harness Remote host did not accept the connection')
    const connectionId = dshConnectionId(accepted.payload.connectionId)
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
        return { id: requestId, result: response.payload.result }
      }
      throw new Error('The DS Harness Remote connection ended before the web handoff')
    }
    requireDshOmpiuiWeb((await rpc('harness.transport.describe')).result)
    const lease = await rpc('dsh.web.open')
    const grant = parseDshBrowserGrant(lease.result)
    attempt.removeEventListener('abort', abortConnect)
    let closeRequest: string | undefined
    let closing: Promise<void> | undefined
    const abort = () => { void close() }
    const closed = (async (): Promise<DshWebLeaseEnd | undefined> => {
      try {
        for (let update = await control.next(lifetime.signal); update; update = await control.next(lifetime.signal)) {
          if (update.type === 'error' && (update.payload.connectionId === undefined || update.payload.connectionId === connectionId)) break
          if (update.type !== 'relay' || update.payload.connectionId !== connectionId || update.payload.targetDeviceId !== identity.deviceId) continue
          const response = parseDshSecure(channel, update.payload)
          if (response.type === DSH_WEB_LEASE_ENDED && response.payload.requestId === lease.id && isDshWebLeaseEnd(response.payload.reason)) return response.payload.reason
          if (closeRequest && response.payload.requestId === closeRequest && ['rpc.response', 'rpc.error'].includes(response.type)) break
        }
      } catch { /* The control transport ended. */ }
      finally { signal.removeEventListener('abort', abort); closeWire() }
    })()
    const close = () => closing ??= (async () => {
      try {
        closeRequest = control.sendSecure(connectionId, hostId, channel, 'rpc.request', { method: 'dsh.web.close', params: {} })
        await Promise.race([closed, delay(1_500, undefined, { ref: false })])
      } catch { /* The control socket may already be down. */ }
      finally { closeWire() }
    })()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return { grant, close, closed }
  } catch (error) {
    attempt.removeEventListener('abort', abortConnect)
    closeWire()
    throw error
  }
}
