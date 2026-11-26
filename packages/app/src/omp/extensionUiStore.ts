import type {
  EventCursor,
  ExtensionUiDialogRequest,
  ExtensionUiEditorCommand,
  ExtensionUiSnapshot,
  ExtensionUiState,
  ExtensionUiStatePatch,
} from "@ompiui/protocol"
import { activeSessionStore } from '../store/activeSessionStore'

interface ExtensionUiStoreSnapshot {
  sessions: Readonly<Record<string, ExtensionUiSnapshot>>
}

/** editorText 的来源：'mirror' 是 state 刷新/重连恢复的 worker 镜像，
 *  'extension' 是扩展真实发出的 editor set/paste 事件。桥接层据此判断
 *  回填是否会覆盖用户正在输入的更新文本。 */
type EditorTextSource = 'none' | 'mirror' | 'extension'

const editorTextSourceBySession = new Map<string, EditorTextSource>()
const settledRequestsBySession = new Map<string, Set<string>>()
const pendingCursors = new Map<string, Map<string, { cursor: EventCursor; receivedAt: number }>>()
const pendingSnapshotCursors = new Map<string, EventCursor>()
let pendingEventVersion = 0

const emptyState = (): ExtensionUiState => ({
  revision: 0,
  statuses: {},
  workingVisible: true,
  widgets: {},
  editorText: "",
  toolsExpanded: false,
})

function applyStatePatch(state: ExtensionUiState, patch: ExtensionUiStatePatch): ExtensionUiState {
  const revision = state.revision + 1
  switch (patch.kind) {
    case 'status': {
      const statuses = { ...state.statuses }
      if (patch.text === undefined) delete statuses[patch.key]
      else statuses[patch.key] = patch.text
      return { ...state, revision, statuses }
    }
    case 'workingMessage':
      return { ...state, revision, workingMessage: patch.message }
    case 'workingVisible':
      return { ...state, revision, workingVisible: patch.visible }
    case 'workingIndicator':
      return {
        ...state,
        revision,
        workingIndicator: patch.frames ? { frames: patch.frames, intervalMs: patch.intervalMs ?? 100 } : undefined,
      }
    case 'hiddenThinkingLabel':
      return { ...state, revision, hiddenThinkingLabel: patch.label }
    case 'widget': {
      const widgets = { ...state.widgets }
      if (!patch.lines) delete widgets[patch.key]
      else widgets[patch.key] = { lines: patch.lines, placement: patch.placement ?? 'aboveEditor' }
      return { ...state, revision, widgets }
    }
    case 'title':
      return { ...state, revision, title: patch.title }
    case 'theme':
      return { ...state, revision, themeName: patch.name }
    case 'toolsExpanded':
      return { ...state, revision, toolsExpanded: patch.expanded }
  }
}

let current: ExtensionUiStoreSnapshot = { sessions: {} }
const listeners = new Set<() => void>()
function settledKey(requestId: string, workerGeneration?: string): string {
  return `${workerGeneration ?? ''}:${requestId}`
}

function update(sessionId: string, value: ExtensionUiSnapshot): void {
  current = { sessions: { ...current.sessions, [sessionId]: value } }
  for (const listener of listeners) listener()
}

function existing(sessionId: string): ExtensionUiSnapshot {
  return current.sessions[sessionId] ?? { sessionId, state: emptyState(), pending: [] }
}

export const extensionUiStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getSnapshot(): ExtensionUiStoreSnapshot {
    return current
  },

  replace(snapshot: ExtensionUiSnapshot): void {
    const restored = structuredClone(snapshot)
    const settled = settledRequestsBySession.get(snapshot.sessionId)
    restored.pending = restored.pending.filter(request => !settled?.has(settledKey(request.requestId, request.workerGeneration ?? snapshot.workerGeneration)))
    update(snapshot.sessionId, restored)
  },

  getPendingEventVersion(): number {
    return pendingEventVersion
  },

  requestOpened(request: ExtensionUiDialogRequest, cursor?: EventCursor): boolean {
    const snapshot = existing(request.sessionId)
    const cutoff = pendingSnapshotCursors.get(request.sessionId)
    if (cursor && cutoff?.epoch === cursor.epoch && cursor.sequence <= cutoff.sequence) return false
    if (settledRequestsBySession.get(request.sessionId)?.has(
      settledKey(request.requestId, request.workerGeneration ?? snapshot.workerGeneration),
    )) return false
    if (cursor) {
      const requests = pendingCursors.get(request.sessionId) ?? new Map()
      requests.set(request.requestId, { cursor, receivedAt: ++pendingEventVersion })
      pendingCursors.set(request.sessionId, requests)
    }
    update(request.sessionId, {
      ...snapshot,
      workerGeneration: request.workerGeneration ?? snapshot.workerGeneration,
      pending: [...snapshot.pending.filter(item => item.requestId !== request.requestId), structuredClone(request)],
    })
    return true
  },

  reconcilePending(sessionId: string, requests: ExtensionUiDialogRequest[], cursor: EventCursor, since: number) {
    const cutoff = pendingSnapshotCursors.get(sessionId)
    if (cutoff?.epoch === cursor.epoch && cutoff.sequence > cursor.sequence) return []
    pendingSnapshotCursors.set(sessionId, cursor)
    const live = pendingCursors.get(sessionId)
    const retain = new Set(requests.map(request => request.requestId))
    const newer = (id: string) => {
      const position = live?.get(id)
      return position && (position.cursor.epoch === cursor.epoch
        ? position.cursor.sequence > cursor.sequence : position.receivedAt > since)
    }
    for (const request of existing(sessionId).pending) {
      if (retain.has(request.requestId) || newer(request.requestId)) continue
      this.requestSettled(sessionId, request.requestId, request.workerGeneration)
    }
    return requests.filter(request => !newer(request.requestId))
  },

  requestSettled(sessionId: string, requestId: string, workerGeneration?: string): void {
    // Keep the originating identity even if a late response finishes after a runtime replacement.
    const snapshot = existing(sessionId)
    const generation = workerGeneration ?? snapshot.pending.find(request => request.requestId === requestId)?.workerGeneration ?? snapshot.workerGeneration
    const settled = settledRequestsBySession.get(sessionId) ?? new Set<string>()
    const pending = snapshot.pending.filter(request => request.requestId !== requestId || (request.workerGeneration ?? snapshot.workerGeneration) !== generation)
    if (!pending.some(request => request.requestId === requestId)) {
      pendingCursors.get(sessionId)?.delete(requestId)
      // Local expiry and direct responses can precede or miss the live event.
      activeSessionStore.resolvePendingRequest(requestId, sessionId)
    }
    settled.add(settledKey(requestId, generation))
    settledRequestsBySession.set(sessionId, settled)
    update(sessionId, { ...snapshot, pending })
  },

  /**
   * 刷新/重连恢复：重放 worker 侧状态镜像（status/widget/working 指示等
   * 增量 patch），重建显示。覆盖式 patch 全量重放幂等，多次恢复无害；
   * 只重建 state，不动 pending（实时 dialog 事件可能已先到）。
   * 注意：state 刷新每次都会调用这里，editorText 标记为 'mirror' 来源，
   * 桥接层只在输入框没有更新文本时才允许它回填（详见 PiChatPane）。
   */
  restore(
    sessionId: string,
    mirror: { patches: ExtensionUiStatePatch[]; editorText?: string; toolsExpanded?: boolean },
  ): void {
    const snapshot = existing(sessionId)
    let state = emptyState()
    for (const patch of mirror.patches) state = applyStatePatch(state, patch)
    editorTextSourceBySession.set(sessionId, 'mirror')
    update(sessionId, {
      ...snapshot,
      state: {
        ...state,
        editorText: mirror.editorText ?? snapshot.state.editorText,
        toolsExpanded: mirror.toolsExpanded ?? state.toolsExpanded,
      },
    })
  },

  statePatched(sessionId: string, patch: ExtensionUiStatePatch): void {
    const snapshot = existing(sessionId)
    update(sessionId, { ...snapshot, state: applyStatePatch(snapshot.state, patch) })
  },

  editorCommand(sessionId: string, command: ExtensionUiEditorCommand): void {
    const snapshot = existing(sessionId)
    const editorText = command.kind === "set"
      ? command.text
      : snapshot.state.editorText + command.text
    editorTextSourceBySession.set(sessionId, 'extension')
    update(sessionId, {
      ...snapshot,
      state: { ...snapshot.state, revision: snapshot.state.revision + 1, editorText },
    })
  },

  remove(sessionId: string): void {
    settledRequestsBySession.delete(sessionId)
    pendingCursors.delete(sessionId)
    pendingSnapshotCursors.delete(sessionId)
    if (!(sessionId in current.sessions)) return
    const sessions = { ...current.sessions }
    delete sessions[sessionId]
    editorTextSourceBySession.delete(sessionId)
    current = { sessions }
    for (const listener of listeners) listener()
  },

  reset(): void {
    settledRequestsBySession.clear()
    pendingCursors.clear()
    pendingSnapshotCursors.clear()
    current = { sessions: {} }
    editorTextSourceBySession.clear()
    for (const listener of listeners) listener()
  },
}

export function getEditorTextSource(sessionId: string | null | undefined): EditorTextSource {
  return sessionId ? (editorTextSourceBySession.get(sessionId) ?? 'none') : 'none'
}
