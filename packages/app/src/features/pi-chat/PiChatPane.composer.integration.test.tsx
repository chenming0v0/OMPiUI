import { forwardRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Model, Api } from '../../omp/vendor/pi-ai'
import { serverStore, LOCAL_SERVER_ID } from '../../store/serverStore'
import { notificationStore } from '../../store/notificationStore'
import { clearSessionEditorDraft, setSessionEditorDraft } from '../../omp/sessionEditorDraftStore'
import type { Attachment } from '../attachment'
import { composerDraftKey, getComposerDraft, updateComposerDraft } from '../chat/input/composerDraftStore'
import { pendingSendStore } from './pendingSendStore'
import { PiChatPane } from './PiChatPane'

const mocks = vi.hoisted(() => ({
  models: [] as Model<Api>[],
  state: null as { model: { provider: string; id: string }; thinkingLevel: string; isStreaming?: boolean } | null,
  branch: { items: [] },
  loadModels: vi.fn(), loadSession: vi.fn(), setModel: vi.fn(), setThinking: vi.fn(),
  refreshState: vi.fn(), refreshBranch: vi.fn(), openSession: vi.fn(), sendMessage: vi.fn(),
  interrupt: vi.fn(), editorState: vi.fn(), slashCommands: vi.fn(), completions: vi.fn(),
}))

// Only the data/transport boundary and unrelated pane surfaces are replaced.
// InputBox, its submit/restore effects, toolbar, slash menu and attachment UI are real.
vi.mock('../../omp/hooks/index.js', () => ({
  usePiModels: () => ({ models: mocks.models, isLoading: false }),
  usePiBranchData: () => mocks.branch,
  usePiBranchError: () => null,
  usePiSessionRuntimeState: (sessionId: string | null) => sessionId ? mocks.state : null,
  useFocusedSessionId: () => null,
  usePiSessionTodos: () => [],
}))
vi.mock('../../omp/controllers/index.js', () => ({
  loadPiModels: mocks.loadModels, loadPiSessionData: mocks.loadSession,
  setPiModel: mocks.setModel, setPiThinkingLevel: mocks.setThinking,
  refreshPiSessionState: mocks.refreshState, refreshPiBranch: mocks.refreshBranch,
  openPiSession: mocks.openSession, sendPiUserMessage: mocks.sendMessage,
  abortAndPrompt: mocks.interrupt, setPiExtensionEditorState: mocks.editorState,
  loadPiSlashCommands: mocks.slashCommands,
  abortPiOperation: vi.fn(), abortPiCompaction: vi.fn(), cyclePiModel: vi.fn(),
  cyclePiThinkingLevel: vi.fn(), forkPiSession: vi.fn(), loadMorePiBranchEntries: vi.fn(),
  prefetchPiBranchEntries: vi.fn(), returnToLatestPiBranch: vi.fn(), navigatePiTree: vi.fn(),
}))
vi.mock('../../omp/transport/index.js', () => ({
  getPiCommandCompletions: mocks.completions,
  manageSessionGoal: vi.fn(), removeQueuedMessage: vi.fn(), discardQueuedMessage: vi.fn(),
  sendQueuedMessage: vi.fn(), waitHostCommand: vi.fn(), getPiTree: vi.fn(),
}))
vi.mock('../../omp/capabilities', () => ({
  usePiCapabilities: () => ({ promptSteer: true, promptFollowUp: true, promptInterrupt: true }),
}))
vi.mock('../../omp/eventStream.js', () => ({ piEventStream: { connect: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../omp/state/index.js', () => ({
  piBranchStore: { getData: () => mocks.branch },
  piSessionStateStore: { getState: () => mocks.state, subscribe: () => () => {} },
}))
vi.mock('../../omp/managementEventStore', () => ({ useManagementEvents: () => ({ providerRevision: 0 }) }))
vi.mock('../../contexts/useDirectory', () => ({ useDirectory: () => ({ currentDirectory: '/workspace', addDirectory: vi.fn() }) }))
vi.mock('../../contexts/useSessionContext', () => ({ useSessionContext: () => ({ sessions: [], registerSession: vi.fn() }) }))
vi.mock('../../store/activeSessionStore', () => ({ useSessionActiveEntry: () => null }))
vi.mock('../../omp/redoPlanStore', () => ({
  redoPlanStore: { subscribe: () => () => {}, getPlan: () => null },
  captureRedoCheckpoints: vi.fn(), commitRedoPlan: vi.fn(),
}))
vi.mock('../../contexts/useFullscreen', () => ({
  useFullscreen: () => ({ openFullscreen: vi.fn(), updateFullscreen: vi.fn(), closeFullscreen: vi.fn() }),
}))
vi.mock('../../components/OutlineIndex', () => ({ OutlineIndex: () => null }))
vi.mock('../chat/ExtensionUiDialogHost.js', () => ({ ExtensionUiDialogHost: () => null }))
vi.mock('../chat/ExtensionUiSurface', () => ({ ExtensionUiSurface: () => null }))
vi.mock('../chat/PaneHeader.js', () => ({ PaneHeader: () => null }))
vi.mock('../chat/PaneDropOverlay.js', () => ({ PaneDropOverlay: forwardRef(() => null), resolveDropZone: vi.fn() }))
vi.mock('../chat/FolderProjectDropOverlay.js', () => ({ FolderProjectDropOverlay: () => null }))
vi.mock('../chat/useFolderProjectDrop.js', () => ({ useFolderProjectDrop: () => false }))
vi.mock('../chat/index.js', async () => ({
  InputBox: (await import('../chat/InputBox')).InputBox,
  ChatArea: forwardRef(() => null), Header: () => null,
}))

const sentImage: Attachment = {
  id: 'submitted-photo', type: 'file', displayName: 'submitted.png',
  url: 'data:image/png;base64,c2VudA==', mime: 'image/png',
}
const commandText = '/export --themes "a b.html"\nkeep whitespace'
let sequence = 0
let sessionId: string
let paneId: string
let draftKey: string

function seed(text: string, attachments: Attachment[] = []) {
  updateComposerDraft(draftKey, () => ({ text, attachments, ready: true }))
}
function send() {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:inputToolbar.sendMessage') }))
}
function retry() {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:chatArea.retrySend') }))
}
async function frames() {
  // The real restore bridge runs on rAF; flush it before asserting preservation.
  await act(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
}
async function addImage(view: ReturnType<typeof render>, name = 'new.png') {
  const input = view.container.querySelector('input[type="file"]')!
  fireEvent.change(input, { target: { files: [new File(['new image'], name, { type: 'image/png' })] } })
  await waitFor(() => expect(getComposerDraft(draftKey).attachments.some(a => a.displayName === name)).toBe(true))
  return getComposerDraft(draftKey).attachments.find(a => a.displayName === name)!
}
function removeAttachment(name: string) {
  const label = screen.getByText(name)
  const card = label.closest('div.relative')!
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: i18n.t('commands:attachment.removeAttachment') }))
}
async function selectExport() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/exp', selectionStart: 4 } })
  fireEvent.click(await screen.findByRole('button', { name: /\/export/ }))
  await frames()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: commandText } })
  return getComposerDraft(draftKey).attachments.find(a => a.type === 'command')!
}

beforeEach(async () => {
  serverStore.setActiveServer(LOCAL_SERVER_ID)
  localStorage.clear()
  vi.resetAllMocks()
  pendingSendStore.reset()
  await i18n.changeLanguage('en')
  sequence += 1
  sessionId = `composer-session-${sequence}`
  paneId = `composer-pane-${sequence}`
  draftKey = composerDraftKey(serverStore.getActiveServer(), sessionId, '', '')
  mocks.models = [{
    id: 'preview-model', name: 'preview-model', provider: 'openai', api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text', 'image'],
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, contextWindow: 128000, maxTokens: 32000,
  }]
  mocks.state = { model: { provider: 'openai', id: 'preview-model' }, thinkingLevel: 'off' }
  for (const mock of [mocks.loadSession, mocks.refreshState, mocks.refreshBranch, mocks.setModel, mocks.setThinking, mocks.editorState]) mock.mockResolvedValue(undefined)
  mocks.loadModels.mockResolvedValue(mocks.models)
  mocks.slashCommands.mockResolvedValue([{ name: 'export', description: 'Export session', source: 'builtin' }])
  mocks.completions.mockResolvedValue([])
  // No server or provider is allowed, even if an unmocked component tries to fetch.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden in composer integration')))
  // jsdom has no IndexedDB; these tests exercise live shared-store/remount semantics.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  clearSessionEditorDraft(sessionId)
  pendingSendStore.reset()
  expect(fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PiChatPane with the real composer', () => {
  it.each(['modified text', 'new image', 'deleted image', 'pure image', 'empty draft'] as const)(
    'keeps pending edits after a rejected slash command: %s, including remount', async edit => {
      seed(commandText, [sentImage])
      const submission = Promise.withResolvers<void>()
      mocks.sendMessage.mockReturnValue(submission.promise)
      const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
      send()
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
      expect(mocks.sendMessage).toHaveBeenCalledWith(sessionId, commandText, [{ type: 'image', mimeType: 'image/png', data: 'c2VudA==' }], 'followUp')
      expect(pendingSendStore.getSnapshot()).toHaveLength(1)
      if (edit === 'modified text') fireEvent.change(screen.getByRole('textbox'), { target: { value: '/export changed\nnew draft' } })
      if (edit === 'new image') await addImage(view)
      if (edit === 'deleted image' || edit === 'empty draft') removeAttachment(sentImage.displayName)
      if (edit === 'pure image' || edit === 'empty draft') fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
      const latest = getComposerDraft(draftKey)
      await act(async () => { submission.reject(new Error('slash rejected')) })
      await screen.findByRole('alert')
      await frames()
      expect(screen.getByRole('textbox')).toHaveValue(latest.text)
      expect(getComposerDraft(draftKey).attachments).toEqual(latest.attachments)
      expect(pendingSendStore.getSnapshot()).toEqual([])
      expect(notificationStore.getSnapshot().toasts.some(toast => toast.notification.title === i18n.t('chat:chatArea.sendFailedTitle'))).toBe(true)
      view.unmount()
      render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
      await frames()
      expect(screen.getByRole('textbox')).toHaveValue(latest.text)
      expect(getComposerDraft(draftKey).attachments).toEqual(latest.attachments)
    },
  )

  it('keeps an unchanged failure, including its real slash chip and image', async () => {
    seed('', [sentImage])
    mocks.sendMessage.mockRejectedValue(new Error('slash rejected'))
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    const chip = await selectExport()
    expect(chip).toBeDefined()
    const latest = getComposerDraft(draftKey)
    send()
    await screen.findByRole('alert')
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue(commandText)
    expect(getComposerDraft(draftKey).attachments).toEqual(latest.attachments)
    view.unmount()
    render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue(commandText)
    expect(getComposerDraft(draftKey).attachments).toEqual(latest.attachments)
  })

  it('keeps a pure-image draft and a newly added image on rejection', async () => {
    seed('', [sentImage])
    const submission = Promise.withResolvers<void>()
    mocks.sendMessage.mockReturnValue(submission.promise)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    send()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    const next = await addImage(view)
    await act(async () => { submission.reject(new Error('image rejected')) })
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({ text: '', attachments: [sentImage, next] })
  })

  it('cleans only an accepted snapshot and retains a later text/image/chip draft', async () => {
    seed(commandText, [sentImage])
    const submission = Promise.withResolvers<void>()
    mocks.sendMessage.mockReturnValue(submission.promise)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    send()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    const chip = await selectExport()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/export later draft' } })
    const next = await addImage(view)
    await act(async () => { submission.resolve() })
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({ text: '/export later draft', attachments: [chip, next] })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(pendingSendStore.getSnapshot()).toEqual([])
    view.unmount()
    render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    expect(screen.getByRole('textbox')).toHaveValue('/export later draft')
  })

  it.each(['unchanged', 'new text/image/chip', 'identical new image'] as const)(
    'retry accepts the original payload/delivery and cleans only its snapshot: %s', async edit => {
      seed('', [sentImage])
      mocks.state!.isStreaming = true
      const failure = Promise.withResolvers<void>()
      const retried = Promise.withResolvers<void>()
      mocks.sendMessage.mockReturnValueOnce(failure.promise).mockReturnValueOnce(retried.promise)
      const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
      await selectExport()
      const delivery = screen.getByRole('button', { name: `${i18n.t('chat:inputToolbar.deliveryMode')}: Follow-up` })
      fireEvent.click(delivery)
      expect(delivery).toHaveAccessibleName(`${i18n.t('chat:inputToolbar.deliveryMode')}: Steer`)
      const original = getComposerDraft(draftKey)
      send()
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
      await act(async () => { failure.reject(new Error('retry me')) })
      await screen.findByRole('alert')
      await frames()
      retry()
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
      expect(mocks.sendMessage.mock.calls[1]).toEqual(mocks.sendMessage.mock.calls[0])
      expect(mocks.sendMessage.mock.calls[1][3]).toBe('steer')
      expect(pendingSendStore.getSnapshot()).toHaveLength(1)
      let retained: Attachment[] = []
      let retainedText = ''
      if (edit === 'new text/image/chip') {
        const chip = await selectExport()
        retainedText = '/export later retry draft'
        fireEvent.change(screen.getByRole('textbox'), { target: { value: retainedText } })
        retained = [chip, await addImage(view)]
      } else if (edit === 'identical new image') {
        const replacement = { ...sentImage }
        act(() => updateComposerDraft(draftKey, current => ({ ...current, attachments: current.attachments.map(a => a === sentImage ? replacement : a) })))
        retained = [replacement]
      }
      await act(async () => { retried.resolve() })
      await frames()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(pendingSendStore.getSnapshot()).toEqual([])
      expect(getComposerDraft(draftKey)).toMatchObject({ text: retainedText, attachments: retained })
      expect(getComposerDraft(draftKey).attachments).not.toContain(original.attachments.find(a => a.type === 'command'))
      view.unmount()
      render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
      await frames()
      expect(screen.getByRole('textbox')).toHaveValue(retainedText)
      expect(getComposerDraft(draftKey).attachments).toEqual(retained)
    },
  )

  it('clears an unchanged Undo/Fork restore marker on retry acceptance so remount cannot resurrect it', async () => {
    setSessionEditorDraft(sessionId, commandText, { attachments: [sentImage], sync: false })
    mocks.sendMessage.mockRejectedValueOnce(new Error('restored send rejected')).mockResolvedValueOnce(undefined)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue(commandText)
    expect(getComposerDraft(draftKey).attachments).toEqual([sentImage])
    send()
    await screen.findByRole('alert')
    retry()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({ text: '', attachments: [] })
    view.unmount()
    render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(getComposerDraft(draftKey)).toMatchObject({ text: '', attachments: [] })
  })

  it('keeps edits to a restored draft during retry acceptance', async () => {
    setSessionEditorDraft(sessionId, commandText, { attachments: [sentImage], sync: false })
    const retried = Promise.withResolvers<void>()
    mocks.sendMessage.mockRejectedValueOnce(new Error('restored send rejected')).mockReturnValueOnce(retried.promise)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    await frames()
    send()
    await screen.findByRole('alert')
    retry()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
    const nextText = '/export edited restore during retry'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: nextText } })
    const next = await addImage(view)
    await act(async () => { retried.resolve() })
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue(nextText)
    expect(getComposerDraft(draftKey)).toMatchObject({ text: nextText, attachments: [next] })
    expect(mocks.editorState).toHaveBeenLastCalledWith(sessionId, nextText)
  })

  it('retains the original retry snapshot through another rejection without replacing newer edits', async () => {
    seed('', [sentImage])
    const rejectedAgain = Promise.withResolvers<void>()
    mocks.sendMessage.mockRejectedValueOnce(new Error('first rejection'))
      .mockReturnValueOnce(rejectedAgain.promise).mockResolvedValueOnce(undefined)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    await selectExport()
    const originalText = getComposerDraft(draftKey).text
    send()
    await screen.findByRole('alert')
    retry()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
    const chip = await selectExport()
    const latestText = '/export retry edits'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: latestText } })
    const next = await addImage(view)
    await act(async () => { rejectedAgain.reject(new Error('second rejection')) })
    await screen.findByRole('alert')
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({ text: latestText, attachments: [sentImage, chip, next] })
    expect(pendingSendStore.getSnapshot()).toEqual([])
    retry()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(3))
    await frames()
    expect(mocks.sendMessage.mock.calls.map(call => call[1])).toEqual([originalText, originalText, originalText])
    expect(getComposerDraft(draftKey)).toMatchObject({ text: latestText, attachments: [chip, next] })
  })

  it('keeps newer edits made before clicking retry, including the original text chip', async () => {
    seed('', [sentImage])
    mocks.sendMessage.mockRejectedValueOnce(new Error('first rejection')).mockResolvedValueOnce(undefined)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    const originalChip = await selectExport()
    send()
    await screen.findByRole('alert')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/export arguments edited before retry' } })
    const next = await addImage(view)
    retry()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({
      text: '/export arguments edited before retry', attachments: [originalChip, next],
    })
    expect(mocks.sendMessage.mock.calls[1]).toEqual(mocks.sendMessage.mock.calls[0])
  })

  it('does not clean a different session when retry acceptance arrives after navigation', async () => {
    seed(commandText, [sentImage])
    const submission = Promise.withResolvers<void>()
    mocks.sendMessage.mockRejectedValueOnce(new Error('first rejection')).mockReturnValueOnce(submission.promise)
    const view = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    send()
    await screen.findByRole('alert')
    retry()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
    const otherSession = `${sessionId}-other`
    const otherKey = composerDraftKey(serverStore.getActiveServer(), otherSession, '', '')
    updateComposerDraft(otherKey, () => ({ text: commandText, attachments: [sentImage], ready: true }))
    view.rerender(<PiChatPane paneId={paneId} sessionId={otherSession} />)
    await act(async () => { submission.resolve() })
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue(commandText)
    expect(getComposerDraft(otherKey)).toMatchObject({ text: commandText, attachments: [sentImage] })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(pendingSendStore.getSnapshot()).toEqual([])
  })

  it('keeps the live shared draft when failure arrives after the original pane unmounts', async () => {
    seed(commandText, [sentImage])
    const submission = Promise.withResolvers<void>()
    mocks.sendMessage.mockReturnValue(submission.promise)
    const first = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    send()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    first.unmount()
    const second = render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    const next = await addImage(second)
    removeAttachment(sentImage.displayName)
    await act(async () => { submission.reject(new Error('late failure')) })
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({ text: '', attachments: [next] })
    expect(pendingSendStore.getSnapshot()).toEqual([])
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('migrates a home draft, then preserves edits when the first command fails', async () => {
    const homeKey = composerDraftKey(serverStore.getActiveServer(), null, '/workspace', paneId)
    updateComposerDraft(homeKey, () => ({ text: commandText, attachments: [sentImage], ready: true }))
    mocks.openSession.mockResolvedValue({ sessionId, cwd: '/workspace' })
    const submission = Promise.withResolvers<void>()
    mocks.sendMessage.mockReturnValue(submission.promise)
    function Home() {
      const [sid, setSid] = useState<string | null>(null)
      return <PiChatPane paneId={paneId} sessionId={sid} onEnterSession={setSid} />
    }
    const view = render(<Home />)
    send()
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    expect(getComposerDraft(homeKey)).toMatchObject({ text: '', attachments: [] })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    const next = await addImage(view)
    removeAttachment(sentImage.displayName)
    await act(async () => { submission.reject(new Error('first command rejected')) })
    await screen.findByRole('alert')
    await frames()
    expect(getComposerDraft(draftKey)).toMatchObject({ text: '', attachments: [next] })
    view.unmount()
    render(<PiChatPane paneId={paneId} sessionId={sessionId} />)
    await frames()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(getComposerDraft(draftKey).attachments).toEqual([next])
  })
})
