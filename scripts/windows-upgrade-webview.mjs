import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, index) => {
  const [name, value] = process.argv.slice(2 + index * 2, 4 + index * 2)
  return [name.replace(/^--/, ''), value]
}))
const { root, stage, project } = options
assert.equal(process.platform, 'win32', 'Native WebView smoke is Windows-only')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only disposable GitHub-hosted runners are authorized')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.ok(['baseline', 'candidate'].includes(stage))
const ownedRoot = resolve(root)
assert.ok(ownedRoot.startsWith(resolve(process.env.RUNNER_TEMP) + sep))
assert.equal(ownedRoot, resolve(process.env.RUNNER_TEMP, `ompiui-upgrade-${process.env.GITHUB_RUN_ID}`))
const output = join(ownedRoot, 'evidence')
mkdirSync(output, { recursive: true })
const reportPath = join(output, `${stage}-gui.json`)
const report = { issue: 336, stage, status: 'BLOCKED', project, cdp: { port: Number(options.port) }, observations: [], blocker: null }
const persist = () => writeFileSync(reportPath, JSON.stringify(report, null, 2))
let socket
let cdp
const pending = new Map()
let nextId = 0

async function eventually(description, action, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await action()
      if (result) return result
    } catch (error) {
      if (error.code === 'OWNED_GUI_EXITED') throw error
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`${description} unavailable after ${timeout}ms${lastError ? `: ${lastError.message}` : ''}`)
}

async function connect() {
  const port = Number(options.port)
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
  const ownership = JSON.parse(readFileSync(join(ownedRoot, `${stage}-process.json`), 'utf8').replace(/^\uFEFF/, ''))
  assert.ok(resolve(ownership.executable).startsWith(join(ownedRoot, 'installed-app') + sep))
  report.ownedGuiPids = ownership.pids
  const targets = await eventually('Native packaged WebView CDP target', async () => {
    const alive = ownership.pids.some(pid => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    if (!alive) throw Object.assign(new Error('Actual shortcut-launched GUI exited before native WebView CDP; stopping without repeating its timeout'), { code: 'OWNED_GUI_EXITED' })
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const result = await response.json()
    return result.some(target => target.type === 'page' && /tauri\.localhost|tauri:\/\/localhost/.test(target.url)) ? result : null
  })
  report.cdp.targets = targets.map(({ id, type, title, url }) => ({ id, type, title, url }))
  const owned = targets.filter(target => target.type === 'page' && /tauri\.localhost|tauri:\/\/localhost/.test(target.url))
  assert.equal(owned.length, 1, 'Exactly one real native app WebView target is required; never attach an arbitrary browser page')
  report.cdp.targetId = owned[0].id
  socket = new WebSocket(owned[0].webSocketDebuggerUrl)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timeout)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
  })
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 20_000)
    pending.set(id, { resolve: resolvePromise, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Runtime.enable')
  await cdp('Page.enable')
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function snapshot(name) {
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(output, `${stage}-${name}.png`), Buffer.from(screenshot.data, 'base64'))
  const state = await evaluate(`({url: location.href, title: document.title, text: document.body.innerText,
    controls: Array.from(document.querySelectorAll('button,input,textarea')).map(element => ({tag:element.tagName,text:element.innerText,label:element.getAttribute('aria-label'),title:element.title,placeholder:element.getAttribute('placeholder'),disabled:element.disabled})),
    savedDirectory: Object.fromEntries(Object.keys(localStorage).filter(key => /director|project/i.test(key)).map(key => [key,localStorage.getItem(key)]))})`)
  report.observations.push({ name, at: new Date().toISOString(), ...state })
  persist()
  return state
}

// Coordinates and CDP Input events are real WebView interactions. No React,
// storage, controller, IPC, or server state is synthesized by this smoke.
async function click(expression, description) {
  const point = await eventually(description, async () => evaluate(`(() => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[aria-hidden="true"]'); };
    const element = (${expression}); if (!element || !visible(element) || element.disabled) return null;
    element.scrollIntoView({block:'center'}); const rect = element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`))
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(300)
}

const button = (pattern, attributes = false) => `Array.from(document.querySelectorAll('button')).find(element => visible(element) && ${pattern}.test(${attributes ? "element.getAttribute('aria-label') || element.title || element.innerText" : 'element.innerText'}))`
async function fill(expression, text, description) {
  await click(expression, description)
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await cdp('Input.insertText', { text })
}

function sessionFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return []
    if (entry.isDirectory()) return sessionFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  })
}
function directoryEqual(first, second) {
  return first?.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === second.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
}

try {
  persist()
  await connect()
  await eventually('Real GUI rendered', () => evaluate('document.querySelector("textarea") && document.body.innerText.length > 20'))
  await snapshot('launched')
  if (stage === 'baseline') {
    // Select/save the existing original project through the actual project
    // dialog, even though the first shortcut also supplied an explicit path.
    const projectName = project.split(/[\\/]/).at(-1)
    await click(`Array.from(document.querySelectorAll('button[aria-expanded]')).find(element => visible(element) && (element.title.includes(${JSON.stringify(projectName)}) || element.innerText.includes(${JSON.stringify(projectName)})))`, 'Saved project dropdown')
    await click(button('/Add project|添加项目/i'), 'Add project GUI action')
    await fill(`Array.from(document.querySelectorAll('input')).find(element => visible(element) && /path|路径/i.test(element.placeholder))`, project.replaceAll('\\', '/') + '/', 'Actual project path input')
    await click(button('/Add current|添加当前/i'), 'Save current project GUI action')
    const saved = await eventually('Saved original project persisted by GUI', async () => {
      const state = await evaluate(`Object.fromEntries(Object.keys(localStorage).filter(key => /director|project/i.test(key)).map(key => [key, localStorage.getItem(key)]))`)
      return Object.entries(state).some(([key, value]) => key.endsWith('ompiui-last-directory') && directoryEqual(value, project)) ? state : null
    })
    report.savedOriginalProject = saved
    await snapshot('project-saved')
    report.status = 'ACCEPTED_BASELINE_GUI_PROJECT_SETUP'
  } else {
    const baseline = JSON.parse(readFileSync(join(output, 'baseline-gui.json'), 'utf8').replace(/^\uFEFF/, ''))
    assert.equal(baseline.status, 'ACCEPTED_BASELINE_GUI_PROJECT_SETUP')
    const persisted = await evaluate(`Object.fromEntries(Object.keys(localStorage).filter(key => /director|project/i.test(key)).map(key => [key, localStorage.getItem(key)]))`)
    report.savedProjectAfterUpgrade = persisted
    assert.ok(Object.entries(persisted).some(([key, value]) => key.endsWith('ompiui-last-directory') && directoryEqual(value, project)), 'Saved original project must survive the upgrade without smoke-side storage writes')
    const nativeSessionRoot = join(ownedRoot, 'agent', 'sessions')
    const before = new Set(sessionFiles(nativeSessionRoot))
    await click(button('/^New chat$|^New Chat$|^新对话$/i', true), 'Actual new chat GUI action')
    await fill(`Array.from(document.querySelectorAll('textarea')).find(element => visible(element) && !element.disabled)`, '/changelog', 'Actual new chat composer')
    await click(button('/Send message|发送消息/i', true), 'Actual composer send action')
    await eventually('Preliminary native command completed', () => evaluate(`Array.from(document.querySelectorAll('button')).some(element => /Send message|发送消息/i.test(element.getAttribute('aria-label') || ''))`))
    const provider = JSON.parse(readFileSync(join(output, 'local-provider.json'), 'utf8'))
    report.persistenceProvider = { kind: provider.kind, baseUrl: provider.baseUrl, marker: provider.marker }
    await fill(`Array.from(document.querySelectorAll('textarea')).find(element => visible(element) && !element.disabled)`, provider.marker, 'Real plain GUI persistence prompt')
    await click(button('/Send message|发送消息/i', true), 'Send real plain GUI persistence prompt')
    const native = await eventually('New native session file with original project cwd', async () => {
      const state = await evaluate('({url: location.href, text: document.body.innerText})')
      for (const file of sessionFiles(nativeSessionRoot).filter(file => !before.has(file))) {
        const contents = readFileSync(file, 'utf8')
        const entries = contents.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        const header = entries.find(entry => entry.type === 'session')
        if (!header || !directoryEqual(header.cwd, project)) continue
        // Native session identity must be the GUI's actual selected new chat,
        // rather than a separately created background/control session file.
        if (!header.id || !decodeURIComponent(state.url).includes(header.id)) continue
        const hasUser = entries.some(entry => entry.type === 'message' && entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes(provider.marker))
        const hasAssistant = entries.some(entry => entry.type === 'message' && entry.message?.role === 'assistant' && JSON.stringify(entry.message.content).includes('Owned disposable HTTP upgrade smoke provider received the real GUI persistence prompt.'))
        if (!hasUser || !hasAssistant) continue
        return { file, header, guiUrl: state.url, hasUser, hasAssistant, sha256: createHash('sha256').update(contents).digest('hex') }
      }
      return null
    })
    assert.ok(resolve(native.file).startsWith(nativeSessionRoot + sep))
    const initialContents = readFileSync(native.file, 'utf8')
    const continuationPrompt = provider.marker + ' Continue writing in the same native file.'
    await fill(`Array.from(document.querySelectorAll('textarea')).find(element => visible(element) && !element.disabled)`, continuationPrompt, 'Real same-session GUI continuation')
    await click(button('/Send message|发送消息/i', true), 'Send real same-session GUI continuation')
    report.continuedWrite = await eventually('Same native file continued through actual GUI', async () => {
      const contents = readFileSync(native.file, 'utf8')
      const entries = contents.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      const users = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes(provider.marker))
      const assistants = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant' && JSON.stringify(entry.message.content).includes('Owned disposable HTTP upgrade smoke provider received the real GUI persistence prompt.'))
      const url = await evaluate('location.href')
      if (users.length < 2 || assistants.length < 2 || !decodeURIComponent(url).includes(native.header.id)) return null
      assert.ok(contents.startsWith(initialContents), 'Native continued writes must append to the same file without replacing its prior entries')
      return { file: native.file, sessionId: native.header.id, guiUrl: url, userTurns: users.length, assistantTurns: assistants.length, originalHistoryRetained: true, beforeSha256: native.sha256, afterSha256: createHash('sha256').update(contents).digest('hex') }
    })
    copyFileSync(native.file, join(output, 'candidate-native-session.jsonl'))
    report.nativeSession = native
    await snapshot('new-native-chat-original-cwd')
    report.status = 'ACCEPTED_NATIVE_GUI_NEW_CHAT_CWD'
  }
} catch (error) {
  report.blocker = error.message
  if (cdp) {
    try { await snapshot('blocked') } catch (snapshotError) { report.snapshotError = snapshotError.message }
  }
  console.error(report.blocker)
  process.exitCode = 1
} finally {
  persist()
  for (const request of pending.values()) clearTimeout(request.timeout)
  socket?.close()
}
