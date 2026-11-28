import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dshControllerStore } from '../../../store/dshControllerStore'
import { ServersSettings } from './ServersSettings'
import { receiveBackendRuntimeHealth } from '../../../store/backendRuntimeHealth'

const { useServerStoreMock, navigateHomeMock, clearSessionMock, redeemMock, redeemCodeMock, nativeMock, mobileMock, disconnectMock, scanMock, parseScanMock } = vi.hoisted(() => ({
  parseScanMock: vi.fn(),
  useServerStoreMock: vi.fn(),
  navigateHomeMock: vi.fn(),
  clearSessionMock: vi.fn(),
  redeemMock: vi.fn(),
  redeemCodeMock: vi.fn(),
  nativeMock: vi.fn(() => false),
  mobileMock: vi.fn(() => false),
  disconnectMock: vi.fn(),
  scanMock: vi.fn(),
}))

vi.mock('../../../utils/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../../../utils/tauri')>(), isTauri: nativeMock, isTauriMobile: mobileMock,
}))
vi.mock('../../../utils/qrScanner', () => ({ scanPairingQr: scanMock }))
vi.mock('@ompiui/protocol/dsh-remote', async importOriginal => ({
  ...await importOriginal<typeof import('@ompiui/protocol/dsh-remote')>(), parseDshPairingScan: parseScanMock,
}))
vi.mock('../../../services/dshServerConnection', () => ({ disconnectDshServer: disconnectMock }))
vi.mock('./DshRemoteSettings', () => ({
  DshServerRows: ({ onSelectServer, refreshKey }: { onSelectServer: (id: string) => void; refreshKey: number }) =>
    <button data-refresh={refreshKey} onClick={() => onSelectServer('dsh:office')}>DS Office</button>,
}))

vi.mock('../../../omp/transport', () => ({ fetchHostShare: vi.fn(), redeemPairCode: redeemMock, redeemDisplayCode: redeemCodeMock }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      typeof values?.latency === 'number' ? `${key} ${values.latency}` : key,
  }),
}))

vi.mock('../../../hooks', () => ({
  useServerStore: useServerStoreMock,
  useRouter: () => ({ navigateHome: navigateHomeMock, sessionId: 'session-1' }),
}))

vi.mock('../../../utils/sessionLifecycle', () => ({
  clearSessionRuntimeState: clearSessionMock,
}))

const localServer = { id: 'local', name: 'Local', url: 'http://127.0.0.1:4096', isDefault: true }
const remoteServer = { id: 'remote', name: 'Remote', url: 'http://remote.test' }
const row = (name: string) => screen.getByText(name).closest('.cb-srv') as HTMLElement
const urlField = () => screen.getByLabelText('servers.urlOrLink')

describe('ServersSettings', () => {
  const checkHealthMock = vi.fn()
  const setActiveServerMock = vi.fn()

  beforeEach(() => {
    nativeMock.mockReturnValue(false)
    mobileMock.mockReturnValue(false)
    disconnectMock.mockReset()
    scanMock.mockReset()
    parseScanMock.mockReset().mockReturnValue({ ticket: 'ticket' })
    checkHealthMock.mockReset()
    setActiveServerMock.mockReset()
    navigateHomeMock.mockReset()
    clearSessionMock.mockReset()
    redeemMock.mockReset().mockResolvedValue({ url: 'http://100.101.2.3:8787', token: 'server-token' })
    redeemCodeMock.mockReset().mockResolvedValue({ url: 'http://192.168.1.9:8787', token: 'code-token' })
    dshControllerStore.update({ pairRequest: null })
    useServerStoreMock.mockReturnValue({
      servers: [localServer, remoteServer],
      activeServer: localServer,
      addServer: vi.fn(() => ({ id: 'new-server' })),
      removeServer: vi.fn(),
      updateServer: vi.fn(),
      setActiveServer: setActiveServerMock,
      checkHealth: checkHealthMock,
      checkAllHealth: vi.fn(),
      getHealth: vi.fn(() => null),
    })
  })

  it.each([
    { workerReady: true, ompVersion: null, label: 'servers.runtime.missing' },
    { workerReady: false, ompVersion: null, label: 'servers.runtime.worker-unready' },
    { workerReady: null, ompVersion: null, label: 'servers.runtime.unknown' },
  ])('warns for local and remote runtime health: $label', ({ workerReady, ompVersion, label }) => {
    useServerStoreMock().getHealth.mockReturnValue({ status: 'online', latency: 12, workerReady, ompVersion })
    render(<ServersSettings />)
    for (const name of ['Local', 'Remote']) {
      const health = within(row(name)).getByRole('button', { name: `servers.backendReachable 12 · ${label}` })
      expect(health).toHaveAttribute('data-tone', 'warn')
      expect(health).toHaveAttribute('title', `servers.backendReachable 12 · ${label}`)
      expect(health.querySelector('.lucide-triangle-alert')).toBeInTheDocument()
    }
  })

  it('returns to green with the reported OMP version after runtime recovery', () => {
    useServerStoreMock().getHealth.mockReturnValue({ status: 'online', latency: 12, workerReady: true, ompVersion: null })
    const view = render(<ServersSettings />)
    expect(within(row('Remote')).getByRole('button', { name: /servers.runtime.missing/ })).toHaveAttribute('data-tone', 'warn')
    useServerStoreMock().getHealth.mockReturnValue({ status: 'online', latency: 12, workerReady: true, ompVersion: '18.12.6' })
    view.rerender(<ServersSettings />)
    expect(within(row('Remote')).getByRole('button', { name: 'servers.onlineLatency 12 · OMP v18.12.6' })).toHaveAttribute('data-tone', 'on')
  })

  it('uses shared desktop health for the matching endpoint and preserves authentication warnings', () => {
    const url = 'http://127.0.0.1:58111'
    useServerStoreMock.mockReturnValue({
      ...useServerStoreMock(),
      servers: [{ ...localServer, url }, remoteServer],
      getHealth: (id: string) => id === 'local'
        ? { status: 'online', latency: 12, workerReady: true, ompVersion: '18.12.6' }
        : { status: 'unauthorized' },
    })
    render(<ServersSettings />)
    act(() => receiveBackendRuntimeHealth(url, { workerReady: true, ompVersion: null }, 1))
    expect(within(row('Local')).getByRole('button', { name: /servers.runtime.missing/ })).toHaveAttribute('data-tone', 'warn')
    const unauthorized = within(row('Remote')).getByRole('button', { name: 'servers.invalidCredentials' })
    expect(unauthorized.querySelector('.lucide-key-round')).toBeInTheDocument()
    act(() => receiveBackendRuntimeHealth(url, { workerReady: true, ompVersion: '18.12.6' }, 2))
    expect(within(row('Local')).getByRole('button', { name: /OMP v18.12.6/ })).toHaveAttribute('data-tone', 'on')
  })

  it('switches DS through normal navigation while keeping saved server rows available', async () => {
    nativeMock.mockReturnValue(true)
    const view = render(<ServersSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'DS Office' }))
    expect(setActiveServerMock).toHaveBeenCalledWith('dsh:office')
    expect(clearSessionMock).toHaveBeenCalledWith('session-1')
    expect(navigateHomeMock).toHaveBeenCalledOnce()
    const tunnel = { id: 'dsh:office', name: 'Temporary tunnel', url: 'https://temporary.example', source: 'dsh' }
    useServerStoreMock.mockReturnValue({ ...useServerStoreMock(), servers: [localServer, remoteServer, tunnel], activeServer: tunnel })
    view.rerender(<ServersSettings />)
    expect(screen.queryByText('Temporary tunnel')).not.toBeInTheDocument()
    expect(screen.getByText('Local')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Remote'))
    expect(setActiveServerMock).toHaveBeenLastCalledWith('remote')
    expect(navigateHomeMock).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending DS selection when the current saved server is clicked', () => {
    render(<ServersSettings />)
    fireEvent.click(screen.getByText('Local'))
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(setActiveServerMock).not.toHaveBeenCalled()
  })

  it('outlines only the server in use and keeps the others one click away', () => {
    render(<ServersSettings />)
    expect(row('Local')).toHaveAttribute('data-current')
    expect(within(row('Local')).getByRole('button', { name: /Local/ })).toHaveAttribute('aria-current', 'true')
    expect(row('Remote')).not.toHaveAttribute('data-current')
  })

  it('refreshes saved servers and DS computers from the same header button', async () => {
    nativeMock.mockReturnValue(true)
    render(<ServersSettings />)
    const ds = await screen.findByRole('button', { name: 'DS Office' })
    expect(ds).toHaveAttribute('data-refresh', '0')
    fireEvent.click(screen.getByRole('button', { name: 'common:refresh' }))
    expect(useServerStoreMock().checkAllHealth).toHaveBeenCalledTimes(2)
    expect(ds).toHaveAttribute('data-refresh', '1')
  })

  it('opens the connection form when arriving from authentication', () => {
    render(<ServersSettings initialAddingServer />)
    expect(urlField()).toBeInTheDocument()
    expect(screen.getByLabelText('servers.secretOptional')).toBeEnabled()
  })

  it('redeems a full pairing link, saves the actual URL and switches through the existing session cleanup', async () => {
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(urlField(), { target: { value: 'http://100.101.2.3:8787/?pair=once.secret' } })
    // 链接里已经带了凭证，第二栏不用填。
    expect(screen.getByLabelText('servers.secretOptional')).toBeDisabled()
    expect(screen.getByText('servers.detectedPairLink')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'common:add' }).find(button => !button.hasAttribute('disabled'))!))
    expect(redeemMock).toHaveBeenCalledWith('once.secret', 'http://100.101.2.3:8787', expect.any(AbortSignal))
    expect(useServerStoreMock().addServer).toHaveBeenCalledWith({
      name: '100.101.2.3:8787', url: 'http://100.101.2.3:8787', token: 'server-token', source: 'pair',
    })
    expect(setActiveServerMock).toHaveBeenCalledWith('new-server')
    expect(checkHealthMock).toHaveBeenCalledWith('new-server')
    expect(clearSessionMock).toHaveBeenCalledWith('session-1')
    expect(navigateHomeMock).toHaveBeenCalledOnce()
  })

  it('redeems an 8-digit pairing code against the entered address', async () => {
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(urlField(), { target: { value: 'http://192.168.1.9:8787/' } })
    fireEvent.change(screen.getByLabelText('servers.secretOptional'), { target: { value: '1234 5678' } })
    expect(screen.getByText('servers.detectedCode')).toBeInTheDocument()
    await act(async () => fireEvent.submit(urlField().closest('form')!))
    expect(redeemCodeMock).toHaveBeenCalledWith('12345678', 'http://192.168.1.9:8787', expect.any(AbortSignal))
    expect(useServerStoreMock().addServer).toHaveBeenCalledWith({
      name: '192.168.1.9:8787', url: 'http://192.168.1.9:8787', token: 'code-token', source: 'pair',
    })
    expect(setActiveServerMock).toHaveBeenCalledWith('new-server')
  })

  it('keeps expired pairing links editable without creating an unauthenticated connection', async () => {
    redeemMock.mockRejectedValue(new Error('pairing code expired'))
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(urlField(), { target: { value: 'http://remote.test/?pair=expired.secret' } })
    await act(async () => fireEvent.submit(urlField().closest('form')!))
    expect(await screen.findByRole('alert')).toHaveTextContent('pairing code expired')
    expect(useServerStoreMock().addServer).not.toHaveBeenCalled()
    expect(urlField()).toBeEnabled()
  })

  it('prevents duplicate pairing submissions while redeeming a link', async () => {
    let complete!: (value: { url: string; token: string }) => void
    redeemMock.mockReturnValue(new Promise(resolve => { complete = resolve }))
    render(<ServersSettings initialAddingServer />)
    const input = urlField()
    fireEvent.change(input, { target: { value: 'http://remote.test/?pair=once.secret' } })
    const form = input.closest('form')!
    fireEvent.submit(form)
    expect(input).toBeDisabled()
    fireEvent.submit(form)
    expect(redeemMock).toHaveBeenCalledOnce()
    await act(async () => complete({ url: 'http://remote.test', token: 'server-token' }))
    expect(useServerStoreMock().addServer).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'Remote', url: 'http://remote.test', token: undefined, expectedUrl: 'http://remote.test' },
    { name: '', url: 'ompiui://connect?url=http%3A%2F%2Fremote.test&token=share-token', token: 'share-token', expectedUrl: 'http://remote.test' },
  ])('preserves adding ordinary URLs and share links: $url', async ({ name, url, token, expectedUrl }) => {
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(screen.getByLabelText('servers.nameOptional'), { target: { value: name } })
    fireEvent.change(urlField(), { target: { value: url } })
    await act(async () => fireEvent.submit(urlField().closest('form')!))
    expect(useServerStoreMock().addServer).toHaveBeenCalledWith({ name: name || 'remote.test', url: expectedUrl, token, source: 'manual' })
    expect(redeemMock).not.toHaveBeenCalled()
    expect(setActiveServerMock).not.toHaveBeenCalled()
  })

  it('treats anything that is not 8 digits as the backend key and uses the address as the name', async () => {
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(urlField(), { target: { value: 'http://192.168.1.9:8787' } })
    fireEvent.change(screen.getByLabelText('servers.secretOptional'), { target: { value: ' backend-key ' } })
    expect(screen.getByText('servers.detectedKey')).toBeInTheDocument()
    await act(async () => fireEvent.submit(urlField().closest('form')!))
    expect(useServerStoreMock().addServer).toHaveBeenCalledWith({
      name: '192.168.1.9:8787', url: 'http://192.168.1.9:8787', token: 'backend-key', source: 'manual',
    })
    expect(redeemCodeMock).not.toHaveBeenCalled()
    expect(setActiveServerMock).not.toHaveBeenCalled()
  })

  it('switches servers even when health verification fails', async () => {
    checkHealthMock.mockResolvedValueOnce({ status: 'error', error: 'Not an OMPiUI server' })

    render(<ServersSettings />)

    fireEvent.click(screen.getByRole('button', { name: /Remote/ }))

    await waitFor(() => {
      expect(checkHealthMock).toHaveBeenCalledWith('remote')
    })
    expect(setActiveServerMock).toHaveBeenCalledWith('remote')
    expect(navigateHomeMock).toHaveBeenCalled()
    expect(clearSessionMock).toHaveBeenCalledWith('session-1')
  })

  it('lets the built-in local server be edited but not removed', () => {
    const updateServerMock = vi.fn()
    useServerStoreMock.mockReturnValue({ ...useServerStoreMock(), updateServer: updateServerMock })

    render(<ServersSettings />)

    expect(within(row('Local')).queryByLabelText('common:remove')).toBeNull()
    expect(within(row('Remote')).getByLabelText('common:remove')).toBeTruthy()

    fireEvent.click(within(row('Local')).getByLabelText('servers.editServer'))
    fireEvent.change(screen.getByDisplayValue('http://127.0.0.1:4096'), {
      target: { value: 'http://192.168.1.5:8787' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'common:save' }))

    expect(updateServerMock).toHaveBeenCalledWith('local', {
      name: 'Local',
      url: 'http://192.168.1.5:8787',
      token: undefined,
    })
  })

  it('asks in the row before removing a server', () => {
    render(<ServersSettings />)
    fireEvent.click(within(row('Remote')).getByLabelText('common:remove'))
    expect(useServerStoreMock().removeServer).not.toHaveBeenCalled()
    expect(within(row('Remote')).getByText('servers.removeConfirm')).toBeInTheDocument()
    fireEvent.click(within(row('Remote')).getByText('common:remove'))
    expect(useServerStoreMock().removeServer).toHaveBeenCalledWith('remote')
  })

  describe('the single scan entry in the phone app', () => {
    beforeEach(() => {
      nativeMock.mockReturnValue(true)
      mobileMock.mockReturnValue(true)
    })

    it('is absent wherever there is no camera bridge', () => {
      mobileMock.mockReturnValue(false)
      render(<ServersSettings />)
      expect(screen.queryByRole('button', { name: 'servers.scan' })).not.toBeInTheDocument()
    })

    it('connects straight away after scanning a pairing link, with no code to type', async () => {
      scanMock.mockResolvedValue('http://100.101.2.3:8787/?pair=once.secret')
      render(<ServersSettings />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'servers.scan' })))
      expect(redeemMock).toHaveBeenCalledWith('once.secret', 'http://100.101.2.3:8787', expect.any(AbortSignal))
      expect(useServerStoreMock().addServer).toHaveBeenCalledWith({
        name: '100.101.2.3:8787', url: 'http://100.101.2.3:8787', token: 'server-token', source: 'pair',
      })
      expect(setActiveServerMock).toHaveBeenCalledWith('new-server')
    })

    it('hands a DS remote pairing code to the controller page', async () => {
      const openController = vi.fn()
      scanMock.mockResolvedValue('https://dsh.r2049.cn/pair#v1.ticket')
      render(<ServersSettings onOpenController={openController} />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'servers.scan' })))
      expect(dshControllerStore.get().pairRequest).toBe('https://dsh.r2049.cn/pair#v1.ticket')
      expect(openController).toHaveBeenCalledOnce()
      expect(useServerStoreMock().addServer).not.toHaveBeenCalled()
    })

    it('rejects a code that is neither a connection link nor a DS remote pairing code', async () => {
      const openController = vi.fn()
      parseScanMock.mockImplementation(() => { throw new Error('not a pairing scan') })
      scanMock.mockResolvedValue('https://example.com/menu')
      render(<ServersSettings onOpenController={openController} />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'servers.scan' })))
      expect(screen.getByRole('alert')).toHaveTextContent('authentication.invalidLink')
      expect(dshControllerStore.get().pairRequest).toBeNull()
      expect(openController).not.toHaveBeenCalled()
    })

    it('says why the camera could not be used', async () => {
      scanMock.mockRejectedValue(new Error('scanPermissionDenied'))
      render(<ServersSettings />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'servers.scan' })))
      expect(screen.getByRole('alert')).toHaveTextContent('authentication.scanPermissionDenied')
    })

    it('does nothing when the scanner is dismissed', async () => {
      scanMock.mockResolvedValue(null)
      render(<ServersSettings />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'servers.scan' })))
      expect(useServerStoreMock().addServer).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
