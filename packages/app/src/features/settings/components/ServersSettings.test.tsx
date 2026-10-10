import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServersSettings } from './ServersSettings'

const { useServerStoreMock, navigateHomeMock, clearSessionMock, redeemMock } = vi.hoisted(() => ({
  useServerStoreMock: vi.fn(),
  navigateHomeMock: vi.fn(),
  clearSessionMock: vi.fn(),
  redeemMock: vi.fn(),
}))

vi.mock('../../../omp/transport', () => ({ fetchHostShare: vi.fn(), redeemPairCode: redeemMock }))

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

describe('ServersSettings', () => {
  const checkHealthMock = vi.fn()
  const setActiveServerMock = vi.fn()

  beforeEach(() => {
    checkHealthMock.mockReset()
    setActiveServerMock.mockReset()
    navigateHomeMock.mockReset()
    clearSessionMock.mockReset()
    redeemMock.mockReset().mockResolvedValue({ url: 'http://100.101.2.3:8787', token: 'server-token' })
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

  it('opens only the connection form when arriving from authentication', () => {
    render(<ServersSettings initialAddingServer />)
    expect(screen.getByLabelText('servers.url')).toBeInTheDocument()
    expect(screen.queryByText('service.remoteTailscalePhoneTitle')).not.toBeInTheDocument()
  })

  it('redeems a full pairing link, saves the actual URL and switches through the existing session cleanup', async () => {
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(screen.getByLabelText('servers.url'), {
      target: { value: 'http://100.101.2.3:8787/?pair=once.secret' },
    })
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'common:add' }).find(button => !button.hasAttribute('disabled'))!))
    expect(redeemMock).toHaveBeenCalledWith('once.secret', 'http://100.101.2.3:8787', expect.any(AbortSignal))
    expect(useServerStoreMock().addServer).toHaveBeenCalledWith({
      name: '100.101.2.3:8787', url: 'http://100.101.2.3:8787', token: 'server-token',
    })
    expect(setActiveServerMock).toHaveBeenCalledWith('new-server')
    expect(checkHealthMock).toHaveBeenCalledWith('new-server')
    expect(clearSessionMock).toHaveBeenCalledWith('session-1')
    expect(navigateHomeMock).toHaveBeenCalledOnce()
  })

  it('keeps expired pairing links editable without creating an unauthenticated connection', async () => {
    redeemMock.mockRejectedValue(new Error('pairing code expired'))
    render(<ServersSettings initialAddingServer />)
    fireEvent.change(screen.getByLabelText('servers.url'), { target: { value: 'http://remote.test/?pair=expired.secret' } })
    await act(async () => fireEvent.submit(screen.getByLabelText('servers.url').closest('form')!))
    expect(await screen.findByRole('alert')).toHaveTextContent('pairing code expired')
    expect(useServerStoreMock().addServer).not.toHaveBeenCalled()
    expect(screen.getByLabelText('servers.url')).toBeEnabled()
  })

  it('prevents duplicate pairing submissions while redeeming a link', async () => {
    let complete!: (value: { url: string; token: string }) => void
    redeemMock.mockReturnValue(new Promise(resolve => { complete = resolve }))
    render(<ServersSettings initialAddingServer />)
    const input = screen.getByLabelText('servers.url')
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
    fireEvent.change(screen.getByLabelText('servers.name'), { target: { value: name } })
    fireEvent.change(screen.getByLabelText('servers.url'), { target: { value: url } })
    await act(async () => fireEvent.submit(screen.getByLabelText('servers.url').closest('form')!))
    expect(useServerStoreMock().addServer).toHaveBeenCalledWith({ name: name || 'remote.test', url: expectedUrl, token })
    expect(redeemMock).not.toHaveBeenCalled()
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
    useServerStoreMock.mockReturnValue({
      servers: [localServer, remoteServer],
      activeServer: localServer,
      addServer: vi.fn(),
      removeServer: vi.fn(),
      updateServer: updateServerMock,
      setActiveServer: setActiveServerMock,
      checkHealth: checkHealthMock,
      checkAllHealth: vi.fn(),
      getHealth: vi.fn(() => null),
    })

    render(<ServersSettings />)

    const localRow = screen.getByText('Local').closest('.group') as HTMLElement
    const remoteRow = screen.getByText('Remote').closest('.group') as HTMLElement
    expect(within(localRow).queryByLabelText('common:remove')).toBeNull()
    expect(within(remoteRow).getByLabelText('common:remove')).toBeTruthy()

    fireEvent.click(within(localRow).getByLabelText('servers.editServer'))
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
})
