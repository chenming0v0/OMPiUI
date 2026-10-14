/** OMPiUI backend bootstrap. */
import { getPiBackendState, setPiBackendState } from "./serverMode"
import { serverStore } from "../store/serverStore"
import { clearPiSessionIndex } from "./ompSessionIndex"
import { piBranchStore, piModelsStore, piSessionStateStore } from "./state/index.js"
import { piSessionInfoStore } from "./ompSessionInfoStore"
import { ompSubagentStore } from "./ompSubagentStore"
import { extensionUiStore } from "./extensionUiStore"
import { extensionTuiStore } from "./extensionTuiStore"
import { commandFeedbackStore } from "./commandFeedbackStore"
import { resetWorkspaceResolutionCache } from "./workspaces"
import { clearAllWorkspaceFileCaches } from "./files"
import { clearPiTimelineItemCache } from "./selectors/timelineCache"
import { resetManagementEvents } from "./managementEventStore"
import { refreshPiNativeStatus } from "./nativeStatus"
import { piEventStream } from "./eventStream"
import { abortInFlightPiRequests } from "./httpClient"
import { activeSessionStore } from "../store/activeSessionStore"
import { PROTOCOL_VERSION } from "@ompiui/protocol"
import { piModelRolesStore } from "./state/piModelRolesStore"
import { resetPathModeCache } from "../utils/directoryUtils"
import { installModelSettingsSync } from "./modelSettingsSync"
import { retryDelay } from "./networkRetry"

export interface PiBackendBootstrapResult {
  available: boolean
  driver?: "omp" | "mock"
}

const FAST_RETRY_WINDOW_MS = 5_000
const MAX_BOOTSTRAP_ATTEMPTS = 12
const MAX_BOOTSTRAP_WINDOW_MS = 300_000

type BackendRetryCycle = {
  generation: number
  startedAt?: number
  attempts: number
  backoffAttempt: number
  state: "pending" | "online" | "terminal" | "exhausted"
}

let initialization: Promise<PiBackendBootstrapResult> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCycle: BackendRetryCycle | null = null
let bootstrapController: AbortController | null = null
let serverSwitchInstalled = false

/** Initial startup or an explicit retry starts a fresh, bounded recovery cycle. */
export function initializePiBackend(): Promise<PiBackendBootstrapResult> {
  if (initialization) return initialization
  resetBackendRetry()
  return startBackendInitialization()
}

function resetBackendRetry(): void {
  clearBackendRetryTimer()
  retryCycle = {
    generation: serverStore.getActiveServerGeneration(),
    attempts: 0,
    backoffAttempt: 0,
    state: "pending",
  }
}

function canProbeBackend(): boolean {
  return (typeof navigator === "undefined" || navigator.onLine !== false) &&
    (typeof document === "undefined" || document.visibilityState !== "hidden")
}

function hasRetryBudget(cycle: BackendRetryCycle): boolean {
  return cycle.attempts < MAX_BOOTSTRAP_ATTEMPTS &&
    (cycle.startedAt === undefined || Date.now() - cycle.startedAt < MAX_BOOTSTRAP_WINDOW_MS)
}

function startBackendInitialization(): Promise<PiBackendBootstrapResult> {
  if (initialization) return initialization
  const cycle = retryCycle
  if (!cycle || cycle.state !== "pending" || !canProbeBackend()) return Promise.resolve({ available: false })
  if (!hasRetryBudget(cycle)) {
    cycle.state = "exhausted"
    return Promise.resolve({ available: false })
  }
  clearBackendRetryTimer()
  cycle.startedAt ??= Date.now()
  cycle.attempts += 1
  const controller = new AbortController()
  bootstrapController = controller
  initialization = initializePiBackendOnce(cycle, controller.signal).finally(() => {
    initialization = null
    bootstrapController = null
    // A config switch or pause/resume may arrive before the old probe settles.
    // Only this completion releases the next round; events never create a second flight.
    if (retryCycle !== cycle || controller.signal.aborted) void startBackendInitialization()
  })
  return initialization
}

async function initializePiBackendOnce(cycle: BackendRetryCycle, signal: AbortSignal): Promise<PiBackendBootstrapResult> {
  let retryable = true
  let unauthorized = false
  setPiBackendState({ ...getPiBackendState(), status: "booting", error: undefined })
  try {
    // 预算 5s：registry 在 server 侧是静态快照（不等 worker），正常毫秒级；
    // 宽松预算只为覆盖冷机器的进程调度/杀软抖动，不再为 worker 冷启动买单。
    const native = await refreshPiNativeStatus(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
    if (signal.aborted || retryCycle !== cycle || serverStore.getActiveServerGeneration() !== cycle.generation) return { available: false }
    unauthorized = native.status === "unauthorized"
    retryable = native.retryable !== false && !unauthorized
    const driver = native.registry?.driver
    if (native.status !== "online" && native.status !== "degraded") {
      throw new Error(native.error ?? "OMPiUI backend unavailable")
    }
    if (native.health?.service !== "ompiui-server" || native.health.protocolVersion !== PROTOCOL_VERSION) {
      retryable = false
      throw new Error("unexpected backend")
    }

    setPiBackendState({
      status: "online",
      driver,
      checkedAt: Date.now(),
    })
    console.info("[OMPiUI] server up, driver=", driver ?? "unknown")
    cycle.state = "online"
    clearBackendRetryTimer()
    return { available: true, driver }
  } catch (error) {
    if (signal.aborted || retryCycle !== cycle || serverStore.getActiveServerGeneration() !== cycle.generation) return { available: false }
    const message = error instanceof Error ? error.message : String(error)
    setPiBackendState({
      status: unauthorized ? "unauthorized" : "offline",
      error: message,
      checkedAt: Date.now(),
    })
    cycle.state = retryable ? "pending" : "terminal"
    if (import.meta.env.DEV) console.info("[OMPiUI] backend bootstrap:", message)
    if (retryable) scheduleBackendRetry(cycle)
    return { available: false }
  }
}

export function installPiBackendServerSwitch(): void {
  if (serverSwitchInstalled) return
  serverSwitchInstalled = true
  serverStore.onServerChange(() => {
    abortInFlightPiRequests()
    resetBackendRetry()
    bootstrapController?.abort()
    clearPiSessionIndex()
    clearPiTimelineItemCache()
    piBranchStore.clearAll()
    piSessionStateStore.clearAll()
    piModelsStore.restoreCache()
    piModelRolesStore.restoreCache()
    piSessionInfoStore.clear()
    ompSubagentStore.clearAll()
    extensionUiStore.reset()
    extensionTuiStore.reset()
    commandFeedbackStore.reset()
    activeSessionStore.reset()
    resetWorkspaceResolutionCache()
    resetPathModeCache()
    clearAllWorkspaceFileCaches()
    resetManagementEvents()
    setPiBackendState({ status: "booting" })
    piEventStream.disconnectAll()
    void startBackendInitialization()
  })
  if (typeof window !== "undefined") {
    let eligible = canProbeBackend()
    const lifecycleChanged = () => {
      const nextEligible = canProbeBackend()
      if (!nextEligible) {
        eligible = false
        clearBackendRetryTimer()
        bootstrapController?.abort()
        return
      }
      if (eligible) return
      eligible = true
      const cycle = retryCycle
      if (!cycle || cycle.state === "online" || cycle.state === "terminal") return
      // A genuine return from hidden/offline may restart an exhausted transient
      // cycle. Duplicate online/visibility events cannot reset its budget.
      if (cycle.state === "exhausted" || !hasRetryBudget(cycle)) resetBackendRetry()
      clearBackendRetryTimer()
      void startBackendInitialization()
    }
    window.addEventListener("online", lifecycleChanged)
    window.addEventListener("offline", lifecycleChanged)
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", lifecycleChanged)
  }
  installModelSettingsSync()
}

function clearBackendRetryTimer(): void {
  clearTimeout(retryTimer ?? undefined)
  retryTimer = null
}

function scheduleBackendRetry(cycle: BackendRetryCycle): void {
  if (retryTimer !== null || retryCycle !== cycle || cycle.state !== "pending") return
  if (!hasRetryBudget(cycle)) {
    cycle.state = "exhausted"
    return
  }
  if (typeof window === "undefined" || !canProbeBackend()) return
  const elapsed = Date.now() - (cycle.startedAt ?? Date.now())
  // Keep only the cold-start window fast, then use the shared jittered backoff.
  // Both elapsed time and round count cap one uninterrupted recovery cycle.
  const delay = elapsed < FAST_RETRY_WINDOW_MS ? 1_000 : retryDelay(cycle.backoffAttempt++, 2_000, 30_000)
  if (elapsed + delay >= MAX_BOOTSTRAP_WINDOW_MS) {
    cycle.state = "exhausted"
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (retryCycle === cycle) void startBackendInitialization()
  }, delay)
}
