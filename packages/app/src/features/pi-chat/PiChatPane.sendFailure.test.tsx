import { forwardRef, type ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Model, Api } from '../../omp/vendor/pi-ai'
import { serverStore, LOCAL_SERVER_ID } from '../../store/serverStore'
import { notificationStore } from '../../store/notificationStore'
import { pendingSendStore } from './pendingSendStore'
import { PiChatPane } from './PiChatPane'

const mocks = vi.hoisted(() => ({
  models: [] as Model<Api>[],
  state: null as { model: { provider: string; id: string }; thinkingLevel: string } | null,
  branch: { items: [] },
  loadModels: vi.fn(),
  loadSession: vi.fn(),
  setModel: vi.fn(),
  setThinking: vi.fn(),
  refreshState: vi.fn(),
  refreshBranch: vi.fn(),
  openSession: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock('../../omp/hooks/index.js', () => ({
  usePiModels: () => ({ models: mocks.models, isLoading: false }),
  usePiBranchData: () => mocks.branch,
  usePiBranchError: () => null,
  usePiSessionRuntimeState: (sessionId: string | null) => sessionId ? mocks.state : null,
}))
vi.mock('../../omp/controllers/index.js', () => ({
  loadPiModels: mocks.loadModels,
  loadPiSessionData: mocks.loadSession,
  setPiModel: mocks.setModel,
  setPiThinkingLevel: mocks.setThinking,
  refreshPiSessionState: mocks.refreshState,
  refreshPiBranch: mocks.refreshBranch,
  openPiSession: mocks.openSession,
  sendPiUserMessage: mocks.sendMessage,
  abortPiOperation: vi.fn(),
  abortPiCompaction: vi.fn(),
  abortAndPrompt: vi.fn(),
  cyclePiModel: vi.fn(),
  cyclePiThinkingLevel: vi.fn(),
  forkPiSession: vi.fn(),
  loadMorePiBranchEntries: vi.fn(),
  prefetchPiBranchEntries: vi.fn(),
  returnToLatestPiBranch: vi.fn(),
  navigatePiTree: vi.fn(),
  setPiExtensionEditorState: vi.fn(async () => undefined),
}))
vi.mock('../../omp/transport/index.js', () => ({
  manageSessionGoal: vi.fn(),
  removeQueuedMessage: vi.fn(),
  discardQueuedMessage: vi.fn(),
  sendQueuedMessage: vi.fn(),
  waitHostCommand: vi.fn(),
}))
vi.mock('../../omp/eventStream.js', () => ({ piEventStream: { connect: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../omp/state/index.js', () => ({
  piBranchStore: { getData: () => mocks.branch },
  piSessionStateStore: { getState: () => mocks.state },
}))
vi.mock('../../omp/managementEventStore', () => ({ useManagementEvents: () => ({ providerRevision: 0 }) }))
vi.mock('../../contexts/useDirectory', () => ({ useDirectory: () => ({ currentDirectory: '/workspace', addDirectory: vi.fn() }) }))
vi.mock('../../contexts/useSessionContext', () => ({ useSessionContext: () => ({ sessions: [], registerSession: vi.fn() }) }))
vi.mock('../../store/activeSessionStore', () => ({ useSessionActiveEntry: () => null }))
vi.mock('../../omp/redoPlanStore', () => ({
  redoPlanStore: { subscribe: () => () => {}, getPlan: () => null },
  captureRedoCheckpoints: vi.fn(),
  commitRedoPlan: vi.fn(),
}))
vi.mock('../../components/OutlineIndex', () => ({ OutlineIndex: () => null }))
vi.mock('../chat/ExtensionUiDialogHost.js', () => ({ ExtensionUiDialogHost: () => null }))
vi.mock('../chat/ExtensionUiSurface', () => ({ ExtensionUiSurface: () => null }))
vi.mock('../chat/PaneHeader.js', () => ({ PaneHeader: () => null }))
vi.mock('../chat/PaneDropOverlay.js', () => ({ PaneDropOverlay: forwardRef(() => null), resolveDropZone: vi.fn() }))
vi.mock('../chat/FolderProjectDropOverlay.js', () => ({ FolderProjectDropOverlay: () => null }))
vi.mock('../chat/useFolderProjectDrop.js', () => ({ useFolderProjectDrop: () => false }))

// The real composer owns sending; here we only need its onSend bridge.
vi.mock('../chat/index.js', () => ({
  ChatArea: forwardRef(() => null),
  Header: () => null,
  InputBox: forwardRef((props: Pick<ComponentProps<typeof import('../chat/InputBox').InputBox>, 'onSend'>, _ref) => (
    <button type="button" onClick={() => { void props.onSend('hello worker', [], { delivery: 'followUp' }) }}>
      Send probe
    </button>
  )),
}))

function model(id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: 'openai',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  }
}

describe('PiChatPane send failure', () => {
  beforeEach(async () => {
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    localStorage.clear()
    vi.clearAllMocks()
    pendingSendStore.reset()
    await i18n.changeLanguage('en')
    mocks.models = [model('preview-model')]
    mocks.state = { model: { provider: 'openai', id: 'preview-model' }, thinkingLevel: 'off' }
    mocks.loadModels.mockResolvedValue(mocks.models)
    mocks.loadSession.mockResolvedValue(undefined)
    mocks.refreshState.mockResolvedValue(undefined)
    mocks.refreshBranch.mockResolvedValue(undefined)
    mocks.setModel.mockResolvedValue(undefined)
    mocks.setThinking.mockResolvedValue(undefined)
  })

  it('ends the pending bubble immediately and shows a retryable error', async () => {
    const failure = new Error('http://127.0.0.1:8787/api/v1/pi/sessions/x/commands/sendUserMessage 500 {"code":"INTERNAL"}')
    Object.assign(failure, { code: 'INTERNAL' })
    const inFlight = Promise.withResolvers<void>()
    mocks.sendMessage.mockReturnValue(inFlight.promise)

    render(<PiChatPane paneId="send-failure" sessionId="native-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Send probe' }))

    // 请求在途：pending 由真实请求驱动。
    await waitFor(() => expect(pendingSendStore.getSnapshot()).toHaveLength(1))
    expect(pendingSendStore.getSnapshot()[0]).toMatchObject({ text: 'hello worker', phase: 'submitting' })

    await act(async () => { inFlight.reject(failure) })

    await waitFor(() => expect(pendingSendStore.getSnapshot()).toEqual([]))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(i18n.t('chat:chatArea.sendFailedTitle'))
    expect(alert).toHaveTextContent('INTERNAL')
    expect(screen.getByRole('button', { name: i18n.t('chat:chatArea.retrySend') })).toBeInTheDocument()

    // 可见错误同时进入通知中心，切走界面也看得到。
    const toasts = notificationStore.getSnapshot().toasts
    expect(toasts.some(item => item.notification.title === i18n.t('chat:chatArea.sendFailedTitle'))).toBe(true)
  })

  it('retries the kept text without the user retyping it', async () => {
    const failure = new Error('boom')
    mocks.sendMessage.mockRejectedValueOnce(failure).mockResolvedValue(undefined)

    render(<PiChatPane paneId="send-retry" sessionId="native-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Send probe' }))

    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:chatArea.retrySend') }))

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
    expect(mocks.sendMessage.mock.calls[1][1]).toBe('hello worker')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
