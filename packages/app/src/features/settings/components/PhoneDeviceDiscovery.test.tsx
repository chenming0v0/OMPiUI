import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneDeviceDiscovery } from './PhoneDeviceDiscovery'

const mocks = vi.hoisted(() => ({ discover: vi.fn(), supported: true }))
vi.mock('../../../utils/deviceDiscovery', async original => ({
  ...await original<typeof import('../../../utils/deviceDiscovery')>(),
  supportsDeviceDiscovery: () => mocks.supported, discoverDevices: mocks.discover,
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const device = { marker: 'ompiui', discoveryVersion: 1, displayName: 'My computer', instanceId: 'a'.repeat(32), port: 9191,
  pairing: true, address: '192.168.1.10', network: 'lan' } as const
beforeEach(() => { mocks.supported = true; mocks.discover.mockReset().mockResolvedValue([]) })
afterEach(cleanup)

describe('PhoneDeviceDiscovery', () => {
  it('lists devices and selects an address without granting access', async () => {
    mocks.discover.mockImplementation(network => Promise.resolve(network === 'lan' ? [device] : []))
    const select = vi.fn()
    const view = render(<PhoneDeviceDiscovery address="" disabled={false} onSelect={select} />)
    const button = await screen.findByRole('button', { name: /My computer/ })
    expect(button).toHaveTextContent('http://192.168.1.10:9191')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(select).toHaveBeenCalledWith(device)
    view.rerender(<PhoneDeviceDiscovery address="http://192.168.1.10:9191" disabled={false} onSelect={select} />)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(mocks.discover).toHaveBeenCalledTimes(2)
  })

  it('maps native prefixed permission errors to translated hints', async () => {
    mocks.discover.mockRejectedValue(new Error('discoveryPermissionDenied: Android NSD denied'))
    render(<PhoneDeviceDiscovery address="" disabled={false} onSelect={vi.fn()} />)
    expect(await screen.findAllByText('authentication.discoveryPermissionDenied')).toHaveLength(2)
  })

  it('keeps LAN results when Tailnet login is unavailable', async () => {
    mocks.discover.mockImplementation(network => network === 'lan' ? Promise.resolve([device]) : Promise.reject(new Error('discoveryTailscaleLogin')))
    render(<PhoneDeviceDiscovery address="" disabled={false} onSelect={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /My computer/ })).toBeEnabled()
    expect(await screen.findByText('authentication.discoveryTailscaleLogin')).toBeInTheDocument()
  })

  it('aborts previous scans on refresh and ignores late responses', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (devices: typeof device[]) => void }> = []
    mocks.discover.mockImplementation((_network, signal) => new Promise(resolve => requests.push({ signal, resolve })))
    render(<PhoneDeviceDiscovery address="" disabled={false} onSelect={vi.fn()} />)
    await waitFor(() => expect(requests).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'authentication.discoveryRefresh' }))
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests).toHaveLength(4)
    await act(async () => requests[0].resolve([device]))
    expect(screen.queryByRole('button', { name: /My computer/ })).not.toBeInTheDocument()
    await act(async () => requests[2].resolve([device]))
    expect(screen.getByRole('button', { name: /My computer/ })).toBeInTheDocument()
  })

  it('cancels discovery when pairing starts and on unmount', async () => {
    const signals: AbortSignal[] = []
    mocks.discover.mockImplementation((_network, signal) => { signals.push(signal); return new Promise(() => {}) })
    const view = render(<PhoneDeviceDiscovery address="" disabled={false} onSelect={vi.fn()} />)
    await waitFor(() => expect(signals).toHaveLength(2))
    view.rerender(<PhoneDeviceDiscovery address="" disabled onSelect={vi.fn()} />)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(screen.getByRole('button', { name: 'authentication.discoveryRefresh' })).toBeDisabled()
    view.unmount()
  })

  it('shows no fake discovery on unsupported browsers', () => {
    mocks.supported = false
    const view = render(<PhoneDeviceDiscovery address="" disabled={false} onSelect={vi.fn()} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(mocks.discover).not.toHaveBeenCalled()
  })
})
