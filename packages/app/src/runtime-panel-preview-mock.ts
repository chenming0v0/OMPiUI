// 临时预览：模拟 Tauri invoke，让桌面专属的后端/运行时面板能在普通浏览器里渲染。
type Candidate = {
  path: string
  source: 'environment' | 'bundled' | 'path'
  version: string | null
  command: string
  args: string[]
  error: string | null
  runtimeRoot?: string | null
}

const BUNDLED: Candidate = {
  path: 'C:\\Users\\HEI\\Desktop\\OMPiUI\\omp-runtime\\bin\\omp.exe',
  source: 'bundled',
  version: '18.12.6',
  command: 'C:\\Users\\HEI\\Desktop\\OMPiUI\\omp-runtime\\bin\\omp.exe',
  args: [],
  error: null,
  runtimeRoot: 'C:\\Users\\HEI\\Desktop\\OMPiUI\\omp-runtime',
}
const BUN: Candidate = {
  path: 'C:\\Users\\HEI\\.bun\\bin\\omp.exe',
  source: 'path',
  version: '18.13.0',
  command: 'C:\\Users\\HEI\\.bun\\bin\\omp.exe',
  args: [],
  error: null,
}
const OLD: Candidate = {
  path: 'C:\\Users\\HEI\\AppData\\Roaming\\npm\\omp.cmd',
  source: 'path',
  version: '12.0.1',
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['cli.js'],
  error: 'OMP 12.0.1 is too old; OMPiUI requires 14.0.0 or newer',
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export const previewState = {
  running: true,
  startedByUs: true,
  activeBin: BUN.path as string | null,
  pid: 18324,
  spawnedAt: Date.now() - 42 * 60_000,
  phase: 'running' as string,
  requestedAt: Date.now() - 42 * 60_000 - 3000,
  ompMissing: false,
  inspectDelay: 1200,
  events: [] as { time: number; phase: string }[],
}

function inspect(bin: string | null) {
  const selected = bin ? [BUNDLED, BUN, OLD].find(item => same(item.path, bin)) ?? null : BUNDLED
  const candidates = [BUNDLED, BUN, OLD].map(item => ({
    ...item,
    source: bin && same(item.path, bin) ? 'environment' : item.source,
  }))
  return {
    selected: selected ? { ...selected, source: bin ? 'environment' : selected.source } : null,
    candidates,
    bundled: true,
    error: selected ? selected.error : `Cannot locate the selected OMP runtime: ${bin}`,
    configuredBin: bin,
    configuredRuntimeDir: null,
  }
}

function diagnostics() {
  const s = previewState
  return {
    revision: 1,
    phase: s.phase,
    requestedAt: s.requestedAt,
    spawnedAt: s.running ? s.spawnedAt : null,
    completedAt: s.running ? s.spawnedAt + 1500 : null,
    pid: s.running ? s.pid : null,
    error: null,
    events: s.events,
    reachable: s.running,
    workerReady: s.running ? true : null,
    ompVersion: s.running && !s.ompMissing ? (inspect(s.activeBin).selected?.version ?? null) : null,
    healthError: null,
    output: ['[ompiui] listening on http://127.0.0.1:8787', '[worker] OMP handshake ok'],
  }
}

async function restart(envVars: Record<string, string>) {
  const s = previewState
  s.requestedAt = Date.now()
  s.events = [{ time: Date.now(), phase: 'stopping' }]
  s.running = false
  s.phase = 'stopping'
  await sleep(700)
  s.phase = 'starting'
  s.events.push({ time: Date.now(), phase: 'starting' })
  await sleep(1200)
  s.phase = 'waiting_health'
  s.events.push({ time: Date.now(), phase: 'waiting_health' })
  await sleep(1200)
  s.activeBin = envVars.OMPI_OMP_BIN?.trim() || null
  s.pid += 7
  s.spawnedAt = Date.now()
  s.running = true
  s.phase = 'running'
  s.events.push({ time: Date.now(), phase: 'running' })
  return { started: true, startedByUs: true, url: 'http://127.0.0.1:8787', token: 'preview-token' }
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_ompiui_service_diagnostics: () => diagnostics(),
  get_ompiui_service_status: () => ({
    running: previewState.running,
    startedByUs: previewState.startedByUs,
    pid: previewState.pid,
    url: 'http://127.0.0.1:8787',
    environment: {},
  }),
  get_ompiui_runtime_catalog: async args => {
    await sleep(previewState.inspectDelay)
    const envVars = (args.envVars ?? {}) as Record<string, string>
    return {
      available: inspect(envVars.OMPI_OMP_BIN?.trim() || null),
      current: previewState.running ? inspect(previewState.activeBin) : null,
      currentError: null,
    }
  },
  get_ompiui_background_status: () => ({
    supported: false,
    loginStart: false,
    crashRecovery: false,
    lifecycle: 'disabled',
    pid: null,
    lastError: null,
  }),
  restart_ompiui_service: args => restart((args.envVars ?? {}) as Record<string, string>),
  start_ompiui_service: args => restart((args.envVars ?? {}) as Record<string, string>),
  stop_ompiui_service: async () => {
    previewState.phase = 'stopping'
    await sleep(800)
    previewState.running = false
    previewState.phase = 'stopped'
  },
}

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[command]
      if (!handler) throw new Error(`preview: unhandled command ${command}`)
      return handler(args)
    },
    transformCallback: () => 0,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  },
})
