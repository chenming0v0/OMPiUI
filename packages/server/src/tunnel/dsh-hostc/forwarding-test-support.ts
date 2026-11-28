import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createAppServer } from '../../http.ts'
import { PairingStore } from '../../host/pairing.ts'
import type { TerminalManagerOptions } from '../../host/terminal-manager.ts'
import { attachEventWebSocket, closeEventWebSocket } from '../../ws.ts'
import { Connection } from './connection.ts'
import { openDshHostc, type DshHostcTransport } from './index.ts'
import { decodeFrame, decodeHead, encodeFrame, encodeOpen, encodeText, FrameType,
  type Frame, type HeaderList, type OpenMessage } from './protocol/index.ts'

export const LOCAL_TOKEN = 'computer-permanent-token-for-ci'
export const PUBLIC_HOST = 'tabcdefghjkm.tun.4ba.io'
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`

// 使用确定性 PTY 替身；HTTP、WebSocket、终端归属和一次性 ticket 都走生产实现。
const terminalSpawn: NonNullable<TerminalManagerOptions['spawn']> = (_file, _args, options) => {
  const size = options as { cols: number; rows: number }
  const exits = new Set<(event: { exitCode: number }) => void>()
  let alive = true
  return {
    pid: 0, cols: size.cols, rows: size.rows,
    write() {}, resize() {},
    kill() {
      if (!alive) return
      alive = false
      for (const exit of exits) exit({ exitCode: 0 })
    },
    onData() { return { dispose() {} } },
    onExit(callback) { exits.add(callback); return { dispose() { exits.delete(callback) } } },
  }
}

export async function forwardingFixture(t: TestContext, options: { authToken?: string } = { authToken: LOCAL_TOKEN }) {
  const directory = await mkdtemp(join(tmpdir(), 'ompiui-hostc-auth-'))
  const previousDataDir = process.env.OMPIUI_DATA_DIR
  process.env.OMPIUI_DATA_DIR = directory
  const app = createAppServer({ authToken: LOCAL_TOKEN, pairing: new PairingStore(), terminalSpawn,
    share: { host: '127.0.0.1', port: 8787 }, notificationsFile: join(directory, 'notifications.json') })
  const events = attachEventWebSocket(app.server, { authToken: LOCAL_TOKEN, eventHub: app.eventHub, terminalManager: app.terminals })
  const observed: { path: string; headers: IncomingHttpHeaders }[] = []
  for (const event of ['request', 'upgrade'] as const) {
    app.server.prependListener(event, (request: IncomingMessage) => observed.push({ path: request.url ?? '', headers: { ...request.headers } }))
  }
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let transport: DshHostcTransport | undefined
  t.after(async () => {
    transport?.close()
    for (const socket of relay.clients) socket.terminate()
    await transport?.closed
    await new Promise<void>(resolve => relay.close(() => resolve()))
    await new Promise<void>(resolve => closeEventWebSocket(events, () => resolve()))
    app.server.closeAllConnections()
    await app.dispose()
    if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  })
  await once(relay, 'listening')
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const local = app.server.address()
  const remote = relay.address()
  assert.ok(local && typeof local !== 'string' && remote && typeof remote !== 'string')
  const pending: Frame[] = []
  const returned: Frame[] = []
  const hooks: unknown[] = []
  const available = new EventEmitter()
  const connected = once(relay, 'connection')
  relay.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${'b'.repeat(43)}`)
    socket.on('message', (data, binary) => {
      if (!binary) return
      const frame = decodeFrame(Array.isArray(data) ? Buffer.concat(data)
        : data instanceof ArrayBuffer ? new Uint8Array(data) : data)
      pending.push(frame)
      returned.push(frame)
      available.emit('frame')
    })
  })
  // 只替换外部中转拨号地址；保留 openDshHostc 的策略和真实回环 HTTP/WS 转发。
  const dial = Connection.open
  t.mock.method(Connection, 'open', (options: Parameters<typeof dial>[0], signal?: AbortSignal) => {
    assert.equal(options.target.href, `http://127.0.0.1:${local.port}/`)
    return dial({ ...options, tunnel: { ...options.tunnel, connectUrl: `ws://127.0.0.1:${remote.port}` } }, signal)
  })
  const admission = { allowed: true }
  transport = await openDshHostc({
    localPort: local.port, authToken: options.authToken,
    lease: { id: 'tabcdefghjkm', url: `${PUBLIC_ORIGIN}/`, token: 'b'.repeat(43),
      connectUrl: 'wss://tun.4ba.io/api/tunnels/tabcdefghjkm/connect' },
    admit: () => admission.allowed,
    onOpen: entry => { hooks.push(entry) }, onClose: entry => { hooks.push(entry) },
    onRequest: entry => { hooks.push(entry) },
  })
  const [wire] = await connected as [WebSocket]
  let sequence = 0
  const next = async (id: number, type?: FrameType): Promise<Frame> => {
    const signal = AbortSignal.timeout(5_000)
    for (;;) {
      const index = pending.findIndex(frame => frame.stream === id && (type === undefined || frame.type === type || frame.type === FrameType.Reset))
      if (index >= 0) {
        const [frame] = pending.splice(index, 1)
        assert.ok(frame)
        assert.notEqual(frame.type, FrameType.Reset, Buffer.from(frame.payload).toString())
        return frame
      }
      await once(available, 'frame', { signal })
    }
  }
  const send = (id: number, type: FrameType, payload?: Uint8Array) => wire.send(encodeFrame(type, id, payload))
  const open = (path: string, headers: HeaderList, websocket?: string[], body?: unknown) => {
    const id = ++sequence
    const message: OpenMessage = { method: body === undefined ? 'GET' : 'POST', path, headers, body: body !== undefined, websocket }
    send(id, FrameType.Open, encodeOpen(message))
    if (body !== undefined) {
      send(id, FrameType.Data, encodeText(JSON.stringify(body)))
      send(id, FrameType.End)
    }
    return id
  }
  const http = async (path: string, headers: HeaderList, body?: unknown) => {
    const id = open(path, headers, undefined, body)
    const head = decodeHead((await next(id, FrameType.Head)).payload)
    const chunks: Buffer[] = []
    if (head.body) {
      for (;;) {
        const frame = await next(id)
        if (frame.type === FrameType.End) break
        if (frame.type === FrameType.Data) chunks.push(Buffer.from(frame.payload))
      }
    }
    return { ...head, text: Buffer.concat(chunks).toString() }
  }
  return { app, directory, port: local.port, observed, returned, hooks, admission, next, send, open, http }
}
