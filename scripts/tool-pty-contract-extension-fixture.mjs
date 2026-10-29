import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { applyToolProxy } from '@oh-my-pi/pi-coding-agent/extensibility/tool-proxy'
import { PtySession, IpcServer, ipcEndpoint } from '@oh-my-pi/pi-natives'

// A feasibility probe only: no production executor, UI customization or global state.
const config = JSON.parse(readFileSync(process.env.TOOL_PTY_CONTRACT_CONFIG, 'utf8'))
const log = (type, value = {}) => appendFileSync(config.audit, `${JSON.stringify({ type, ...value })}\n`)
const records = new WeakMap()

export default function (pi) {
  // Factory deliberately registers only session_start. Everything else is late.
  pi.on('session_start', async (_event, ctx) => {
    const matches = pi.pi.AgentRegistry.global().list().filter(ref => ref.session &&
      ref.session.sessionManager.getSessionId() === ctx.sessionManager.getSessionId() &&
      ref.session.sessionManager.getSessionFile() === ctx.sessionManager.getSessionFile())
    assert.equal(matches.length, 1, 'session_start must find exactly one attached public ref.session')
    const session = matches[0].session
    const info = pi.getAllTools().find(tool => tool.name === 'bash')
    assert.equal(info?.sourceInfo?.source, 'builtin', 'capture must precede our registration')
    const captured = session.getToolByName('bash')
    assert.ok(captured)
    let activePty
    const connections = new Set()
    const endpoint = ipcEndpoint(config.root, 'tool-pty-contract')
    const server = await IpcServer.listen(endpoint, { framing: 'lines', maxFrameBytes: 65536 }, connection => {
      connections.add(connection)
      const send = async frame => {
        if (!connection.closed && !connection.send(JSON.stringify(frame))) await connection.drained()
      }
      connection.start(line => {
        void (async () => {
          try {
            const frame = JSON.parse(line)
            if (frame.type === 'ping') return await send({ type: 'pong', token: frame.token })
            assert.ok(activePty, 'PTY control requires a running tool')
            assert.equal(frame.toolCallId, activePty.toolCallId, 'control owns the outer tool call')
            if (frame.type === 'write') activePty.pty.write(frame.data)
            else if (frame.type === 'resize') activePty.pty.resize(frame.cols, frame.rows)
            else throw new Error(`Unsupported control: ${frame.type}`)
            log('control', frame)
            await send({ type: 'ack', operation: frame.type, toolCallId: frame.toolCallId })
          } catch (error) { log('failure', { error: String(error) }); await send({ type: 'error', error: String(error) }) }
        })()
      }, reason => { connections.delete(connection); log('ipc_close', { reason }) })
    })
    writeFileSync(config.endpointFile, endpoint)
    const definition = {
      async execute(toolCallId, params, signal, onUpdate, toolCtx) {
        log('execute', { toolCallId, params, hasSignal: Boolean(signal), hasUpdate: typeof onUpdate === 'function', sessionId: toolCtx.sessionManager.getSessionId() })
        if (params.pty !== true) {
          // Official delegation inherits the original abort/progress/tool context.
          const result = await toolCtx.invokeTool(params)
          log('delegate_result', { toolCallId, result })
          records.get(session).lastResult = result
          return result
        }
        const pty = new PtySession()
        activePty = { pty, toolCallId }
        let output = ''
        try {
          const result = await pty.start({ command: params.command, cwd: toolCtx.cwd, shell: config.shell,
            env: { ...process.env, PI_SESSION_ID: toolCtx.sessionManager.getSessionId(), PI_SESSION_FILE: toolCtx.sessionManager.getSessionFile() ?? '' },
            cols: 80, rows: 24, timeoutMs: params.timeout * 1000, signal }, (error, chunk) => {
              if (error) { log('failure', { error: String(error) }); return }
              output += chunk
              log('pty_chunk', { toolCallId, chunk })
              onUpdate?.({ content: [{ type: 'text', text: output }], details: { pty: true } })
            }, (error, pid) => log('pty_start', { toolCallId, pid, error: error ? String(error) : null }))
          log('pty_result', { toolCallId, result, output, aborted: signal?.aborted })
          return { content: [{ type: 'text', text: output || '(no output)' }], details: { ...result, pty: true }, isError: result.timedOut || result.cancelled || result.exitCode !== 0 }
        } finally { activePty = undefined }
      },
    }
    applyToolProxy(captured, definition)
    assert.ok(Object.getOwnPropertyDescriptor(definition, 'parameters')?.get, 'parameters remains lazy')
    assert.ok(Object.getOwnPropertyDescriptor(definition, 'description')?.get, 'description remains lazy')
    assert.equal(definition.parameters, captured.parameters, 'schema object identity preserved')
    assert.equal(definition.description, captured.description, 'builtin description preserved')
    assert.equal(definition.concurrency({ pty: true }), 'exclusive', 'private receiver survives method binding')
    assert.equal(definition.concurrency({}), 'shared')
    records.set(session, { captured, definition, registrations: 1 })
    pi.registerTool(definition)
    // Registration's SDK listener promise must be awaited by session_start scope.
    log('registered', { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), description: definition.description })
    pi.on('tool_result', event => {
      if (event.toolName === 'bash' && records.get(session).lastResult) {
        const result = records.get(session).lastResult
        log('result_identity', { toolCallId: event.toolCallId, contentSame: event.content === result.content, detailsSame: event.details === result.details })
      }
    })
    pi.on('session_switch', (_event, switchedCtx) => {
      const record = records.get(session)
      assert.ok(record)
      // Reuse the original captured tool: never capture our extension override.
      log('switch_guard', { sessionId: switchedCtx.sessionManager.getSessionId(), source: pi.getAllTools().find(tool => tool.name === 'bash')?.sourceInfo?.source,
        capturedUnchanged: record.captured === captured, registrations: record.registrations })
    })
    pi.registerCommand('contract-disable', { description: 'Disable bash for the isolated contract probe', handler: async () => {
      await pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'bash'))
      pi.registerTool(definition)
      log('disabled_reregister')
    } })
    pi.registerCommand('contract-enable', { description: 'Re-enable the isolated bash tool', handler: async () => { await pi.setActiveTools([...pi.getActiveTools(), 'bash']) } })
    pi.registerCommand('contract-other', { description: 'Register a separate user override in the isolated probe', handler: () => {
      pi.registerTool({ name: 'bash', label: 'Other user bash', description: 'OTHER_USER_OVERRIDE', parameters: captured.parameters,
        execute: async toolCallId => { log('other_execute', { toolCallId }); return { content: [{ type: 'text', text: 'OTHER_USER_RESULT' }], details: {} } } })
      log('other_registered')
    } })
    pi.registerCommand('contract-reload', { description: 'Reload only the isolated session', handler: async (_text, commandCtx) => { await commandCtx.reload(); log('reloaded') } })
    pi.on('session_shutdown', async () => {
      for (const connection of connections) connection.destroy()
      await server.close()
      log('shutdown')
    })
  })
}
