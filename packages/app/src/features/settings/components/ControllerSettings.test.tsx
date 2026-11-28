import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { ControllerSettings } from './ControllerSettings'

const platform = vi.hoisted(() => ({ android: false, tauri: true, mobile: false, ompMissing: false, localActive: true }))
const discovery = vi.hoisted(() => ({ devices: [{}, {}] as unknown[], loading: false, error: '', refresh: vi.fn() }))
const backend = vi.hoisted(() => ({
  running: false, restoring: false, busy: false, disconnect: vi.fn(),
  tile: { tone: 'off', state: 'Signed out' }, tailscale: { url: 'http://100.101.2.3:8787', ips: ['100.101.2.3'] },
}))
vi.mock('../../../utils/androidTailscale', () => ({
  isAndroidTailscalePlatform: () => platform.android,
}))
vi.mock('../../../utils/deviceDiscovery', () => ({ supportsDeviceDiscovery: () => platform.android }))
vi.mock('../../../utils/tauri', () => ({
  isTauri: () => platform.tauri,
  isTauriMobile: () => platform.mobile,
}))
vi.mock('../../../store/desktopDiagnosticsStore', () => ({ useLocalOmpMissing: () => platform.ompMissing }))
vi.mock('../../../hooks', () => ({
  useServerStore: () => ({ activeServer: { id: 'active', isDefault: platform.localActive } }),
}))
vi.mock('./useDeviceDiscovery', () => ({ useDeviceDiscovery: () => discovery }))
vi.mock('./DiscoveredComputers', () => ({
  DiscoveredRows: ({ network, onPaired }: { network: string; onPaired?: () => void }) => (
    <button type="button" onClick={onPaired}>Computers on {network}</button>
  ),
}))
vi.mock('./AndroidTailscaleSettings', () => ({ AndroidTailscaleSettings: () => <div>Phone tailnet section</div> }))
vi.mock('./DshRemoteSettings', () => ({ DshRemoteConnectSettings: () => <div>DS remote section</div> }))
vi.mock('./useBackendTailscale', () => ({
  useBackendTailscale: () => ({ ...backend, controls: () => <button type="button">Log in to Tailscale</button> }),
}))

const group = (name: RegExp) => screen.getByRole('button', { name })

beforeEach(async () => {
  await i18n.changeLanguage('en')
  Object.assign(platform, { android: false, tauri: true, mobile: false, ompMissing: false, localActive: true })
  Object.assign(discovery, { devices: [{}, {}], loading: false, error: '' })
  discovery.refresh.mockReset()
  Object.assign(backend, { running: false, restoring: false, busy: false, tile: { tone: 'off', state: 'Signed out' } })
  backend.disconnect.mockReset()
})

describe('ControllerSettings', () => {
  it('lists only DS remote on a desktop that has a runtime, with no pairing form of its own', async () => {
    render(<ControllerSettings />)
    expect(await screen.findByText('DS remote section')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /LAN/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tailscale/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Phone tailnet section')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('groups LAN, tailnet and DS remote in the Android app', async () => {
    platform.android = true
    platform.mobile = true
    render(<ControllerSettings />)
    expect(group(/LAN/)).toHaveTextContent('2 found')
    expect(screen.getByText('Phone tailnet section')).toBeInTheDocument()
    expect(await screen.findByText('DS remote section')).toBeInTheDocument()
  })

  it('keeps the LAN group folded until asked, then lists the computers and refreshes on demand', () => {
    platform.android = true
    platform.mobile = true
    const paired = vi.fn()
    render(<ControllerSettings onPaired={paired} />)
    const lan = group(/LAN/)
    expect(lan).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Computers on lan')).not.toBeVisible()
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
    fireEvent.click(lan)
    expect(lan).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Computers on lan')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(discovery.refresh).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('Computers on lan'))
    expect(paired).toHaveBeenCalledOnce()
  })

  it('shows the scan as in progress instead of a count', () => {
    platform.android = true
    platform.mobile = true
    discovery.loading = true
    render(<ControllerSettings />)
    expect(group(/LAN/)).toHaveTextContent('Loading')
    expect(group(/LAN/)).not.toHaveTextContent('found')
  })

  it('offers DS remote in the iOS app without device discovery or the Android tailnet', async () => {
    platform.mobile = true
    render(<ControllerSettings />)
    expect(await screen.findByText('DS remote section')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /LAN/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Phone tailnet section')).not.toBeInTheDocument()
  })

  describe('desktop without an OMP runtime', () => {
    beforeEach(() => { platform.ompMissing = true })

    it('moves the backend Tailscale sign-in here, since there is no Host page', () => {
      render(<ControllerSettings />)
      const tailnet = group(/Tailscale/)
      expect(tailnet).toHaveTextContent('Signed out')
      fireEvent.click(tailnet)
      expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    })

    it('shows the tailnet address and a sign-out once connected', () => {
      Object.assign(backend, { running: true, tile: { tone: 'on', state: '100.101.2.3' } })
      render(<ControllerSettings />)
      const tailnet = group(/Tailscale/)
      expect(tailnet).toHaveTextContent('Connected')
      fireEvent.click(tailnet)
      expect(screen.getByText('http://100.101.2.3:8787')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      expect(backend.disconnect).toHaveBeenCalledOnce()
    })

    it('says a previous sign-in is being restored and lets it be cancelled', () => {
      Object.assign(backend, { restoring: true, tile: { tone: 'busy', state: 'Restoring' } })
      render(<ControllerSettings />)
      const tailnet = group(/Tailscale/)
      expect(tailnet).toHaveTextContent('Restoring')
      fireEvent.click(tailnet)
      expect(screen.queryByRole('button', { name: 'Log in to Tailscale' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(backend.disconnect).toHaveBeenCalledOnce()
    })

    it('stays hidden while a remote server is active, because it would sign that server in instead', () => {
      platform.localActive = false
      render(<ControllerSettings />)
      expect(screen.queryByRole('button', { name: /Tailscale/ })).not.toBeInTheDocument()
    })
  })
})
