import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseServiceDialog } from '../components/CloseServiceDialog'
import { useCloseServiceDialog } from './useCloseServiceDialog'
import i18n from '../i18n'

const mocks = vi.hoisted(() => ({
  desktop: true,
  mobile: false,
  listen: vi.fn(),
  invoke: vi.fn(),
  reportError: vi.fn(),
  unlisten: vi.fn(),
}))
vi.mock('../utils/tauri', () => ({ isTauri: () => mocks.desktop, isTauriMobile: () => mocks.mobile }))
vi.mock('../utils', () => ({ uiErrorHandler: mocks.reportError }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

function Harness() {
  const state = useCloseServiceDialog()
  return <CloseServiceDialog isOpen={state.showCloseDialog} closeToTray={state.closeToTray} onConfirm={state.confirmClose} onCancel={state.cancelClose} />
}

let closeRequest: (event: { payload: { closeToTray: boolean; exitApp: boolean } }) => void
beforeEach(async () => {
  await i18n.changeLanguage('en')
  mocks.desktop = true
  mocks.mobile = false
  vi.clearAllMocks()
  mocks.invoke.mockReset().mockResolvedValue(undefined)
  mocks.listen.mockImplementation(async (_name, callback) => { closeRequest = callback; return mocks.unlisten })
})
afterEach(cleanup)

async function requestClose(payload = { closeToTray: true, exitApp: false }) {
  await waitFor(() => expect(mocks.listen).toHaveBeenCalledWith('close-requested', expect.any(Function)))
  act(() => closeRequest({ payload }))
}

describe('desktop close confirmation', () => {
  it('hides to tray, clears the dialog and allows a later close request', async () => {
    render(<Harness />)
    await requestClose()
    fireEvent.click(screen.getByRole('button', { name: 'Hide to tray and keep backend running' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('confirm_close_app', { stopService: false, exitApp: false }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument())
    await requestClose()
    expect(screen.getByRole('button', { name: 'Hide to tray and keep backend running' })).toBeEnabled()
  })

  it('preserves the old close behavior when the preference is off', async () => {
    render(<Harness />)
    await requestClose({ closeToTray: false, exitApp: false })
    expect(screen.queryByText('Hide to tray and keep backend running')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close and keep backend running' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('confirm_close_app', { stopService: false, exitApp: false }))
  })

  it('quits from the tray instead of hiding again, with an explicit stop choice', async () => {
    render(<Harness />)
    await requestClose({ closeToTray: false, exitApp: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop backend' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('confirm_close_app', { stopService: true, exitApp: true }))
  })

  it('cannot dismiss the confirmation while native stop is in progress', async () => {
    let finish!: () => void
    mocks.invoke.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    render(<Harness />)
    await requestClose()
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop backend' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText('Closing...')).toBeInTheDocument()
    await act(async () => finish())
    await waitFor(() => expect(screen.queryByText('Closing...')).not.toBeInTheDocument())
  })

  it('cancel performs no native close and a failed native close can be retried', async () => {
    render(<Harness />)
    await requestClose()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.invoke).not.toHaveBeenCalled()
    await requestClose()
    mocks.invoke.mockRejectedValueOnce('stop failed')
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop backend' }))
    await waitFor(() => expect(mocks.reportError).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Close and stop backend' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop backend' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2))
  })

  it.each(['browser', 'mobile'])('does not subscribe in %s', async platform => {
    mocks.desktop = platform === 'mobile'
    mocks.mobile = platform === 'mobile'
    render(<Harness />)
    await act(async () => {})
    expect(mocks.listen).not.toHaveBeenCalled()
  })

  it('unsubscribes when native registration finishes after unmount', async () => {
    let register!: (stop: () => void) => void
    mocks.listen.mockReturnValueOnce(new Promise(resolve => { register = resolve }))
    const view = render(<Harness />)
    await waitFor(() => expect(mocks.listen).toHaveBeenCalled())
    view.unmount()
    await act(async () => register(mocks.unlisten))
    expect(mocks.unlisten).toHaveBeenCalledOnce()
  })
})
