import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Model, Api } from '../../omp/vendor/pi-ai'
import { getModelVariantPref, saveModelVariantPref, setPreferredModelKey } from '../../utils/modelUtils'
import { InputToolbar } from '../chat/input/InputToolbar'
import { PiChatPane } from './PiChatPane'

const mocks = vi.hoisted(() => ({
  models: [] as Model<Api>[],
  state: null as { model: { provider: string; id: string }; thinkingLevel: string; supportedThinkingLevels?: string[] } | null,
  branch: { items: [] },
  sessions: [],
  loadModels: vi.fn(),
  loadSession: vi.fn(),
  setModel: vi.fn(),
  setThinking: vi.fn(),
  refreshState: vi.fn(),
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
  refreshPiBranch: vi.fn(),
  returnToLatestPiBranch: vi.fn(),
  navigatePiTree: vi.fn(),
  setPiExtensionEditorState: vi.fn(),
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
vi.mock('../../contexts/useSessionContext', () => ({ useSessionContext: () => ({ sessions: mocks.sessions, registerSession: vi.fn() }) }))
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

// Keep the real effort menu; replace only the unrelated transcript/editor shell.
vi.mock('../chat/index.js', () => ({
  ChatArea: forwardRef(() => null),
  Header: () => null,
  InputBox: forwardRef((props: Pick<ComponentProps<typeof InputToolbar>, 'models' | 'onModelChange' | 'variants' | 'variantsDisabled' | 'selectedVariant' | 'onVariantChange'> & { composerNotice?: ReactNode }, _ref) => (
    <div>
      {props.composerNotice}
      {props.models?.map(model => (
        <button key={model.id} type="button" onClick={() => props.onModelChange?.(`${model.provider}:${model.id}`, model)}>
          Select {model.name}
        </button>
      ))}
      <InputToolbar variants={props.variants} variantsDisabled={props.variantsDisabled} selectedVariant={props.selectedVariant} onVariantChange={props.onVariantChange} onFilesSelected={() => {}} canSend={false} onSend={() => {}} />
    </div>
  )),
}))

function model(id: string, supportedThinkingLevels: string[]): Model<Api> {
  return {
    id,
    name: id,
    provider: 'openai',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    supportedThinkingLevels,
    thinkingLevelMap: { high: 'high', xhigh: 'xhigh' },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  }
}

async function openEffortMenu() {
  fireEvent.click(await screen.findByRole('button', { name: /^Low$/ }))
  return screen.findByRole('menu', { name: i18n.t('chat:inputToolbar.variantMenu') })
}

function expectMenuChoices(menu: HTMLElement, choices: string[]) {
  expect(within(menu).getAllByRole('menuitemradio').map(option => option.textContent)).toEqual(choices)
}

describe('PiChatPane effort controls', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
    await i18n.changeLanguage('en')
    mocks.models = [model('preview-model', ['off', 'low', 'max']), model('next-model', ['low', 'medium'])]
    mocks.state = { model: { provider: 'openai', id: 'preview-model' }, thinkingLevel: 'low' }
    mocks.loadModels.mockResolvedValue(mocks.models)
    mocks.loadSession.mockResolvedValue(undefined)
    mocks.setModel.mockResolvedValue(undefined)
    mocks.setThinking.mockResolvedValue(undefined)
    mocks.refreshState.mockResolvedValue(undefined)
    setPreferredModelKey('openai:preview-model')
  })

  it('offers catalog efforts on home before first send and retains the selected preference', async () => {
    const first = render(<PiChatPane paneId="effort-home" sessionId={null} />)
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('chat:inputToolbar.default') }))
    const menu = await screen.findByRole('menu', { name: i18n.t('chat:inputToolbar.variantMenu') })
    expectMenuChoices(menu, ['Off', 'Low', 'Max'])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Max' }))
    expect(getModelVariantPref('openai:preview-model')).toBe('max')
    expect(mocks.setThinking).not.toHaveBeenCalled()
    expect(mocks.openSession).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    first.unmount()
    render(<PiChatPane paneId="effort-home" sessionId={null} />)
    expect(await screen.findByRole('button', { name: 'Max' })).toBeInTheDocument()
  })

  it('offers catalog efforts for a disk preview missing authoritative levels', async () => {
    render(<PiChatPane paneId="effort-preview" sessionId="disk-preview" />)
    const menu = await openEffortMenu()
    expectMenuChoices(menu, ['Off', 'Low', 'Max'])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Max' }))
    await waitFor(() => expect(mocks.setThinking).toHaveBeenCalledWith('disk-preview', 'max'))
    expect(mocks.openSession).not.toHaveBeenCalled()
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('does not expose catalog efforts when the runtime explicitly supplies no levels', () => {
    mocks.state!.supportedThinkingLevels = []
    render(<PiChatPane paneId="effort-native-empty" sessionId="native-session" />)
    expect(screen.queryByRole('button', { name: 'Low' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('disables the effort selector for authoritative Off-only models', () => {
    mocks.state!.supportedThinkingLevels = ['off']
    mocks.state!.thinkingLevel = 'off'
    render(<PiChatPane paneId="effort-off" sessionId="native-session" />)
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(mocks.setThinking).not.toHaveBeenCalled()
  })

  it('uses authoritative runtime levels instead of catalog choices', async () => {
    mocks.state!.supportedThinkingLevels = ['minimal', 'medium']
    mocks.state!.thinkingLevel = 'minimal'
    render(<PiChatPane paneId="effort-native" sessionId="native-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Minimal' }))
    const menu = await screen.findByRole('menu')
    expectMenuChoices(menu, ['Minimal', 'Medium'])
    expect(within(menu).queryByRole('menuitemradio', { name: 'Max' })).not.toBeInTheDocument()
  })

  it('does not expose the old effort or allow effort writes while a model switch is pending', async () => {
    mocks.state!.supportedThinkingLevels = []
    const pending = Promise.withResolvers<void>()
    mocks.setModel.mockReturnValue(pending.promise)
    const view = render(<PiChatPane paneId="effort-pending" sessionId="native-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Select next-model' }))
    const trigger = screen.getByRole('button', { name: i18n.t('chat:inputToolbar.default') })
    expect(trigger).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Low' })).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(mocks.setThinking).not.toHaveBeenCalled()
    expect(mocks.setModel).toHaveBeenCalledWith('native-session', 'openai', 'next-model')
    await act(async () => { pending.resolve() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Low' })).not.toBeInTheDocument())
    view.unmount()
  })

  it('drops a pending model missing from the refreshed catalog instead of using the previous ladder', () => {
    mocks.setModel.mockReturnValue(new Promise(() => {}))
    const view = render(<PiChatPane paneId="effort-missing" sessionId="native-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Select next-model' }))
    mocks.models = [mocks.models[0]]
    view.rerender(<PiChatPane paneId="effort-missing" sessionId="native-session" />)
    expect(screen.queryByRole('button', { name: 'Low' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: i18n.t('chat:inputToolbar.default') })).not.toBeInTheDocument()
  })

  it('reads the selected home model preference when returning from a session', async () => {
    saveModelVariantPref('openai:preview-model', 'max')
    saveModelVariantPref('openai:next-model', 'medium')
    const view = render(<PiChatPane paneId="effort-home-return" sessionId={null} />)
    view.rerender(<PiChatPane paneId="effort-home-return" sessionId="native-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Select next-model' }))
    await waitFor(() => expect(mocks.refreshState).toHaveBeenCalled())
    view.rerender(<PiChatPane paneId="effort-home-return" sessionId={null} />)
    expect(screen.getByRole('button', { name: 'Medium' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Max' })).not.toBeInTheDocument()
  })

  it('does not display an unsupported persisted home effort as the current level', () => {
    saveModelVariantPref('openai:preview-model', 'xhigh')
    render(<PiChatPane paneId="effort-home-stale" sessionId={null} />)
    expect(screen.getByRole('button', { name: i18n.t('chat:inputToolbar.default') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Xhigh' })).not.toBeInTheDocument()
  })

  it('shows the original effort error and restores the authoritative current level', async () => {
    mocks.setThinking.mockRejectedValue(new Error('Native effort write rejected'))
    render(<PiChatPane paneId="effort-error" sessionId="native-session" />)
    const menu = await openEffortMenu()
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Max' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Native effort write rejected')
    expect(screen.getByRole('button', { name: 'Low' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Max' })).not.toBeInTheDocument()
  })

  it('does not publish a late effort error into a different session', async () => {
    const pending = Promise.withResolvers<void>()
    mocks.setThinking.mockReturnValue(pending.promise)
    const view = render(<PiChatPane paneId="effort-late" sessionId="native-session" />)
    const menu = await openEffortMenu()
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Max' }))
    view.rerender(<PiChatPane paneId="effort-late" sessionId="other-session" />)
    await act(async () => { pending.reject(new Error('Late native failure')) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Low' })).toBeInTheDocument()
  })
})
