import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { DshApiError, type DshAppSession, type DshHostListItem } from '../../../services/dshRemote'
import { dshControllerStore } from '../../../store/dshControllerStore'
import { DshRemoteConnectSettings, DshServerRows } from './DshRemoteSettings'

const mocks = vi.hoisted(() => ({ providers: vi.fn(), begin: vi.fn(), poll: vi.fn(), open: vi.fn() }))
vi.mock('../../../services/dshRemote', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/dshRemote')>(),
  listDshLoginProviders: mocks.providers,
  beginDshLogin: mocks.begin,
  pollDshLogin: mocks.poll,
  restoreDshPairedSession: () => null,
}))
vi.mock('../../../utils/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../../../utils/tauri')>(), isTauriMobile: () => true,
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.open }))
vi.mock('../../../store/serviceStore', () => ({ serviceStore: { envVarsRecord: {} } }))
vi.mock('../../../services/dshConnectionDiagnostics', () => ({ recordDshDiagnostic: vi.fn(), exportDshDiagnostics: () => '' }))
vi.mock('../../../utils/dshRemoteViewer', () => ({
  opensDshRemoteInApp: () => true,
  closeDshRemoteViewer: vi.fn(), openDshRemoteViewer: vi.fn(), watchDshRemoteViewer: vi.fn(),
}))
vi.mock('../../../components/QrCode', () => ({ QrCode: () => <div /> }))

function controller(hosts: DshHostListItem[] = []) {
  const listHosts = vi.fn().mockResolvedValue(hosts)
  const revoke = vi.fn().mockResolvedValue(undefined)
  const session = { listHosts, revoke, invalidate: vi.fn() } as unknown as DshAppSession
  return { session, listHosts, revoke }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.resetAllMocks()
  dshControllerStore.update({ session: null, hosts: [], browser: null, authError: null, signingIn: false })
  mocks.providers.mockResolvedValue([{ id: 'example', label: 'Example', start: '/api/v1/auth/oauth/qr/start?provider=example' }])
  mocks.begin.mockResolvedValue({ id: 'login-id', url: 'https://dsh.r2049.cn/login', expiresAt: Date.now() + 60_000 })
  mocks.poll.mockResolvedValue('pending')
  mocks.open.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DS remote server rows', () => {
  it('refreshes unknown presence independently and keeps the row while checking', async () => {
    const host = { id: 'office', name: 'Office' }
    const { session, listHosts } = controller([host])
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    const refresh = screen.getByRole('button', { name: 'Refresh DS remote computers' })
    expect(refresh).toBeDisabled()
    const row = await screen.findByTestId('dsh-server-row')
    expect(within(row).getByText('Unknown')).toBeInTheDocument()
    expect(row.querySelector('.cb-lamp')).toHaveAttribute('data-tone', 'warn')
    expect(within(row).getByRole('button', { name: 'Open' })).toBeEnabled()

    const next = deferred<DshHostListItem[]>()
    listHosts.mockReturnValueOnce(next.promise)
    fireEvent.click(refresh)
    expect(refresh).toBeDisabled()
    expect(within(row).getByText('Unknown')).toBeInTheDocument()
    await act(async () => next.resolve([{ ...host, online: true }]))
    expect(within(row).getByText('Online')).toBeInTheDocument()
    expect(row.querySelector('.cb-lamp')).toHaveAttribute('data-tone', 'on')
    expect(refresh).toBeEnabled()
    expect(listHosts).toHaveBeenCalledTimes(2)

    listHosts.mockResolvedValueOnce([{ ...host, online: false }])
    fireEvent.click(refresh)
    await waitFor(() => expect(within(row).getByText('Offline')).toBeInTheDocument())
    expect(within(row).getByRole('button', { name: 'Open' })).toBeDisabled()
  })

  it('offers a DS refresh after the initial request fails with no cached computers', async () => {
    const { session, listHosts } = controller()
    listHosts.mockRejectedValueOnce(new TypeError('Network unavailable'))
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load computers. Try again.')
    const refresh = screen.getByRole('button', { name: 'Refresh DS remote computers' })
    expect(refresh).toBeEnabled()
    listHosts.mockResolvedValueOnce([{ id: 'office', name: 'Office', online: true }])
    fireEvent.click(refresh)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(await screen.findByText('Online')).toBeInTheDocument()
    expect(listHosts).toHaveBeenCalledTimes(2)
  })

  it('keeps cached computers and reports a failed manual refresh', async () => {
    const { session, listHosts } = controller([{ id: 'office', name: 'Office' }])
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    await screen.findByText('Unknown')
    listHosts.mockRejectedValueOnce(new DshApiError('UNAVAILABLE', 503))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DS remote computers' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load computers.')
    expect(screen.getByText('Office')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh DS remote computers' })).toBeEnabled()
  })

  it('keeps a refresh entry for a successfully loaded empty list', async () => {
    const { session, listHosts } = controller()
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    await screen.findByText('No reachable computers on this account yet')
    listHosts.mockResolvedValueOnce([{ id: 'office', name: 'Office' }])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DS remote computers' }))
    expect(await screen.findByText('Office')).toBeInTheDocument()
  })

  it('shows an authorization failure even after the invalid session is cleared', async () => {
    const { session, listHosts } = controller()
    listHosts.mockRejectedValueOnce(new DshApiError('DSH_AUTH_INVALID', 401))
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    expect(await screen.findByRole('alert')).toHaveTextContent('This controller authorization is no longer valid. Sign in again.')
    expect(dshControllerStore.get().session).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh DS remote computers' })).not.toBeInTheDocument()
  })

  it('cancels an unfinished refresh when leaving the page', async () => {
    const { session, listHosts } = controller([{ id: 'office', name: 'Office' }])
    dshControllerStore.update({ session })
    const view = render(<DshServerRows />)
    await screen.findByText('Unknown')
    const next = deferred<DshHostListItem[]>()
    listHosts.mockReturnValueOnce(next.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DS remote computers' }))
    const signal = listHosts.mock.calls[1][0] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => next.resolve([{ id: 'office', name: 'Office', online: true }]))
    expect(dshControllerStore.get().hosts).toEqual([{ id: 'office', name: 'Office' }])
  })
})

async function startLogin() {
  vi.useFakeTimers()
  await act(async () => { render(<DshRemoteConnectSettings />) })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with Example' })))
  expect(screen.getByRole('heading', { name: 'Finish signing in' })).toBeInTheDocument()
}

const advance = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })

describe('DS remote authorization polling', () => {
  it('keeps the account available when logout cannot persist refreshed credentials', async () => {
    const { session, revoke } = controller()
    revoke.mockRejectedValueOnce(new DshApiError('DSH_STORAGE_FAILED', 0))
    dshControllerStore.update({ session })
    render(<DshRemoteConnectSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Could not read or save this device's authorization")
    expect(dshControllerStore.get().session).toBe(session)
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
  })

  it.each([
    ['network interruption', () => new TypeError('Failed to fetch')],
    ['request timeout', () => new DOMException('Timed out', 'TimeoutError')],
    ['rate limiting', () => new DshApiError('RATE_LIMITED', 429)],
    ['server error', () => new DshApiError('INTERNAL', 500)],
    ['service unavailable', () => new DshApiError('UNAVAILABLE', 503)],
  ])('keeps the same login after %s and clears the retry notice on recovery', async (_label, failure) => {
    const { session } = controller()
    mocks.poll.mockRejectedValueOnce(failure()).mockResolvedValueOnce('pending').mockResolvedValueOnce(session)
    await startLogin()
    await advance(2_000)
    expect(screen.getByRole('heading', { name: 'Finish signing in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Retrying automatically')
    expect(dshControllerStore.get().signingIn).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await advance(2_000)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await advance(2_000)
    expect(dshControllerStore.get().session).toBe(session)
    expect(mocks.begin).toHaveBeenCalledOnce()
    expect(mocks.poll.mock.calls.map(call => call[0])).toEqual(['login-id', 'login-id', 'login-id'])
  })

  it.each([
    ['unauthorized', () => new DshApiError('UNAUTHORIZED', 401)],
    ['forbidden', () => new DshApiError('FORBIDDEN', 403)],
    ['missing login', () => new DshApiError('NOT_FOUND', 404)],
    ['invalid response', () => new Error('Invalid DSH login response')],
    ['invalid protocol', () => new DshApiError('PROTOCOL', 0)],
  ])('ends the login on %s without polling again', async (_label, failure) => {
    mocks.poll.mockRejectedValueOnce(failure())
    await startLogin()
    await advance(2_000)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not sign in.')
    expect(screen.queryByRole('heading', { name: 'Finish signing in' })).not.toBeInTheDocument()
    await advance(10_000)
    expect(mocks.poll).toHaveBeenCalledOnce()
    expect(dshControllerStore.get().signingIn).toBe(false)
  })

  it('ends retrying at the authorization deadline without another request', async () => {
    mocks.begin.mockResolvedValue({ id: 'login-id', url: 'https://dsh.r2049.cn/login', expiresAt: Date.now() + 3_000 })
    mocks.poll.mockRejectedValue(new TypeError('Failed to fetch'))
    await startLogin()
    await advance(2_000)
    expect(screen.getByRole('status')).toHaveTextContent('Retrying automatically')
    await advance(1_000)
    expect(screen.getByRole('alert')).toHaveTextContent('The authorization expired. Sign in again.')
    expect(mocks.poll).toHaveBeenCalledOnce()
  })

  it('stops a scheduled retry when the user cancels', async () => {
    mocks.poll.mockRejectedValue(new TypeError('Failed to fetch'))
    await startLogin()
    await advance(2_000)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await advance(10_000)
    expect(mocks.poll).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not repeat a completed QR login when device registration fails', async () => {
    mocks.poll.mockImplementationOnce(async (_id: string, _signal: AbortSignal, options: { onComplete?: () => void }) => {
      options.onComplete?.()
      throw new TypeError('Registration response lost')
    })
    await startLogin()
    await advance(2_000)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not sign in.')
    await advance(10_000)
    expect(mocks.poll).toHaveBeenCalledOnce()
    expect(mocks.begin).toHaveBeenCalledOnce()
  })
})
