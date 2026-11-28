import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { DshApiError, type DshAppSession, type DshHostListItem } from '../../../services/dshRemote'
import { dshControllerStore } from '../../../store/dshControllerStore'
import { DshRemoteConnectSettings, DshServerRows } from './DshRemoteSettings'

const mocks = vi.hoisted(() => ({
  providers: vi.fn(), begin: vi.fn(), poll: vi.fn(), open: vi.fn(), connect: vi.fn(), viewer: vi.fn(), resolve: vi.fn(), select: vi.fn(),
}))
vi.mock('./useServerConnect', () => ({ useServerSelect: () => mocks.select }))
vi.mock('../../../services/dshServerConnection', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/dshServerConnection')>(), connectDshServer: mocks.connect,
}))
vi.mock('../../../services/dshRemote', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/dshRemote')>(),
  listDshLoginProviders: mocks.providers,
  beginDshLogin: mocks.begin,
  pollDshLogin: mocks.poll,
  resolveDshPairing: mocks.resolve,
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
  closeDshRemoteViewer: vi.fn(), openDshRemoteViewer: mocks.viewer, watchDshRemoteViewer: vi.fn(),
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
  dshControllerStore.update({ session: null, hosts: [], connection: null, authError: null, signingIn: false, pairRequest: null })
  mocks.providers.mockResolvedValue([{ id: 'example', label: 'Example', start: '/api/v1/auth/oauth/qr/start?provider=example' }])
  mocks.begin.mockResolvedValue({ id: 'login-id', url: 'https://dsh.r2049.cn/login', expiresAt: Date.now() + 60_000 })
  mocks.poll.mockResolvedValue('pending')
  mocks.open.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const rowButton = (row: HTMLElement) => row.querySelector('.cb-srv-main') as HTMLButtonElement
const presence = (row: HTMLElement) => within(row).getByRole('button', { name: /^Office · / })

describe('DS remote server rows', () => {
  it('connects a DS server by clicking its row, without opening a viewer', async () => {
    const { session } = controller([{ id: 'office', name: 'Office', online: true }])
    const select = vi.fn()
    dshControllerStore.update({ session })
    mocks.connect.mockImplementation(async (_session, hostId, _name, onSelect) => {
      onSelect(`dsh:${hostId}`)
      dshControllerStore.update({ connection: { hostId, serverId: `dsh:${hostId}`, phase: 'connected' } })
    })
    render(<DshServerRows onSelectServer={select} />)
    const row = await screen.findByTestId('dsh-server-row')
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    fireEvent.click(rowButton(row))
    await waitFor(() => expect(select).toHaveBeenCalledWith('dsh:office'))
    expect(mocks.connect).toHaveBeenCalledWith(session, 'office', 'Office', select)
    expect(row).toHaveAttribute('data-current')
    expect(rowButton(row)).toHaveAttribute('aria-current', 'true')
    // 已经是当前服务器的那一行再点不会重连。
    fireEvent.click(rowButton(row))
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.viewer).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('refreshes unknown presence from the row status and keeps the row while checking', async () => {
    const host = { id: 'office', name: 'Office' }
    const { session, listHosts } = controller([host])
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    const row = await screen.findByTestId('dsh-server-row')
    expect(presence(row)).toHaveAccessibleName('Office · Unknown')
    expect(presence(row)).toHaveAttribute('data-tone', 'warn')
    expect(rowButton(row)).toBeEnabled()

    const next = deferred<DshHostListItem[]>()
    listHosts.mockReturnValueOnce(next.promise)
    fireEvent.click(presence(row))
    expect(presence(row)).toBeDisabled()
    expect(presence(row)).toHaveAccessibleName('Office · Unknown')
    await act(async () => next.resolve([{ ...host, online: true }]))
    expect(presence(row)).toHaveAccessibleName('Office · Online')
    expect(presence(row)).toHaveAttribute('data-tone', 'on')
    expect(presence(row)).toBeEnabled()
    expect(listHosts).toHaveBeenCalledTimes(2)

    listHosts.mockResolvedValueOnce([{ ...host, online: false }])
    fireEvent.click(presence(row))
    await waitFor(() => expect(presence(row)).toHaveAccessibleName('Office · Offline'))
    expect(rowButton(row)).toBeDisabled()
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
    expect(await screen.findByRole('button', { name: 'Office · Online' })).toBeInTheDocument()
    expect(listHosts).toHaveBeenCalledTimes(2)
  })

  it('keeps cached computers and reports a failed manual refresh', async () => {
    const { session, listHosts } = controller([{ id: 'office', name: 'Office' }])
    dshControllerStore.update({ session })
    render(<DshServerRows />)
    const row = await screen.findByTestId('dsh-server-row')
    listHosts.mockRejectedValueOnce(new DshApiError('UNAVAILABLE', 503))
    fireEvent.click(presence(row))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load computers.')
    expect(screen.getByText('Office')).toBeInTheDocument()
    expect(presence(row)).toHaveAccessibleName('Office · Unknown')
    expect(presence(row)).toBeEnabled()
  })

  it('rereads the list when the page refresh is pressed, leaving an empty account without rows', async () => {
    const { session, listHosts } = controller()
    dshControllerStore.update({ session })
    const view = render(<DshServerRows refreshKey={0} />)
    await waitFor(() => expect(listHosts).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('dsh-server-row')).not.toBeInTheDocument()
    expect(screen.queryByText('No reachable computers on this account yet')).not.toBeInTheDocument()
    listHosts.mockResolvedValueOnce([{ id: 'office', name: 'Office' }])
    view.rerender(<DshServerRows refreshKey={1} />)
    expect(await screen.findByText('Office')).toBeInTheDocument()
    expect(listHosts).toHaveBeenCalledTimes(2)
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
    const row = await screen.findByTestId('dsh-server-row')
    const next = deferred<DshHostListItem[]>()
    listHosts.mockReturnValueOnce(next.promise)
    fireEvent.click(presence(row))
    const signal = listHosts.mock.calls[1][0] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => next.resolve([{ id: 'office', name: 'Office', online: true }]))
    expect(dshControllerStore.get().hosts).toEqual([{ id: 'office', name: 'Office' }])
  })
})

describe('DS remote group on the controller page', () => {
  it('stays folded and asks the hosted service for nothing until it is opened', async () => {
    render(<DshRemoteConnectSettings />)
    const group = screen.getByRole('button', { name: /DS remote/ })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(group).toHaveTextContent('Not signed in')
    await act(async () => {})
    expect(mocks.providers).not.toHaveBeenCalled()
    fireEvent.click(group)
    expect(group).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('button', { name: 'Sign in with Example' })).toBeVisible()
    expect(mocks.providers).toHaveBeenCalledOnce()
    // 扫码只有「服务器」页那一个入口。
    expect(screen.queryByRole('button', { name: /scan/i })).not.toBeInTheDocument()
  })

  it('lists the account’s computers as rows and signs out from the group header', async () => {
    const { session, revoke } = controller([{ id: 'office', name: 'Office', online: true }, { id: 'laptop', name: 'Laptop', online: false }])
    dshControllerStore.update({ session })
    render(<DshRemoteConnectSettings defaultOpen />)
    expect(await screen.findAllByTestId('dsh-server-row')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /^DS remote/ })).toHaveTextContent('1 online')
    fireEvent.click(rowButton(screen.getAllByTestId('dsh-server-row')[0]))
    expect(mocks.connect).toHaveBeenCalledWith(session, 'office', 'Office', mocks.select)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })))
    expect(revoke).toHaveBeenCalledOnce()
    expect(dshControllerStore.get().session).toBeNull()
  })

  it('picks up a DS pairing code scanned on the Servers page and asks which computer it is', async () => {
    const pairing = { computer: { name: 'Studio PC', fingerprint: 'aaaa bbbb' }, claim: vi.fn(), poll: vi.fn(), cancel: vi.fn() }
    mocks.resolve.mockResolvedValue(pairing)
    dshControllerStore.update({ pairRequest: 'https://dsh.r2049.cn/pair#v1.ticket' })
    render(<DshRemoteConnectSettings />)
    expect(await screen.findByRole('heading', { name: 'Connect to this computer?' })).toBeVisible()
    expect(mocks.resolve).toHaveBeenCalledWith('https://dsh.r2049.cn/pair#v1.ticket', expect.any(AbortSignal))
    expect(mocks.resolve).toHaveBeenCalledOnce()
    expect(dshControllerStore.get().pairRequest).toBeNull()
    expect(screen.getByText('Studio PC')).toBeInTheDocument()
    expect(screen.getByText('aaaa bbbb')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /DS remote/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not stack a QR pairing on top of an account that is already signed in', async () => {
    const { session } = controller([{ id: 'office', name: 'Office', online: true }])
    dshControllerStore.update({ session, pairRequest: 'https://dsh.r2049.cn/pair#v1.ticket' })
    render(<DshRemoteConnectSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out first to pair by QR code.')
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(dshControllerStore.get().pairRequest).toBeNull()
    expect(dshControllerStore.get().session).toBe(session)
  })

  it('explains a scanned code the service does not accept', async () => {
    mocks.resolve.mockRejectedValue(new DshApiError('PAIRING_NOT_FOUND', 404))
    dshControllerStore.update({ pairRequest: 'https://dsh.r2049.cn/pair#v1.expired' })
    render(<DshRemoteConnectSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/i)
  })
})

async function startLogin() {
  vi.useFakeTimers()
  await act(async () => { render(<DshRemoteConnectSettings defaultOpen />) })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with Example' })))
  expect(screen.getByRole('heading', { name: 'Finish signing in' })).toBeInTheDocument()
}

const advance = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })

describe('DS remote authorization polling', () => {
  it('keeps the account available when logout cannot persist refreshed credentials', async () => {
    const { session, revoke } = controller()
    revoke.mockRejectedValueOnce(new DshApiError('DSH_STORAGE_FAILED', 0))
    dshControllerStore.update({ session })
    render(<DshRemoteConnectSettings defaultOpen />)
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
