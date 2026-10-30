#!/usr/bin/env node
// Acceptance-only stdio proxy. Never manufactures RPC frames or pi.event.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const bin = process.env.OMPI_RPC_STREAM_NATIVE_BIN
const controlFile = process.env.OMPI_RPC_STREAM_CONTROL
const evidenceDir = process.env.OMPI_RPC_STREAM_EVIDENCE
if (!bin || !controlFile || !evidenceDir) throw new Error('RPC stream proxy requires its isolated fixture environment')
const args = process.argv.slice(2)
const rpc = args.includes('rpc') || args.includes('rpc-ui')
const logFile = path.join(evidenceDir, `proxy-${process.pid}.jsonl`)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const record = value => appendFileSync(logFile, JSON.stringify({ time: Date.now(), proxyPid: process.pid, cwd: process.cwd(), ...value }) + '\n')
const child = spawn(bin, args, { cwd: process.cwd(), env: { ...process.env, OMPI_OMP_BIN: bin }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
record({ action: 'spawn', bin, args, nativePid: child.pid })
process.stdin.pipe(child.stdin)
child.stderr.pipe(process.stderr, { end: false })
child.stdin.on('error', error => { if (error.code !== 'EPIPE') record({ action: 'stdin-error', error: String(error) }) })
process.stdout.on('error', () => child.kill())
process.stderr.on('error', () => child.kill())
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('error', error => { record({ action: 'spawn-error', error: String(error) }); console.error(error); process.exitCode = 1 })

const groups = new Map()
async function write(bytes) {
  if (!process.stdout.write(bytes)) await once(process.stdout, 'drain')
}
async function line(original) {
  let frame
  try { frame = JSON.parse(original.toString('utf8')) } catch { await write(original); return }
  if (frame?.type !== 'rpc_chunk') { await write(original); return }
  const bytes = Buffer.from(frame.data, 'base64')
  let group = groups.get(frame.chunkId)
  if (!group) {
    if (groups.size >= 32 || frame.index !== 0 || frame.byteLength > 64 * 1024 * 1024) throw new Error('Unexpected native chunk group; acceptance proxy refuses unbounded evidence')
    const control = JSON.parse(readFileSync(controlFile, 'utf8'))
    const arm = control.arm
    // Do not let a concurrent large history/state response consume the arm.
    // Official JSON starts with the event/message header, before bounded content.
    const header = bytes.subarray(0, 256).toString('utf8')
    const extensionMessage = /^\{"type":"message_(?:start|end)","message":\{"role":"custom","customType":"rpc-stream-acceptance"/.test(header)
    const matches = arm && extensionMessage && path.resolve(arm.cwd) === path.resolve(process.cwd())
    if (matches && !['stream', 'frame', 'drop'].includes(arm.mode)) throw new Error('Invalid armed corruption mode')
    group = { count: frame.count, byteLength: frame.byteLength, mode: matches ? arm.mode : 'normal', armId: matches ? arm.id : null, chunks: [], parts: [] }
    groups.set(frame.chunkId, group)
    if (matches) writeFileSync(controlFile, JSON.stringify({ ...control, arm: null, consumed: { ...arm, chunkId: frame.chunkId, proxyPid: process.pid, time: Date.now() } }, null, 2) + '\n')
  }
  if (frame.count !== group.count || frame.byteLength !== group.byteLength || frame.index !== group.chunks.length) throw new Error('Official group metadata/order changed before corruption')
  group.parts.push(bytes)
  const summary = { chunkId: frame.chunkId, index: frame.index, count: frame.count, byteLength: frame.byteLength, payloadBytes: bytes.length, payloadSha256: sha256(bytes), wireBytes: original.length, wireSha256: sha256(original) }
  let outgoing = original
  let mutation = null
  if (group.mode === 'stream') {
    outgoing = Buffer.from(JSON.stringify({ ...frame, byteLength: frame.byteLength + 1 }) + '\n')
    mutation = { action: 'byteLength+1', original: frame.byteLength, changed: frame.byteLength + 1 }
  } else if (group.mode === 'frame' && frame.index === 0) {
    const damaged = Buffer.from(bytes); damaged[0] = 0xff
    outgoing = Buffer.from(JSON.stringify({ ...frame, data: damaged.toString('base64') }) + '\n')
    mutation = { action: 'equal-length-invalid-utf8', offset: 0, originalByte: bytes[0], changedByte: 255, changedPayloadBytes: damaged.length, changedPayloadSha256: sha256(damaged) }
  } else if (group.mode === 'drop' && frame.index === frame.count - 1) {
    outgoing = null; mutation = { action: 'drop-last-chunk', timeoutMs: 30000 }
  }
  group.chunks.push(summary)
  record({ action: 'native-rpc-chunk', mode: group.mode, armId: group.armId, ...summary, mutation, forwardedWireSha256: outgoing ? sha256(outgoing) : null })
  if (group.chunks.length === group.count) {
    const payload = Buffer.concat(group.parts)
    if (payload.length !== group.byteLength) throw new Error('Original official group length mismatch before corruption')
    const logical = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(payload))
    record({ action: 'native-group', chunkId: frame.chunkId, mode: group.mode, armId: group.armId, nativeChunkCount: group.chunks.length, byteLength: payload.length, payloadSha256: sha256(payload), originalType: logical.type, sessionId: logical.message?.details?.sessionId ?? null, tag: logical.message?.details?.tag ?? null, customType: logical.message?.customType ?? null, contentPrefix: typeof logical.message?.content === 'string' ? logical.message.content.slice(0, 160) : null, chunks: group.chunks })
    groups.delete(frame.chunkId)
  }
  if (outgoing) await write(outgoing)
}
const forwarding = (async () => {
  if (!rpc) { for await (const bytes of child.stdout) await write(bytes); return }
  let pending = Buffer.alloc(0)
  for await (const bytes of child.stdout) {
    pending = Buffer.concat([pending, bytes])
    let start = 0, end
    while ((end = pending.indexOf(10, start)) >= 0) { await line(pending.subarray(start, end + 1)); start = end + 1 }
    pending = pending.subarray(start)
    if (pending.length > 2 * 1024 * 1024) throw new Error('Native stdout line exceeded acceptance bound')
  }
  if (pending.length) await write(pending)
})()
forwarding.catch(error => { record({ action: 'proxy-error', error: String(error) }); console.error(error); child.kill(); process.exitCode = 1 })
child.once('close', async (code, signal) => {
  await forwarding.catch(() => {})
  record({ action: 'exit', code, signal, incompleteNativeGroups: groups.size })
  process.stdin.unpipe(child.stdin); process.stdin.pause()
  await new Promise(resolve => process.stdout.end(resolve))
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) }
  else process.exit(process.exitCode ?? code ?? 1)
})
