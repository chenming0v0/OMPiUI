import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown } from 'lucide-react'
import i18n from '../../i18n'
import type { Model, Api } from '../../omp/vendor/pi-ai'
import { ChatArea, Header, InputBox, type ChatAreaHandle, type InputBoxHandle } from '../chat/index.js'
import type { ModelSelectorHandle } from '../chat/ModelSelector.js'
import { PaneHeader } from '../chat/PaneHeader.js'
import { PaneDropOverlay, resolveDropZone, type DropZone, type PaneDropOverlayHandle } from '../chat/PaneDropOverlay.js'
import { useFolderProjectDrop } from '../chat/useFolderProjectDrop.js'
import { FolderProjectDropOverlay } from '../chat/FolderProjectDropOverlay.js'
import { ChatViewportProvider, useChatViewportMaybe, type ChatViewportValue } from '../chat/chatViewport.js'
import type { Attachment } from '../attachment/index.js'
import { ExtensionUiDialogHost } from '../chat/ExtensionUiDialogHost.js'
import { ExtensionUiSurface } from '../chat/ExtensionUiSurface'
import { NativeOmpTerminalButton, openNativeOmpTerminal } from '../../components/NativeOmpTerminalButton'
import { OutlineIndex } from '../../components/OutlineIndex'
import { buildOutlineSourceEntries } from '../../components/outlineIndexModel'
import { selectPiTimelineItemsCached } from '../../omp/selectors/timelineCache.js'
import type { HistoryPrefetchMode } from '../../omp/historyPagePrefetch'
import { appendSubmittedUserMessages } from '../../omp/selectors/submittedMessages.js'
import { piEventStream } from '../../omp/eventStream.js'
import { bashPendingStore } from '../../omp/bashPendingStore'
import {
  abortPiOperation,
  abortPiCompaction,
  abortAndPrompt,
  cyclePiModel,
  cyclePiThinkingLevel,
  forkPiSession,
  loadMorePiBranchEntries,
  prefetchPiBranchEntries,
  refreshPiBranch,
  returnToLatestPiBranch,
  refreshPiSessionState,
  loadPiModels,
  loadPiSessionData,
  navigatePiTree,
  openPiSession,
  sendPiUserMessage,
  setPiExtensionEditorState,
  setPiModel,
  setPiThinkingLevel,
} from '../../omp/controllers/index.js'
import {
  manageSessionGoal,
  removeQueuedMessage,
  discardQueuedMessage,
  sendQueuedMessage,
  waitHostCommand,
} from '../../omp/transport/index.js'
import { layoutStore } from '../../store/layoutStore'
import { serverStore } from '../../store/serverStore'
import { useSessionActiveEntry } from '../../store/activeSessionStore'
import type { PiImageInput } from '../../omp/transport/index.js'
import type { DeliveryMode } from '../../types/ui'
import { attachmentToImage, imageInputToAttachment } from './attachmentToImage'
import { appendPendingSends, createPendingSend, reconcilePendingSends, reconcileQueuedPendingSends, type PendingSend } from './pendingSend'
import { hasStoppableSessionActivity } from './sessionActivity'
import { SessionStopCoordinator } from './sessionStopCoordinator'
import { composerDraftKey, getComposerDraft, moveComposerDraft, updateComposerDraft } from '../chat/input/composerDraftStore'
import type { ComposerQueueEntry } from '../chat/input/QueuedUserMessageQueue'
import { piBranchStore, piSessionStateStore } from '../../omp/state/index.js'
import { captureRedoCheckpoints, commitRedoPlan, redoPlanStore, type RedoPlan } from '../../omp/redoPlanStore'
import { extensionUiStore, getEditorTextSource } from '../../omp/extensionUiStore'
import { paneControllerStore } from '../../store/paneControllerStore'
import { trackPiSession } from '../../omp/ompSessionIndex'
import { resolveWorkspacePath } from '../../omp/workspaces.js'
import {
  clearSessionEditorDraft,
  configureSessionEditorDraftSync,
  setSessionEditorDraft,
  syncSessionEditorDraft,
  useSessionEditorDraft,
} from '../../omp/sessionEditorDraftStore'
import { isSessionBusyError, isSessionNotFoundError, uiErrorHandler } from '../../utils'
import { usePiBranchData, usePiBranchError, usePiModels, usePiSessionRuntimeState } from '../../omp/hooks/index.js'
import { useDirectory } from '../../contexts/useDirectory'
import { useSessionContext } from '../../contexts/useSessionContext'
import { SessionNavigationContext, type SessionNavigationContextValue } from '../../contexts/SessionNavigationContext'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { useServerStore } from '../../hooks/useServerStore'
import { useManagementEvents } from '../../omp/managementEventStore'
import { getInternalDragSnapshot, subscribeInternalDrag, subscribeInternalDrop } from '../../lib/internalDragCore'
import { copyTextToClipboard } from '../../utils/clipboard'
import {
  getModelVariantPref,
  getPreferredModelKey,
  recordModelUsage,
  saveModelVariantPref,
  setPreferredModelKey,
} from '../../utils/modelUtils'

/** 稳定空数组引用：避免 `?? []` 每次渲染新建数组导致 ChatArea memo 失效 */
const EMPTY_QUEUE: readonly ComposerQueueEntry[] = []



// ============================================
// Compact viewport shell for split panes (from ocui ChatPane).
// Layout/presentation stay fixed; enableCollapsedInputDock is inherited
// from the app viewport.
// ============================================
const PANE_VIEWPORT: ChatViewportValue = {
  presentation: {
    surfaceVariant: 'compact',
    isCompact: true,
  },
  interaction: {
    mode: 'pointer',
    touchCapable: false,
    sidebarBehavior: 'overlay',
    rightPanelBehavior: 'overlay',
    bottomPanelBehavior: 'overlay',
    outlineInteraction: 'pointer',
    enableCollapsedInputDock: false,
  },
  layout: {
    viewportWidth: 800,
    viewportHeight: 600,
    surfaceWidth: 800,
    surfaceMinWidth: 380,
    sidebar: {
      railWidth: 0,
      requestedWidth: 0,
      openWidth: 0,
      dockedWidth: 0,
      overlayWidth: 0,
      hardMinWidth: 0,
      preferredMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    rightPanel: {
      requestedWidth: 0,
      dockedWidth: 0,
      hardMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    bottomPanel: {
      maxHeight: 0,
    },
  },
  actions: {
    setSidebarRequestedWidth: () => {},
  },
}

let splitSessionNavigationToken = 0

function scheduleSplitSessionNavigation(callback: () => void) {
  const token = ++splitSessionNavigationToken
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== splitSessionNavigationToken) return
      splitSessionNavigationToken = 0
      callback()
    })
  })
}

function cancelPendingSplitSessionNavigation() {
  if (splitSessionNavigationToken !== 0) {
    splitSessionNavigationToken += 1
  }
}

/**
 * 队列条目。worker 在纯文本数组之外还上报 *Entries，带上图片附件；
 * 重建队列必须用它，否则图片在撤销/改投递模式时丢失。
 */
interface PiQueueEntry extends ComposerQueueEntry {
  images?: PiImageInput[]
}

/** queue_update / state.queue / clearQueue 的队列快照形状。 */
interface PiQueueSnapshot {
  steering?: string[]
  followUp?: string[]
  steeringEntries?: PiQueueEntry[]
  followUpEntries?: PiQueueEntry[]
  editable?: boolean
}

interface PiChatPaneProps {
  paneId: string
  sessionId: string | null
  isFocused?: boolean
  paneCount?: number
  displayMode?: 'single' | 'split'
  isPaneFullscreen?: boolean
  /** Home flow: called after the first send creates a session */
  onEnterSession?: (sessionId: string, directory: string) => void
  onNewChat?: () => void
  onOpenSidebar?: () => void
  onOpenSettings?: () => void
  onOpenSettingsTab?: (tab: 'config' | 'keybindings' | 'about') => void
  onToggleRightPanel?: () => void
  onSplitPane?: () => void
  onTogglePaneFullscreen?: () => void
  showSidebarButton?: boolean
  navigatePaneToSession?: (paneId: string, sessionId: string, directory?: string) => void
}

function textFromTimelineItem(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
  const blocks = (item as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(
      (block): block is { type: 'text'; text: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

/**
 * Pi-native chat pane. Shell structure mirrors ocui's ChatPane (single and
 * split modes, compact pane shell, session drag & drop); only the data
 * source is Pi (keyed stores via hooks, event stream per session).
 */
export function PiChatPane({
  paneId,
  sessionId,
  isFocused = false,
  paneCount = 1,
  displayMode = 'single',
  isPaneFullscreen = false,
  onEnterSession,
  onNewChat,
  onOpenSidebar,
  onOpenSettings,
  onOpenSettingsTab,
  onToggleRightPanel,
  onSplitPane,
  onTogglePaneFullscreen,
  showSidebarButton = false,
  navigatePaneToSession,
}: PiChatPaneProps) {
  const { t } = useTranslation(['chat', 'common'])
  const onEnterSessionRef = useRef(onEnterSession)
  const onNewChatRef = useRef(onNewChat)
  const { currentDirectory, addDirectory } = useDirectory()
  const { sessions: allSessions, registerSession } = useSessionContext()
  const { activeServer, activeServerGeneration } = useServerStore()
  const { providerRevision } = useManagementEvents()
  const registerSessionRef = useRef(registerSession)
  const currentDirectoryRef = useRef(currentDirectory)
  useEffect(() => {
    // latest-value refs：事件回调保持稳定依赖的同时总能读到最新值
    onEnterSessionRef.current = onEnterSession
    onNewChatRef.current = onNewChat
    registerSessionRef.current = registerSession
    currentDirectoryRef.current = currentDirectory
  })

  // ============================================
  // Pi data layer: event stream + keyed stores
  // ============================================
  const { models, isLoading: modelsLoading } = usePiModels()
  useEffect(() => {
    void loadPiModels().catch(() => undefined)
  }, [
    activeServerGeneration,
    activeServer?.id,
    activeServer?.url,
    activeServer?.token,
    currentDirectory,
    providerRevision,
  ])

  const branch = usePiBranchData(sessionId)
  const branchError = usePiBranchError(sessionId)
  const state = usePiSessionRuntimeState(sessionId)
  const sessionEntry = useSessionActiveEntry(sessionId ?? '')
  const compacting = state?.isCompacting === true || (state?.isCompacting === undefined && sessionEntry?.status.type === 'compacting')
  // Native queues can keep the sidebar busy after Stop. Explicit foreground
  // state wins; the active list is only a fallback until runtime state arrives.
  const sessionActive = hasStoppableSessionActivity(state, Boolean(sessionEntry))
  const sessionUnavailableRef = useRef(false)
  const [isRetryingSession, setIsRetryingSession] = useState(false)
  // 本 pane 当前会话的实际工作区（来自会话列表或全局当前目录），用于 @ 补全根目录。
  const inputRootPath = useMemo(() => {
    if (!sessionId) return currentDirectory ?? ''
    return allSessions.find(s => s.id === sessionId)?.directory ?? currentDirectory ?? ''
  }, [sessionId, allSessions, currentDirectory])
  // 只有服务端明确返回找不到会话时才显示“不存在”；网络、鉴权和服务端
  // 启动中的临时错误不能被误报成已删除。
  const sessionUnavailable = Boolean(sessionId && !branch && branchError && isSessionNotFoundError(branchError))
  const sessionLoadError = Boolean(sessionId && !branch && branchError && !sessionUnavailable)
  const sessionBusy = Boolean(sessionId && !branch && branchError && isSessionBusyError(branchError))
  useEffect(() => {
    sessionUnavailableRef.current = sessionUnavailable || sessionLoadError
  })

  const retrySession = useCallback(async () => {
    if (!sessionId || isRetryingSession) return
    setIsRetryingSession(true)
    try {
      await loadPiSessionData(sessionId)
    } catch {
      // 错误已写入 branch store，由页面状态展示
    } finally {
      setIsRetryingSession(false)
    }
  }, [isRetryingSession, sessionId])

  useEffect(() => {
    // 会话已不可用：不订阅事件流，免得每次重连都 resync 打 404
    if (!sessionId || sessionUnavailable || sessionLoadError) return
    piEventStream.connect(sessionId)
    const cachedState = piSessionStateStore.getState(sessionId)
    if (
      !piBranchStore.getData(sessionId) ||
      cachedState?.model === undefined ||
      cachedState?.thinkingLevel === undefined
    ) {
      void loadPiSessionData(sessionId).catch(() => undefined)
    }
    return () => piEventStream.disconnect(sessionId)
  }, [
    activeServerGeneration,
    activeServer?.id,
    activeServer?.token,
    activeServer?.url,
    sessionId,
    sessionLoadError,
    sessionUnavailable,
  ])


  // 树导航的编辑器草稿（undo 语义：回到用户消息前，文本进输入框）。
  // 树面板写 draft store，这里消费并同步到 worker 编辑器状态
  const editorDraft = useSessionEditorDraft(sessionId)
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    return configureSessionEditorDraftSync((sid, text) => setPiExtensionEditorState(sid, text).catch(() => undefined))
  }, [])

  const isStreaming = Boolean(state?.isStreaming) || (sessionActive && !compacting)
  // 队列操作在 worker 内完成，前端不重传未修改条目的图片。
  const queue = state?.queue as PiQueueSnapshot | undefined

  // 输入框是 memo 组件；内容不变时复用队列引用，避免每个流式事件都重绘队列。
  const queuedSteering = useMemo(() => queue?.steeringEntries ?? EMPTY_QUEUE, [queue?.steeringEntries])
  const queuedFollowUps = useMemo(() => queue?.followUpEntries ?? EMPTY_QUEUE, [queue?.followUpEntries])
  // Timeline items from this session's keyed branch; home (no session)
  // shows an empty flow — user types and sends to create one.
  const baseItems = useMemo(() => selectPiTimelineItemsCached(sessionId, branch), [sessionId, branch])
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([])

  const handleQueueBackToInput = useCallback(
    async (kind: 'steering' | 'followUp', index: number, entryId: string) => {
      if (!sessionId) return
      try {
        const entry = await stopCoordinatorRef.current.submit(JSON.stringify([activeServerGeneration, sessionId]), () => {
          if (paneIdentityRef.current.activeServerGeneration !== activeServerGeneration || paneIdentityRef.current.sessionId !== sessionId) throw new Error('Session changed before queue selection')
          return removeQueuedMessage(sessionId, { kind, index, entryId })
        })
        setPendingSends(current => current.filter(send => send.serverGeneration !== activeServerGeneration || send.sessionId !== sessionId || send.queueEntryId !== entryId))
        const key = composerDraftKey(activeServer, sessionId, '', '')
        const draft = getComposerDraft(key)
        const text = draft.text.trim() ? `${draft.text}\n\n${entry.text}` : entry.text
        const attachments = [...draft.attachments, ...(entry.images?.map(imageInputToAttachment) ?? [])]
        updateComposerDraft(key, () => ({ text, attachments, ready: true }))
        // The native removal already committed. Save to its original draft even
        // if this pane or backend changed while the response was in flight.
        if (serverStore.getActiveServerGeneration() === activeServerGeneration) {
          setSessionEditorDraft(sessionId, text, { attachments, delivery: kind === 'steering' ? 'steer' : 'followUp', sync: false })
          void refreshPiSessionState(sessionId).catch(() => undefined)
        }
      } catch (error) {
        uiErrorHandler('remove queued message', error)
      }
    },
    [sessionId, activeServer, activeServerGeneration],
  )
  /**
   * 立即提交队列中的一条（本轮 steer / 下一轮 prompt）。worker 端原子地
   * 从队列取出并投递，只有真正受理后前端才刷新；失败时队列原样保留。
   * 不允许用 clearQueue + 重放来模拟，那会丢附件并打乱顺序。
   */
  const handleQueueSendNow = useCallback(
    async (kind: 'steering' | 'followUp', index: number, entryId: string) => {
      if (!sessionId) return
      const entries = kind === 'steering' ? queuedSteering : queuedFollowUps
      const selected = entries[index]
      if (!selected || selected.entryId !== entryId) return
      const pending = createPendingSend(
        sessionId,
        activeServerGeneration,
        selected.text,
        selected.images?.map(image => ({ mimeType: image.mimeType })) ?? [],
        baseItems,
        entryId,
      )
      setPendingSends(current => [...current.filter(send => send.serverGeneration !== activeServerGeneration || send.sessionId !== sessionId || send.queueEntryId !== entryId), pending])
      let accepted = false
      try {
        await stopCoordinatorRef.current.submit(JSON.stringify([activeServerGeneration, sessionId]), () => {
          if (paneIdentityRef.current.activeServerGeneration !== activeServerGeneration || paneIdentityRef.current.sessionId !== sessionId) throw new Error('Session changed before queue selection')
          return sendQueuedMessage(sessionId, { kind, index, entryId })
        })
        accepted = true
        setPendingSends(current => current.map(send => send.id === pending.id ? { ...send, phase: 'accepted' } : send))
        if (paneIdentityRef.current.activeServerGeneration === activeServerGeneration) void Promise.all([refreshPiSessionState(sessionId), refreshPiBranch(sessionId)]).catch(() => undefined)
      } catch (error) {
        uiErrorHandler('send queued message', error)
      } finally {
        if (!accepted) setPendingSends(current => current.filter(send => send.id !== pending.id))
      }
    },
    [sessionId, activeServerGeneration, baseItems, queuedSteering, queuedFollowUps],
  )
  /** 直接清除队列中的一条（不回输入框） */
  const handleQueueClear = useCallback(
    async (kind: 'steering' | 'followUp', index: number, entryId: string) => {
      if (!sessionId) return
      try {
        await stopCoordinatorRef.current.submit(JSON.stringify([activeServerGeneration, sessionId]), () => {
          if (paneIdentityRef.current.activeServerGeneration !== activeServerGeneration || paneIdentityRef.current.sessionId !== sessionId) throw new Error('Session changed before queue selection')
          return discardQueuedMessage(sessionId, { kind, index, entryId })
        })
        setPendingSends(current => current.filter(send => send.serverGeneration !== activeServerGeneration || send.sessionId !== sessionId || send.queueEntryId !== entryId))
        if (paneIdentityRef.current.activeServerGeneration === activeServerGeneration) void refreshPiSessionState(sessionId).catch(() => undefined)
      } catch (error) {
        uiErrorHandler('remove queued message', error)
      }
    },
    [sessionId, activeServerGeneration],
  )

  const handleQueueOpenInSideChat = useCallback(
    (_kind: 'steering' | 'followUp', _index: number) => {
      if (!sessionId) return
      paneLayoutStore.splitPane(paneId, 'horizontal', sessionId)
    },
    [paneId, sessionId],
  )


  useEffect(() => {
    // Native history/queue arrival takes ownership of the display-only send.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingSends(current => {
      const sameServer = current.filter(send => send.serverGeneration === activeServerGeneration)
      const visible = sameServer.filter(send => send.sessionId === sessionId)
      const remaining = reconcileQueuedPendingSends(reconcilePendingSends(visible, baseItems), [...queuedSteering, ...queuedFollowUps])
      const removed = new Set(visible.filter(send => !remaining.includes(send)).map(send => send.id))
      return sameServer.length === current.length && removed.size === 0 ? current : sameServer.filter(send => !removed.has(send.id))
    })
  }, [baseItems, sessionId, activeServerGeneration, queuedSteering, queuedFollowUps, pendingSends])

  // 用户发起的 bash 乐观条目（执行中显示 + 流式输出，pi TUI 的
  // BashExecutionComponent 对应物）。订阅 pending 数量变化以便渲染合并。
  const pendingBashCount = useSyncExternalStore(
    bashPendingStore.subscribe,
    () => bashPendingStore.getForSession(sessionId ?? '').length,
  )
  const items = useMemo(() => {
    void pendingBashCount
    const pendingItems = sessionId ? bashPendingStore.toItems(baseItems, sessionId) : []
    const timeline = appendSubmittedUserMessages(baseItems, state?.submittedMessages)
    const visiblePending = reconcileQueuedPendingSends(pendingSends.filter(send => send.serverGeneration === activeServerGeneration && send.sessionId === sessionId), [...queuedSteering, ...queuedFollowUps])
    const withPending = appendPendingSends(timeline, visiblePending, sessionId, count => t('chat:chatArea.queuedImages', { count }))
    return pendingItems.length > 0 ? [...withPending, ...pendingItems] : withPending
  }, [baseItems, pendingSends, sessionId, activeServerGeneration, pendingBashCount, state?.submittedMessages, queuedSteering, queuedFollowUps, t])


  const stopCoordinatorRef = useRef(new SessionStopCoordinator())
  const stopKey = JSON.stringify([activeServerGeneration, sessionId])
  const [stoppingKey, setStoppingKey] = useState<string | null>(null)
  const isStopping = stoppingKey === stopKey
  const paneIdentityRef = useRef({ sessionId, activeServerGeneration })
  paneIdentityRef.current = { sessionId, activeServerGeneration }
  const handleAbort = useCallback(async () => {
    if (!sessionId) return
    const sid = sessionId
    setStoppingKey(stopKey)
    try {
      await stopCoordinatorRef.current.stop(stopKey, () => {
        if (paneIdentityRef.current.activeServerGeneration !== activeServerGeneration) throw new Error('Server changed before Stop dispatch')
        return compacting ? abortPiCompaction(sid) : abortPiOperation(sid)
      })
      if (paneIdentityRef.current.activeServerGeneration === activeServerGeneration) {
        void Promise.all([refreshPiBranch(sid), refreshPiSessionState(sid)]).catch(() => undefined)
      }
    } catch (error) {
      if (paneIdentityRef.current.activeServerGeneration === activeServerGeneration) uiErrorHandler('stop operation', error)
    } finally {
      setStoppingKey(current => current === stopKey ? null : current)
    }
  }, [sessionId, compacting, stopKey, activeServerGeneration])

  // ── Pane controller 注册（全局快捷键/命令入口）──
  // paneControllerStore 由 OpenCodeUI 迁移保留但从未注册：App 的
  // usePaneController 恒 null，导致 selectModel/newSession/cancelMessage/
  // copyLastResponse/focusNextPane 等快捷键全部失效。对齐 OpenCodeUI
  // ChatPane，把本 pane 的动作注册进 store。archiveSession/toggleAgent/
  // toggleFullAuto 在 Pi 无对应能力，置空实现。
  const controllerActionsRef = useRef<Record<string, () => void>>({})
  // latest-value：effect 里同步最新闭包（渲染期不得写 ref）
  useEffect(() => {
    controllerActionsRef.current = {
      newSession: () => onNewChatRef.current?.(),
      previousSession: () => {
        if (!sessionId) return
        const idx = allSessions.findIndex(s => s.id === sessionId)
        if (idx > 0 && allSessions[idx - 1]) {
          navigatePaneToSession?.(paneId, allSessions[idx - 1].id, allSessions[idx - 1].directory)
        }
      },
      nextSession: () => {
        if (!sessionId) return
        const idx = allSessions.findIndex(s => s.id === sessionId)
        if (idx >= 0 && idx < allSessions.length - 1 && allSessions[idx + 1]) {
          navigatePaneToSession?.(paneId, allSessions[idx + 1].id, allSessions[idx + 1].directory)
        }
      },
      cancelMessage: () => {
        void handleAbort()
      },
      openModelSelector: () => modelSelectorRef.current?.openMenu(),
      copyLastResponse: () => {
        const lastAssistant = [...items].reverse().find(item => item.kind === 'assistant_message')
        const text = lastAssistant ? textFromTimelineItem(lastAssistant) : ''
        if (text) void copyTextToClipboard(text).catch(() => undefined)
      },
      archiveSession: () => undefined,
      toggleAgent: () => undefined,
      toggleFullAuto: () => undefined,
    }
  })
  const contextLimit = useMemo(() => {
    const usage = (state as { contextUsage?: { contextWindow?: number } } | null)?.contextUsage
    return typeof usage?.contextWindow === 'number' ? usage.contextWindow : undefined
  }, [state])
  useEffect(() => {
    paneControllerStore.setController(paneId, {
      paneId,
      sessionId,
      effectiveDirectory: currentDirectoryRef.current ?? '',
      contextLimit,
      isStreaming,
      newSession: () => controllerActionsRef.current.newSession?.(),
      archiveSession: () => controllerActionsRef.current.archiveSession?.(),
      previousSession: () => controllerActionsRef.current.previousSession?.(),
      nextSession: () => controllerActionsRef.current.nextSession?.(),
      toggleAgent: () => controllerActionsRef.current.toggleAgent?.(),
      copyLastResponse: () => controllerActionsRef.current.copyLastResponse?.(),
      cancelMessage: () => controllerActionsRef.current.cancelMessage?.(),
      openModelSelector: () => controllerActionsRef.current.openModelSelector?.(),
      toggleFullAuto: () => controllerActionsRef.current.toggleFullAuto?.(),
    })
    return () => paneControllerStore.removeController(paneId)
  }, [paneId, sessionId, contextLimit, isStreaming])

  // 扩展 UI 弹窗（权限/问题/选择/输入）：可收起为输入框上方胶囊（FloatingActions）
  const extensionDialogSnapshot = useSyncExternalStore(
    extensionUiStore.subscribe,
    extensionUiStore.getSnapshot,
    extensionUiStore.getSnapshot,
  )
  const pendingDialogs = useMemo(
    () => (sessionId ? (extensionDialogSnapshot.sessions[sessionId]?.pending ?? []) : []),
    [sessionId, extensionDialogSnapshot],
  )
  const dialogRequest = useMemo(
    () => [...pendingDialogs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null,
    [pendingDialogs],
  )
  const [dialogCollapsed, setDialogCollapsed] = useState(false)
  // 真实条目落盘后清理已被吸收的乐观条目（toItems 已过滤，这里防泄漏）
  useEffect(() => {
    if (sessionId) bashPendingStore.removeConsumed(baseItems, sessionId)
  }, [baseItems, sessionId])
  // handleFork 用 items 找第一条 user 消息做 home 特判：用 ref 持有最新值，
  // 让回调保持 [sessionId] 稳定 —— items 每次流式事件都是新数组，若进依赖，
  // handleFork 每 token 重建 → VirtualRow memo 的 onFork 比较失配 → 全行重渲染。
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  // Current model from runtime state (native SDK shape); on home (no
  // session) fall back to the composer's persisted preferred model.
  const currentModel = state?.model as { provider?: string; id?: string } | null | undefined
  const [homeModelKey, setHomeModelKey] = useState<string | null>(() => getPreferredModelKey())
  const [pendingModel, setPendingModel] = useState<{ sessionId: string; key: string } | null>(null)
  const pendingModelKey = pendingModel?.sessionId === sessionId ? pendingModel.key : null
  const selectedModelKey =
    pendingModelKey ??
    (currentModel?.provider && currentModel?.id
      ? `${currentModel.provider}:${currentModel.id}`
      : sessionId
        ? null
        : homeModelKey)

  // Candidates come from official model/runtime controls, never inferred
  // from a provider map that may expose a different set of efforts.
  const currentModelObj = useMemo(
    () =>
      models.find(m => `${m.provider}:${m.id}` === pendingModelKey) ??
      models.find(m => m.provider === currentModel?.provider && m.id === currentModel?.id) ??
      (!sessionId && homeModelKey ? models.find(m => `${m.provider}:${m.id}` === homeModelKey) : undefined),
    [models, pendingModelKey, currentModel?.provider, currentModel?.id, homeModelKey, sessionId],
  )
  const thinkingLevels = useMemo(() => {
    const levels = sessionId && !pendingModelKey
      ? state?.supportedThinkingLevels
      : currentModelObj?.supportedThinkingLevels
    return Array.isArray(levels) ? levels.filter((level): level is string => typeof level === 'string') : []
  }, [sessionId, pendingModelKey, state?.supportedThinkingLevels, currentModelObj])
  // On home there is no runtime state; the selector shows the persisted
  // variant preference for the home model, applied once the session exists.
  const [homeVariant, setHomeVariant] = useState<string | undefined>(() =>
    homeModelKey ? getModelVariantPref(homeModelKey) : undefined,
  )
  const [pendingThinking, setPendingThinking] = useState<{ sessionId: string; level: string } | null>(null)
  const pendingThinkingLevel = pendingThinking?.sessionId === sessionId ? pendingThinking.level : undefined
  // home 模型切换时重读持久化 variant 偏好（渲染期间调整 state）
  const [homeVariantForModel, setHomeVariantForModel] = useState(homeModelKey)
  if (homeModelKey !== homeVariantForModel) {
    setHomeVariantForModel(homeModelKey)
    if (!sessionId) setHomeVariant(homeModelKey ? getModelVariantPref(homeModelKey) : undefined)
  }
  // sessionId 变化时重置 pending 状态（渲染期间调整 state，避免 effect 级联渲染）
  const [resetSessionId, setResetSessionId] = useState(sessionId)
  if (sessionId !== resetSessionId) {
    setResetSessionId(sessionId)
    setPendingModel(null)
    setPendingThinking(null)
  }
  const thinkingLevel =
    pendingThinkingLevel ??
    (typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : undefined) ??
    (sessionId ? undefined : homeVariant)

  const handleVariantChange = useCallback(
    (variant: string | undefined) => {
      if (!variant) return
      if (!sessionId) {
        setHomeVariant(variant)
        if (homeModelKey) saveModelVariantPref(homeModelKey, variant)
        return
      }
      const selection = { sessionId, level: variant }
      setPendingThinking(selection)
      void setPiThinkingLevel(sessionId, variant)
        .then(() => refreshPiSessionState(sessionId))
        .then(() => setPendingThinking(current => (current === selection ? null : current)))
        .catch(error => {
          setPendingThinking(current => (current === selection ? null : current))
          uiErrorHandler('set thinking level', error)
        })
    },
    [sessionId, homeModelKey],
  )

  const handleModelChange = useCallback(
    (_modelKey: string, model: Model<Api>) => {
      recordModelUsage(model)
      const key = `${model.provider}:${model.id}`
      setHomeModelKey(key)
      setPreferredModelKey(key)
      if (!sessionId) return
      const selection = { sessionId, key }
      setPendingModel(selection)
      setPendingThinking(null)
      void setPiModel(sessionId, model.provider, model.id)
        .then(() => refreshPiSessionState(sessionId))
        .then(() => setPendingModel(current => (current === selection ? null : current)))
        .catch(error => {
          setPendingModel(current => (current === selection ? null : current))
          uiErrorHandler('set model', error)
        })
    },
    [sessionId],
  )

  // Native before-user fork creates a new file even for the first user turn.
  const handleFork = useCallback(
    async (entryId: string, forkMessageId?: string) => {
      if (!sessionId) return
      const targetId = forkMessageId ?? entryId
      try {
        const result = await forkPiSession(sessionId, targetId, 'before')
        if (result.cancelled || result.aborted || !result.targetSessionId) return
        const directory = result.targetCwd ?? currentDirectoryRef.current
        if (directory) {
          onEnterSessionRef.current?.(result.targetSessionId, directory)
        }
      } catch (error) {
        uiErrorHandler('fork session', error)
      }
    },
    [sessionId],
  )

  // 加载更早历史：稳定引用（ChatArea memo），避免每次渲染新建箭头函数
  const handleLoadMore = useCallback(() => {
    return sessionId ? loadMorePiBranchEntries(sessionId) : undefined
  }, [sessionId])
  const handlePrefetchHistory = useCallback((mode: HistoryPrefetchMode, signal: AbortSignal) => {
    return sessionId ? prefetchPiBranchEntries(sessionId, mode, signal) : Promise.resolve(false)
  }, [sessionId])
  const latestSessionRef = useRef(sessionId)
  useEffect(() => {
    latestSessionRef.current = sessionId
  }, [sessionId])
  const handleReturnToLatest = useCallback(async () => {
    if (!sessionId) return
    await returnToLatestPiBranch(sessionId)
    requestAnimationFrame(() => {
      if (latestSessionRef.current === sessionId) chatAreaRef.current?.scrollToBottom()
    })
  }, [sessionId])

  // ============================================
  // Undo / Redo (pi TUI parity: tree navigation IS the undo).
  // Undo at a user message = navigateTree to it (branch is cut right
  // before that message, its text goes back to the editor). The cut
  // entries stay in the tree as children of the undo point — that is
  // what makes redo possible.
  //
  // Rigor notes:
  // - The undo point can have MULTIPLE child branches (earlier forks,
  //   or a new send after the undo). Redo must follow the branch the
  //   cut entries actually came from, so we capture their entry ids at
  //   undo time instead of guessing a child at redo time.
  // - Single redo restores ONE user turn at a time (navigate to that
  //   turn's tail entry on the original branch); Redo All jumps to the
  //   original branch tip. pi has no redo command — restoring the
  //   branch via navigateTree is the symmetric operation.
  // - canRedo tracks "the leaf is still on the undo path". Sending a
  //   new message or navigating elsewhere moves the leaf off it and the
  //   redo pointer lapses; navigating back to the undo point revives it
  //   (the cut branch is still a child there).
  // ============================================
  const head = (state?.head ?? null) as { epoch?: string; leafId?: string } | null
  const headLeafId = head?.leafId ?? null
  // redo 计划走共享 store：会话树面板里的导航也会产生/清掉计划
  const revertState = useSyncExternalStore(
    redoPlanStore.subscribe,
    () => (sessionId ? redoPlanStore.getPlan(sessionId) : null),
    () => null,
  )
  const redoRestoreAttemptedRef = useRef<string | null>(null)

  const updateRevertState = useCallback(
    (plan: RedoPlan | null) => {
      if (sessionId) redoPlanStore.setPlan(sessionId, plan)
    },
    [sessionId],
  )

  // Reset the redo pointer whenever the session changes
  useEffect(() => {
    redoRestoreAttemptedRef.current = null
  }, [sessionId])

  // A page refresh drops React state but not the native tree. Validate the
  // persisted redo plan against this session's runtime head once available.
  useEffect(() => {
    if (!sessionId || !state || !state.head || typeof state.head !== 'object' || Array.isArray(state.head)) return
    if (redoRestoreAttemptedRef.current === sessionId) return
    redoRestoreAttemptedRef.current = sessionId
    const plan = redoPlanStore.getPlan(sessionId)
    if (!plan) return
    const positions = new Set<string | null>([plan.undoLeafId, ...plan.checkpoints.slice(0, plan.restored)])
    if (plan.epoch !== head?.epoch || !positions.has(headLeafId)) redoPlanStore.setPlan(sessionId, null)
  }, [sessionId, state, headLeafId, head?.epoch])

  // Positions the leaf may legitimately sit at while the plan is alive:
  // the undo point plus the already-restored checkpoints.
  const revertPositions = useMemo(() => {
    if (!revertState) return null
    return new Set<string | null>([revertState.undoLeafId, ...revertState.checkpoints.slice(0, revertState.restored)])
  }, [revertState])

  // Leaf left the undo path (new send / tree navigation) -> the plan lapses
  useEffect(() => {
    if (!revertState || !revertPositions) return
    if (!state || !state.head || typeof state.head !== 'object' || Array.isArray(state.head)) return
    if (revertPositions.has(headLeafId)) return
    updateRevertState(null)
  }, [headLeafId, revertState, revertPositions, state, updateRevertState])

  const canUndo = Boolean(sessionId && !isStreaming && items.some(item => item.kind === 'user_message'))
  const canRedo = Boolean(
    sessionId &&
    !isStreaming &&
    revertState &&
    revertState.restored < revertState.checkpoints.length &&
    revertPositions?.has(headLeafId),
  )
  const revertSteps = revertState ? revertState.checkpoints.length - revertState.restored : 0

  // Outline index (reuses ChatArea's visible-id tracking + imperative scroll)
  const chatAreaRef = useRef<ChatAreaHandle>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle | null>(null)
  const [visibleMessageIds, setVisibleMessageIds] = useState<string[]>([])
  const visibleMessageIdsRef = useRef<string[]>([])
  const [isAtBottom, setIsAtBottom] = useState(true)
  const handleVisibleIdsChange = useCallback((ids: string[]) => {
    const prev = visibleMessageIdsRef.current
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return
    visibleMessageIdsRef.current = ids
    setVisibleMessageIds(ids)
  }, [])
  const handleOutlineScrollToMessage = useCallback((messageId: string) => {
    chatAreaRef.current?.scrollToMessageId(messageId)
  }, [])
  const outlineEntries = useMemo(() => buildOutlineSourceEntries(items), [items])

  // Existing history waits for its initial page; a local first send must not
  // disappear behind that load while session creation/model setup is pending.
  const hasPendingSessionSend = pendingSends.some(send => send.sessionId === sessionId && send.serverGeneration === activeServerGeneration)
  const chatAreaMountKey = sessionId ? (branch || hasPendingSessionSend ? sessionId : null) : 'home'
  // Assume at-bottom on session remount so the scroll-to-bottom button
  // doesn't flash.（渲染期间调整 state，避免 effect 级联渲染）
  const [lastMountKey, setLastMountKey] = useState(chatAreaMountKey)
  if (chatAreaMountKey !== lastMountKey) {
    setLastMountKey(chatAreaMountKey)
    setIsAtBottom(true)
  }

  // Input box height -> ChatArea bottom spacer (messages scroll under the
  // dock). Seed with the typical expanded height so the spacer never falls
  // back to the 256px default before ResizeObserver reports.
  const [inputBoxHeight, setInputBoxHeight] = useState(96)
  const inputBoxWrapperRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = inputBoxWrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height ?? 0
      setInputBoxHeight(height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ============================================
  // Extension editor bridge: extension set/paste -> composer; composer
  // text -> extension editor state (debounced)
  // ============================================
  const inputBoxRef = useRef<InputBoxHandle>(null)
  const extensionState = useSyncExternalStore(
    extensionUiStore.subscribe,
    () => (sessionId ? extensionUiStore.getSnapshot().sessions[sessionId]?.state : undefined),
    () => undefined,
  )
  // 输入框的本地最新文本（onTextChange 每次变化都记录）。桥接层用它与
  // worker 镜像比较，防止滞后的镜像把用户正在编辑的内容打回旧值。
  const localComposerTextRef = useRef<string | undefined>(undefined)
  const composerMountedRef = useRef(false)
  useEffect(() => {
    if (!extensionState || extensionState.editorText === lastEditorTextRef.current) return
    const source = getEditorTextSource(sessionId)
    // 镜像回填只服务于恢复场景（页面刷新/重连后输入框为空）。它来自
    // state 刷新——本地 → worker 有 500ms 防抖同步窗口，镜像必然滞后：
    // 只要用户在本挂载里输入/删除过内容（localComposerTextRef 已记录且
    // 与镜像不同），就跳过回填，否则输入框会被反复打回旧文本。
    // 扩展真实发出的 editor set/paste 事件（'extension'）不受此限。
    const localText = localComposerTextRef.current
    if (source === 'mirror' && localText !== undefined && localText !== extensionState.editorText) {
      lastEditorTextRef.current = localText
      return
    }
    lastEditorTextRef.current = extensionState.editorText
    inputBoxRef.current?.setEditorText(extensionState.editorText)
  }, [extensionState, sessionId])

  // #356: 树导航成功后恢复目标节点的原生文本/图片草稿。SessionTreePanel 的
  // 导航没有输入框句柄，通过 window 事件到达这里，与 Undo/Redo 共用一条恢复路径。
  const applyNativeEditorDraft = useCallback((sid: string, result: { editorText?: unknown; editorImages?: unknown }) => {
    if (paneIdentityRef.current.sessionId !== sid) return
    const hasText = typeof result.editorText === 'string'
    const hasImages = Array.isArray(result.editorImages)
    if (!hasText && !hasImages) return
    const images = hasImages ? (result.editorImages as PiImageInput[]).map(imageInputToAttachment) : undefined
    const text = hasText ? (result.editorText as string) : inputBoxRef.current?.getEditorText() ?? ''
    inputBoxRef.current?.setEditorDraft(text, images)
    setSessionEditorDraft(sid, text, { attachments: images, sync: false })
    localComposerTextRef.current = text
    lastEditorTextRef.current = text
  }, [])

  useEffect(() => {
    const handleNativeDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; editorText?: unknown; editorImages?: unknown }>).detail
      if (!detail?.sessionId) return
      applyNativeEditorDraft(detail.sessionId, detail)
    }
    window.addEventListener('ompiui:native-editor-draft', handleNativeDraft)
    return () => window.removeEventListener('ompiui:native-editor-draft', handleNativeDraft)
  }, [applyNativeEditorDraft])

  const handleUndo = useCallback(
    async (entryId: string) => {
      if (!sessionId || isStreaming) return
      // 逐回合的 redo 落点：沿被裁掉的原分支，每个用户回合的尾部条目。
      // 必须在导航前从 branch 捕获
      const checkpoints = captureRedoCheckpoints(sessionId, entryId)
      try {
        const result = await navigatePiTree(sessionId, { entryId })
        if (result.cancelled || result.aborted) return
        applyNativeEditorDraft(sessionId, result)
        await commitRedoPlan(sessionId, checkpoints)
      } catch (error) {
        uiErrorHandler('undo message', error)
      }
    },
    [sessionId, isStreaming, applyNativeEditorDraft],
  )

  const handleRedoStep = useCallback(async () => {
    if (!sessionId || !revertState || isStreaming) return
    const target = revertState.checkpoints[revertState.restored]
    if (!target) return
    try {
      const result = await navigatePiTree(sessionId, { entryId: target })
      if (result.cancelled || result.aborted) return
      applyNativeEditorDraft(sessionId, result)
      const restored = revertState.restored + 1
      if (restored >= revertState.checkpoints.length) updateRevertState(null)
      else updateRevertState({ ...revertState, restored })
    } catch (error) {
      uiErrorHandler('redo message', error)
    }
  }, [sessionId, revertState, isStreaming, updateRevertState, applyNativeEditorDraft])

  const handleRedoAll = useCallback(async () => {
    if (!sessionId || !revertState || isStreaming) return
    const target = revertState.checkpoints[revertState.checkpoints.length - 1]
    if (!target) return
    try {
      const result = await navigatePiTree(sessionId, { entryId: target })
      if (result.cancelled || result.aborted) return
      applyNativeEditorDraft(sessionId, result)
      updateRevertState(null)
    } catch (error) {
      uiErrorHandler('redo message', error)
    }
  }, [sessionId, revertState, isStreaming, updateRevertState, applyNativeEditorDraft])

  const refreshTimerRefs = useRef(new Set<number>())
  const scheduleDelayedRefresh = useCallback((sid: string) => {
    const timer = window.setTimeout(() => {
      refreshTimerRefs.current.delete(timer)
      void refreshPiBranch(sid).catch(() => undefined)
      void refreshPiSessionState(sid).catch(() => undefined)
    }, 120)
    refreshTimerRefs.current.add(timer)
  }, [])

  useEffect(() => {
    const timerRefs = refreshTimerRefs.current
    return () => {
      for (const timer of timerRefs) window.clearTimeout(timer)
      timerRefs.clear()
    }
  }, [activeServer?.id, activeServer?.token, activeServer?.url, sessionId])

  const handleTextChange = useCallback(
    (text: string) => {
      // 忽略 InputBox 挂载时的回显（首次渲染触发 onTextChange('')，不是
      // 用户输入）；从真实输入开始记录本地最新文本，供镜像回填判断。
      if (!composerMountedRef.current) {
        composerMountedRef.current = true
        if (text === '') return
      }
      localComposerTextRef.current = text
      // 会话已不可用时别再往服务端同步编辑器状态（每敲一个字一个 404）
      if (!sessionId || sessionUnavailableRef.current) return
      syncSessionEditorDraft(sessionId, text)
    },
    [sessionId],
  )
  const handleSend = useCallback(
    async (text: string, attachments: Attachment[], options?: { delivery?: DeliveryMode }) => {
      const capturedServerGeneration = activeServerGeneration
      const sourceDraftKey = composerDraftKey(activeServer, sessionId, currentDirectory ?? '', paneId)
      let targetSessionId = sessionId
      let pendingId: string | undefined
      let accepted = false
      try {
        // Only explicitly UI-namespaced actions are local. Official names,
        // aliases, arguments and image inputs always reach the native prompt.
        const uiCommand = /^\/(ui-[^\s]+)(?:\s|$)/.exec(text)?.[1]
        switch (uiCommand) {
          case 'ui-new':
            onNewChatRef.current?.()
            return true
          case 'ui-settings':
            onOpenSettings?.()
            return true
          case 'ui-hotkeys':
            onOpenSettingsTab?.('keybindings')
            return true
          case 'ui-about':
            onOpenSettingsTab?.('about')
            return true
          case 'ui-sessions':
            onOpenSidebar?.()
            return true
          case 'ui-model':
            modelSelectorRef.current?.openMenu()
            return true
          case 'ui-tree':
            layoutStore.addSessionTreeTab('right')
            return true
          case 'ui-copy': {
            const lastAssistant = [...itemsRef.current].reverse().find(item => item.kind === 'assistant_message')
            const responseText = lastAssistant ? textFromTimelineItem(lastAssistant) : ''
            if (!responseText) throw new Error('No AI response to copy')
            await copyTextToClipboard(responseText)
            return true
          }
          case 'ui-terminal':
            if (!sessionId) throw new Error('Open a session before handing it to the native terminal')
            await openNativeOmpTerminal(sessionId, currentDirectoryRef.current ?? undefined)
            return true
        }
        const images = attachments.map(attachmentToImage).filter((image): image is PiImageInput => image !== null)
        const deliverAs = options?.delivery ?? 'followUp'
        const pending = createPendingSend(targetSessionId, capturedServerGeneration, text, images, baseItems, undefined, [...queuedSteering, ...queuedFollowUps])
        pendingId = pending.id
        setPendingSends(current => [...current, pending])

        if (!targetSessionId) {
          const directory = currentDirectoryRef.current || (await resolveWorkspacePath())
          if (!directory) return false
          if (paneIdentityRef.current.activeServerGeneration !== capturedServerGeneration || paneIdentityRef.current.sessionId !== sessionId) throw new Error('Session changed before opening a session')
          const opened = await openPiSession(directory)
          if (!opened.sessionId) return false
          if (paneIdentityRef.current.activeServerGeneration !== capturedServerGeneration || paneIdentityRef.current.sessionId !== sessionId) throw new Error('Session changed while opening a session')
          const sessionDir = opened.cwd ?? directory
          targetSessionId = opened.sessionId
          const sid = targetSessionId
          setPendingSends(current => current.map(send => send.id === pendingId ? { ...send, sessionId: sid } : send))
          trackPiSession(targetSessionId, sessionDir)
          registerSessionRef.current({
            id: targetSessionId,
            directory: sessionDir,
            title: text.trim().slice(0, 60) || i18n.t('chat:sidebar.newChat'),
            firstMessage: text.trim().slice(0, 200),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            path: opened.sessionFile ?? undefined,
          })
          moveComposerDraft(sourceDraftKey, composerDraftKey(activeServer, targetSessionId, '', ''))
          onEnterSessionRef.current?.(targetSessionId, directory)
          window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
          // Configure the first turn before submitting its prompt.
          const preferred = getPreferredModelKey()
          const preferredModel = preferred ? models.find(m => `${m.provider}:${m.id}` === preferred) : undefined
          if (preferredModel) {
            await setPiModel(targetSessionId, preferredModel.provider, preferredModel.id)
          }
          const preferredVariant = preferred ? getModelVariantPref(preferred) : undefined
          if (preferredVariant && preferredModel?.supportedThinkingLevels?.includes(preferredVariant)) {
            if (paneIdentityRef.current.activeServerGeneration !== capturedServerGeneration || (paneIdentityRef.current.sessionId !== sessionId && paneIdentityRef.current.sessionId !== targetSessionId)) throw new Error('Session changed before model setup')
            await setPiThinkingLevel(targetSessionId, preferredVariant)
          }
        }
        const sid = targetSessionId
        // The command resolves on backend acceptance, not at the end of the turn.
        // Until then InputBox retains both the text and its attachments.
        await stopCoordinatorRef.current.submit(JSON.stringify([capturedServerGeneration, sid]), () => {
          if (paneIdentityRef.current.activeServerGeneration !== capturedServerGeneration ||
              (paneIdentityRef.current.sessionId !== sessionId && paneIdentityRef.current.sessionId !== sid)) throw new Error('Session changed before message submission')
          // #360: abortAndPrompt is its own native admission, never an
          // abort followed by a plain prompt re-submission.
          if (deliverAs === 'abortAndPrompt') {
            return abortAndPrompt(sid, text, images.length ? images : undefined).then(() => undefined)
          }
          return sendPiUserMessage(sid, text, images.length ? images : undefined, deliverAs)
        })
        accepted = true
        setPendingSends(current => text.startsWith('/')
          ? current.filter(send => send.id !== pendingId)
          : current.map(send => send.id === pendingId ? { ...send, phase: 'accepted' } : send))
        if (paneIdentityRef.current.activeServerGeneration !== capturedServerGeneration || paneIdentityRef.current.sessionId !== sid) return true
        const currentText = inputBoxRef.current?.getEditorText() ?? localComposerTextRef.current ?? text
        const remainingText = currentText === text ? '' : currentText
        localComposerTextRef.current = remainingText
        lastEditorTextRef.current = remainingText
        if (currentText === text) clearSessionEditorDraft(sid)
        else syncSessionEditorDraft(sid, remainingText)
        void setPiExtensionEditorState(sid, remainingText).catch(() => undefined)
        scheduleDelayedRefresh(sid)
        return true
      } catch (error) {
        if (paneIdentityRef.current.activeServerGeneration === capturedServerGeneration) {
          uiErrorHandler('send message', error)
          if (targetSessionId) scheduleDelayedRefresh(targetSessionId)
        }
        return false
      } finally {
        if (!accepted && pendingId) setPendingSends(current => current.filter(send => send.id !== pendingId))
      }
    },
    [sessionId, activeServer, activeServerGeneration, currentDirectory, paneId, baseItems, queuedSteering, queuedFollowUps, models, scheduleDelayedRefresh, onOpenSettings, onOpenSettingsTab, onOpenSidebar],
  )

  const handleSetGoal = useCallback(
    async (objective: string, images?: PiImageInput[]): Promise<boolean> => {
      let targetSessionId = sessionId
      try {
        if (!targetSessionId) {
          // Goal 可以作为新会话的第一步：先创建会话，再让 worker 立刻进入目标续跑。
          const directory = currentDirectoryRef.current || (await resolveWorkspacePath())
          if (!directory) return false
          const opened = await openPiSession(directory)
          if (!opened.sessionId) return false
          const sessionDir = opened.cwd ?? directory
          targetSessionId = opened.sessionId
          trackPiSession(targetSessionId, sessionDir)
          registerSessionRef.current({
            id: targetSessionId,
            directory: sessionDir,
            title: objective.slice(0, 60),
            firstMessage: objective.slice(0, 200),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            path: opened.sessionFile ?? undefined,
          })
          onEnterSessionRef.current?.(targetSessionId, sessionDir)
          window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))

          const preferred = getPreferredModelKey()
          const preferredModel = preferred ? models.find(m => `${m.provider}:${m.id}` === preferred) : undefined
          if (preferredModel) {
            await setPiModel(targetSessionId, preferredModel.provider, preferredModel.id).catch(() => undefined)
          }
          const preferredVariant = preferred ? getModelVariantPref(preferred) : undefined
          if (preferredVariant) {
            await setPiThinkingLevel(targetSessionId, preferredVariant).catch(() => undefined)
          }
        }

        const submitted = await manageSessionGoal(targetSessionId, 'set', objective, undefined, images)
        await waitHostCommand(submitted.id)
        void refreshPiSessionState(targetSessionId).catch(() => undefined)
        return true
      } catch (error) {
        uiErrorHandler('set goal', error)
        return false
      }
    },
    [models, sessionId],
  )


  // Image attachment capability from the current model's native input
  // kinds; home (unknown default model) optimistically allows when any
  // catalog model supports images — backend validates on send.
  const imageCapable = currentModelObj
    ? currentModelObj.input.includes('image')
    : models.some(model => model.input.includes('image'))

  // ============================================
  // Pane focus + drag & drop (ocui shell behavior)
  // ============================================
  const splitPaneEnabled = displayMode === 'split' || paneCount > 1 || Boolean(onSplitPane)
  const handlePaneFocus = useCallback(() => {
    paneLayoutStore.focusPane(paneId)
  }, [paneId])

  const overlayRef = useRef<PaneDropOverlayHandle>(null)
  const paneRootRef = useRef<HTMLDivElement>(null)
  const isFolderDropActive = useFolderProjectDrop(paneRootRef, addDirectory)
  const currentZoneRef = useRef<DropZone | null>(null)
  const pendingZoneRef = useRef<DropZone | null>(null)
  const dropRafRef = useRef<number | null>(null)

  const writeZone = useCallback((zone: DropZone | null) => {
    if (currentZoneRef.current === zone) return
    currentZoneRef.current = zone
    overlayRef.current?.setZone(zone)
  }, [])

  const cancelPendingZone = useCallback(() => {
    if (dropRafRef.current !== null) {
      cancelAnimationFrame(dropRafRef.current)
      dropRafRef.current = null
    }
    pendingZoneRef.current = null
  }, [])

  const resetDropState = useCallback(() => {
    cancelPendingZone()
    writeZone(null)
  }, [cancelPendingZone, writeZone])

  useEffect(() => {
    return () => {
      if (dropRafRef.current !== null) cancelAnimationFrame(dropRafRef.current)
    }
  }, [])

  const updateSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!splitPaneEnabled) return null
      const element = paneRootRef.current
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null

      const xRel = (clientX - rect.left) / rect.width
      const yRel = (clientY - rect.top) / rect.height
      const zone = resolveDropZone({ xRel, yRel })
      pendingZoneRef.current = zone

      if (dropRafRef.current === null) {
        dropRafRef.current = requestAnimationFrame(() => {
          dropRafRef.current = null
          writeZone(pendingZoneRef.current)
        })
      }

      return zone
    },
    [splitPaneEnabled, writeZone],
  )

  const clearSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      const element = paneRootRef.current
      if (!element) return resetDropState()
      const rect = element.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        resetDropState()
      }
    },
    [resetDropState],
  )

  const handleSessionDrop = useCallback(
    (payload: { sessionId: string; directory?: string }, zone: DropZone) => {
      resetDropState()
      cancelPendingSplitSessionNavigation()

      if (payload.sessionId === sessionId && zone === 'center') return

      if (zone === 'center') {
        navigatePaneToSession?.(paneId, payload.sessionId, payload.directory)
        return
      }

      const previousFocusedPaneId = paneLayoutStore.getFocusedPaneId()
      const newPaneId = paneLayoutStore.splitPaneToSide(paneId, zone, null)
      if (newPaneId) {
        if (previousFocusedPaneId && paneLayoutStore.findLeaf(previousFocusedPaneId)) {
          paneLayoutStore.focusPane(previousFocusedPaneId)
        }

        scheduleSplitSessionNavigation(() => {
          if (!paneLayoutStore.findLeaf(newPaneId)) return
          navigatePaneToSession?.(newPaneId, payload.sessionId, payload.directory)
        })
      }
    },
    [paneId, sessionId, navigatePaneToSession, resetDropState],
  )

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'session') {
        resetDropState()
        return
      }

      const zone = updateSessionDropZoneAt(active.current.x, active.current.y)
      if (!zone) clearSessionDropZoneAt(active.current.x, active.current.y)
    })
  }, [clearSessionDropZoneAt, resetDropState, updateSessionDropZoneAt])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'session') return
      const zone = updateSessionDropZoneAt(event.point.x, event.point.y)
      if (!zone) {
        resetDropState()
        return
      }

      handleSessionDrop(
        {
          sessionId: event.payload.sessionId,
          directory: event.payload.directory,
        },
        zone,
      )
    })
  }, [handleSessionDrop, resetDropState, updateSessionDropZoneAt])

  // ============================================
  // Shell (ocui structure)
  // ============================================
  const showCompactShell = displayMode === 'split' && !isPaneFullscreen
  const outerViewport = useChatViewportMaybe()

  const navigationCtx = useMemo<SessionNavigationContextValue>(
    () => ({
      navigateToSession: (sid, dir) => navigatePaneToSession?.(paneId, sid, dir),
      currentSessionId: sessionId,
      currentDirectory: currentDirectory ?? undefined,
    }),
    [navigatePaneToSession, paneId, sessionId, currentDirectory],
  )

  const chatContent = (
    <div className="flex-1 relative overflow-hidden flex flex-col min-h-0">
      {displayMode === 'single' && (
        <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
          <div className="pointer-events-auto">
            <Header
              sessionId={sessionId}
              models={[...models]}
              modelsLoading={modelsLoading}
              selectedModelKey={selectedModelKey}
              onModelChange={handleModelChange}
              onOpenSidebar={onOpenSidebar}
              onToggleRightPanel={onToggleRightPanel}
              onSplitPane={onSplitPane}
              isPaneFullscreen={isPaneFullscreen}
              onTogglePaneFullscreen={onTogglePaneFullscreen}
              modelSelectorRef={modelSelectorRef}
            />
          </div>
        </div>
      )}

      <div className="absolute inset-0">
        {sessionUnavailable || sessionLoadError ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-text-400 max-w-xs text-center">
              <p className="text-[length:var(--fs-md)] font-medium text-text-200">
                {sessionUnavailable
                  ? t('chat:chatArea.sessionNotFound')
                  : sessionBusy
                    ? t('chat:chatArea.sessionBusy')
                    : t('chat:chatArea.sessionLoadFailed')}
              </p>
              <p className="text-[length:var(--fs-sm)] text-text-400">
                {sessionUnavailable
                  ? t('chat:chatArea.sessionNotFoundDesc')
                  : sessionBusy
                    ? t('chat:chatArea.sessionBusyDesc')
                    : t('chat:chatArea.sessionLoadFailedDesc')}
              </p>
              <button
                type="button"
                onClick={() => void retrySession()}
                disabled={isRetryingSession}
                className="mt-1 h-8 px-3 rounded-md text-[length:var(--fs-sm)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50 transition-colors"
              >
                {isRetryingSession ? t('chat:chatArea.loadingSession') : t('common:retry')}
              </button>
              {sessionLoadError ? null : (
                <button
                  type="button"
                  onClick={() => onNewChatRef.current?.()}
                  className="h-8 px-3 text-[length:var(--fs-sm)] text-text-400 hover:text-text-200 transition-colors"
                >
                  {t('chat:chatArea.backToHome')}
                </button>
              )}
            </div>
          </div>
        ) : chatAreaMountKey == null ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-text-400 session-loading-indicator">
              <span className="w-5 h-5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {branch?.client?.historyWindowed && (
              <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-border-200 px-4 py-2 text-[length:var(--fs-xs)] text-text-400">
                <span>{t('chat:chatArea.historyWindow')}</span>
                <button
                  type="button"
                  onClick={() =>
                    void handleReturnToLatest().catch(error => uiErrorHandler('load latest history', error))
                  }
                  title={t('chat:chatArea.returnToLatest')}
                  className="inline-flex items-center gap-1 text-text-200 focus-visible:outline focus-visible:outline-2"
                >
                  <ArrowDown size={14} aria-hidden="true" />
                  {t('chat:chatArea.returnToLatest')}
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <ChatArea
                key={chatAreaMountKey}
                ref={chatAreaRef}
                items={items}
                sessionId={sessionId}
                isStreaming={isStreaming}
                isCompacting={compacting}
                loadState="loaded"
                hasMoreHistory={Boolean(branch?.hasMore)}
                historyStartId={branch?.items[0]?.id}
                onLoadMore={handleLoadMore}
                onPrefetchHistory={handlePrefetchHistory}
                bottomPadding={inputBoxHeight}
                onVisibleMessageIdsChange={handleVisibleIdsChange}
                onAtBottomChange={setIsAtBottom}
                onFork={handleFork}
                onUndo={canUndo ? handleUndo : undefined}
                canUndo={canUndo}
              />
            </div>
          </div>
        )}
      </div>

      <OutlineIndex
        sourceEntries={outlineEntries}
        visibleMessageIds={visibleMessageIds}
        onScrollToMessageId={handleOutlineScrollToMessage}
      />

      <ExtensionUiDialogHost sessionId={sessionId} collapsed={dialogCollapsed} onCollapsedChange={setDialogCollapsed} />


      <div ref={inputBoxWrapperRef} className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
        {/* 仅由输入区和可见按钮接收触摸，避免收起后的透明占位阻挡消息滚动。 */}
        <div className="pointer-events-none">
          <ExtensionUiSurface sessionId={sessionId} placement="aboveEditor" />
          <InputBox
            ref={inputBoxRef}
            paneId={paneId}
            sessionId={sessionId}
            draftKey={composerDraftKey(activeServer, sessionId, currentDirectory ?? '', paneId)}
            queuedSteering={queuedSteering}
            queuedFollowUps={queuedFollowUps}
            onQueueBackToInput={queue?.editable === false ? undefined : handleQueueBackToInput}
            onQueueSendNow={queue?.editable === false ? undefined : handleQueueSendNow}
            onQueueClear={queue?.editable === false ? undefined : handleQueueClear}
            onQueueOpenInSideChat={handleQueueOpenInSideChat}
            rootPath={inputRootPath}
            onSend={handleSend}
            onCycleModel={direction =>
              sessionId &&
              void cyclePiModel(sessionId, direction)
                .then(() => refreshPiSessionState(sessionId))
                .catch(error => uiErrorHandler('cycle model', error))
            }
            onCycleThinkingLevel={() =>
              sessionId &&
              void cyclePiThinkingLevel(sessionId)
                .then(() => refreshPiSessionState(sessionId))
                .catch(error => uiErrorHandler('cycle thinking level', error))
            }
            onOpenModelSelector={() => modelSelectorRef.current?.openMenu()}
            onTextChange={handleTextChange}
            onAbort={handleAbort}
            onNewChat={onNewChat}
            onSetGoal={handleSetGoal}
            isStreaming={isStreaming}
            sessionActive={sessionActive}
            isCompacting={compacting}
            isStopping={isStopping}
            isAtBottom={isAtBottom}
            showScrollToBottom={!isAtBottom}
            onScrollToBottom={() => chatAreaRef.current?.scrollToBottom()}
            fileCapabilities={{ image: imageCapable, pdf: false, audio: false, video: false }}
            models={[...models]}
            selectedModelKey={selectedModelKey}
            onModelChange={handleModelChange}
            modelsLoading={modelsLoading}
            modelSelectorRef={modelSelectorRef}
            variants={thinkingLevels}
            selectedVariant={thinkingLevel}
            onVariantChange={handleVariantChange}
            revertedText={editorDraft?.text}
            revertedDelivery={editorDraft?.delivery}
            revertedAttachments={editorDraft?.attachments}
            canRedo={canRedo}
            revertSteps={revertSteps}
            onRedo={() => void handleRedoStep()}
            onRedoAll={() => void handleRedoAll()}
            collapsedPermission={
              dialogRequest && dialogCollapsed
                ? {
                    label: dialogRequest.title,
                    queueLength: pendingDialogs.length,
                    onExpand: () => setDialogCollapsed(false),
                  }
                : undefined
            }
          />
          <ExtensionUiSurface sessionId={sessionId} placement="belowEditor" />
          <div className="pointer-events-auto flex justify-end px-4 pb-1">
            <NativeOmpTerminalButton sessionId={sessionId ?? undefined} directory={currentDirectory ?? undefined} />
          </div>
        </div>
      </div>
    </div>
  )

  const content = (
    <SessionNavigationContext.Provider value={navigationCtx}>
      <div
        ref={paneRootRef}
        data-chat-pane-root="true"
        className={
          showCompactShell
            ? `relative h-full flex flex-col overflow-hidden rounded-lg transition-colors duration-200 ${
                isFocused
                  ? 'ring-1 ring-accent-main-100/60 bg-bg-100'
                  : 'ring-1 ring-border-200/30 bg-bg-100 hover:ring-border-200/50'
              }`
            : 'relative h-full flex flex-col overflow-hidden bg-bg-100'
        }
        onClick={handlePaneFocus}
      >
        {showCompactShell && (
          <PaneHeader
            paneId={paneId}
            sessionId={sessionId}
            isFocused={isFocused}
            paneCount={paneCount}
            showSidebarButton={showSidebarButton}
            onOpenSidebar={onOpenSidebar}
            onToggleRightPanel={onToggleRightPanel}
            canSplitPane={splitPaneEnabled}
            isPaneFullscreen={isPaneFullscreen}
            onTogglePaneFullscreen={onTogglePaneFullscreen}
            onFocus={handlePaneFocus}
          />
        )}
        {chatContent}
        <PaneDropOverlay ref={overlayRef} />
        <FolderProjectDropOverlay active={isFolderDropActive} />
      </div>
    </SessionNavigationContext.Provider>
  )

  // Always wrap with ChatViewportProvider to keep the React tree structure
  // stable across fullscreen toggles (ocui pattern). Split shell keeps
  // compact presentation but inherits the input-dock setting.
  const viewportValue = useMemo((): ChatViewportValue => {
    if (!showCompactShell) return outerViewport ?? PANE_VIEWPORT
    const enableCollapsedInputDock = outerViewport?.interaction.enableCollapsedInputDock ?? false
    if (enableCollapsedInputDock === PANE_VIEWPORT.interaction.enableCollapsedInputDock) {
      return PANE_VIEWPORT
    }
    return {
      ...PANE_VIEWPORT,
      interaction: {
        ...PANE_VIEWPORT.interaction,
        enableCollapsedInputDock,
      },
    }
  }, [showCompactShell, outerViewport])

  return <ChatViewportProvider value={viewportValue}>{content}</ChatViewportProvider>
}
