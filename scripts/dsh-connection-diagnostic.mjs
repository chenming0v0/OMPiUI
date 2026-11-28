import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
  throw new Error('此公共握手诊断仅允许在 GitHub Actions 中运行')
}

// 与工作流的 npm --prefix 保持一致，不加载仓库运行时或客户端凭据。
const require = createRequire(join(process.env.RUNNER_TEMP, 'dsh-diagnostic', 'package.json'))
const WebSocket = require('ws')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const endpoint = 'wss://dsh.r2049.cn/ws/v1/connect'
const caseTimeoutMs = 8_000
const helloDelayMs = 250
const cases = [
  { name: 'unset', origin: undefined },
  { name: 'https://dsh.r2049.cn', origin: 'https://dsh.r2049.cn' },
  { name: 'http://tauri.localhost', origin: 'http://tauri.localhost' },
]

function ulid() {
  let value = BigInt(Date.now()) << 80n
  let entropy = 0n
  for (const byte of randomBytes(10)) entropy = (entropy << 8n) | BigInt(byte)
  value |= entropy
  let id = ''
  for (let i = 0; i < 26; i++) {
    id = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value & 31n)] + id
    value >>= 5n
  }
  return id
}

// 三次连接复用完全相同的无效 hello，仅改变 Origin；不注册设备或重试。
const hello = JSON.stringify({
  v: 1,
  id: ulid(),
  type: 'hello',
  timestamp: Date.now(),
  payload: {
    role: 'client',
    deviceId: randomUUID(),
    accessToken: 'ompiui-public-handshake-diagnostic',
    protocols: [1],
    capabilities: ['transport.relay'],
    clientVersion: version,
  },
})

function symbol(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null
}

function closeReason(value) {
  return value.toString('utf8').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 80)
}

const cancellation = new AbortController()
let interruptedExitCode = 0
const interrupt = (code) => {
  interruptedExitCode = code
  cancellation.abort()
}
const onSigint = () => interrupt(130)
const onSigterm = () => interrupt(143)
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

function observe({ name, origin }) {
  return new Promise(resolve => {
    const started = performance.now()
    const result = {
      origin: name, openMs: null, helloQueuedMs: null,
      messages: [], errors: [], close: null,
      stage: 'before-open', outcome: null, terminatedLocally: false, durationMs: 0,
    }
    let socket
    let helloTimer
    let finished = false
    const elapsed = () => Math.round(performance.now() - started)
    const log = (event, details = {}) => console.log(JSON.stringify({ origin: name, event, durationMs: elapsed(), ...details }))
    const recordError = (code) => {
      result.errors.push(code)
      log('error', { code })
    }
    const finish = (outcome) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearTimeout(helloTimer)
      cancellation.signal.removeEventListener('abort', abort)
      if (socket) {
        socket.removeAllListeners()
        // 终止尚在升级的连接会异步发出 error，仅吸收清理事件。
        socket.on('error', () => {})
        if (socket.readyState !== WebSocket.CLOSED) {
          result.terminatedLocally = true
          socket.terminate()
        }
      }
      result.outcome = outcome
      result.durationMs = elapsed()
      log('case-result', { result })
      resolve(result)
    }
    const abort = () => finish('interrupted')
    const deadline = setTimeout(() => {
      log('timeout', { code: 'CASE_TIMEOUT' })
      finish('timeout')
    }, caseTimeoutMs)
    cancellation.signal.addEventListener('abort', abort, { once: true })
    if (cancellation.signal.aborted) return finish('interrupted')

    try {
      socket = new WebSocket(endpoint, {
        ...(origin === undefined ? {} : { origin }),
        handshakeTimeout: caseTimeoutMs,
        maxPayload: 64 * 1024,
        perMessageDeflate: false,
        followRedirects: false,
        autoPong: false,
      })
    } catch (error) {
      recordError(symbol(error?.code) ?? 'WEBSOCKET_SETUP_ERROR')
      return finish('connection-error')
    }

    socket.on('open', () => {
      result.openMs = elapsed()
      result.stage = 'before-hello'
      log('open')
      helloTimer = setTimeout(() => {
        if (finished || socket.readyState !== WebSocket.OPEN) return
        try {
          socket.send(hello, error => {
            if (!finished && error) {
              recordError(symbol(error.code) ?? 'HELLO_WRITE_ERROR')
              finish('send-error')
            }
          })
          if (finished) return
          result.helloQueuedMs = elapsed()
          result.stage = 'after-hello'
          // 排队写入不等于服务端已接收或通过认证。
          log('hello', { state: 'queued' })
        } catch (error) {
          recordError(symbol(error?.code) ?? 'HELLO_SEND_ERROR')
          finish('send-error')
        }
      }, helloDelayMs)
    })
    socket.on('message', (data, binary) => {
      let message = { type: 'binary', code: null }
      if (!binary) {
        try {
          const frame = JSON.parse(data.toString('utf8'))
          message = { type: symbol(frame?.type) ?? 'unknown', code: frame?.type === 'error' ? symbol(frame?.payload?.code) : null }
        } catch {
          message = { type: 'unparseable', code: 'INVALID_JSON' }
        }
      }
      result.messages.push(message)
      log('message', message)
      // 不发送 pong、后续控制消息或任何业务消息。
      if (message.type === 'hello.ack') finish('unexpected-hello-ack')
    })
    socket.on('unexpected-response', (_request, response) => {
      recordError(`HTTP_${response.statusCode}`)
      finish('upgrade-rejected')
    })
    socket.on('error', error => recordError(symbol(error.code) ?? 'WEBSOCKET_ERROR'))
    socket.on('close', (code, reason) => {
      result.close = { code, reason: closeReason(reason) }
      log('close', { ...result.close, stage: result.stage })
      finish('closed')
    })
  })
}

function cell(value) {
  return String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replaceAll('`', '&#96;')
}

const results = []
console.log(JSON.stringify({ event: 'start', endpoint, clientVersion: version, caseTimeoutMs, helloDelayMs, cases: cases.length }))
try {
  for (const entry of cases) {
    if (cancellation.signal.aborted) break
    results.push(await observe(entry))
  }
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
  console.log(JSON.stringify({ event: 'comparison', results }))
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map(result => [
      result.origin, result.openMs, result.helloQueuedMs,
      result.messages.map(message => `${message.type}${message.code === null ? '' : ` / ${message.code}`}`).join(', '),
      result.close ? `${result.close.code} / ${result.close.reason}` : '未观察到 close',
      result.stage, `${result.outcome}${result.terminatedLocally ? ' (local termination)' : ''}`,
      result.errors.join(', '), result.durationMs,
    ].map(cell).join(' | '))
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '## DS Remote 公共握手观察', '',
      '三组使用同一个固定无效凭据 hello。hello 时间表示排队写入；4010 仅记录为关闭码，认证结果以实际响应为准。', '',
      '| Origin | Open ms | Hello queued ms | Message type / code | Close code / reason | Stage | Outcome | Errors | Duration ms |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(row => `| ${row} |`), '',
    ].join('\n'))
  }
}

// 服务端拒绝作为观察结果保留；网络失败、超时或非预期放行使步骤失败。
process.exitCode = interruptedExitCode || (results.some(result =>
  result.outcome !== 'closed' || result.errors.length > 0 || result.close?.code === 1006
) ? 1 : 0)
