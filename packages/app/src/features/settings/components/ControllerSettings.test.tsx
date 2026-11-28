import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { dshControllerStore } from '../../../store/dshControllerStore'
import { ControllerSettings } from './ControllerSettings'
import type { AndroidTailscaleState } from './AndroidTailscaleSettings'
import type { NewServer } from './AddServerForm'

const platform = vi.hoisted(() => ({ android: false, tauri: true, mobile: false }))
const connect = vi.hoisted(() => vi.fn())
vi.mock('../../../utils/androidTailscale', () => ({
  isAndroidTailscalePlatform: () => platform.android,
}))
vi.mock('../../../utils/tauri', () => ({
  isTauri: () => platform.tauri,
  isTauriMobile: () => platform.mobile,
}))
vi.mock('./AndroidTailscaleSettings', () => ({
  AndroidTailscaleSettings: ({ onState }: { onState?: (state: AndroidTailscaleState) => void }) => (
    <button type="button" onClick={() => onState?.({ backendState: 'Running', phase: 'idle' })}>Phone network</button>
  ),
}))
vi.mock('./PhonePairingForm', () => ({
  PhonePairingForm: ({ onPaired, onOpenTailscale }: { onPaired?: () => void; onOpenTailscale?: () => void }) => (
    <div>
      <button type="button" onClick={onPaired}>Pairing form</button>
      {onOpenTailscale && <button type="button" onClick={onOpenTailscale}>Use tailnet instead</button>}
    </div>
  ),
}))
vi.mock('./TailnetPairing', () => ({ TailnetPairing: () => <div>Tailnet computers</div> }))
vi.mock('./DshRemoteSettings', () => ({
  DshRemoteConnectSettings: () => <div>Remote computers</div>,
}))
vi.mock('./AddServerForm', () => ({
  AddServerForm: ({ onAdd, submitLabel }: { onAdd: (server: NewServer, paired: boolean) => void; submitLabel?: string }) => (
    <button type="button" onClick={() => onAdd({ name: 'Backend', url: 'http://backend.test', token: 'key', source: 'manual' }, false)}>
      {submitLabel}
    </button>
  ),
}))
vi.mock('./useServerConnect', () => ({ useServerConnect: () => connect }))

const channel = (name: string) => screen.getByRole('button', { name })

beforeEach(async () => {
  await i18n.changeLanguage('en')
  platform.android = false
  platform.tauri = true
  platform.mobile = false
  connect.mockReset()
  dshControllerStore.update({ session: null, hosts: [], connection: null, authError: null, signingIn: false })
})

describe('ControllerSettings', () => {
  it('offers pairing, DS remote and address entry as channels on desktop', async () => {
    render(<ControllerSettings />)
    expect(channel('Pair')).toHaveAttribute('aria-pressed', 'true')
    expect(channel('Address and key')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Tailscale' })).not.toBeInTheDocument()
    expect(screen.getByText('Pairing form')).toBeInTheDocument()
    // DS 远程的面板要等用户点到它才挂载，不在打开页面时就去请求托管服务。
    expect(screen.queryByText('Remote computers')).not.toBeInTheDocument()
    expect(channel('DS remote')).toHaveAttribute('aria-description', 'Not signed in')
    fireEvent.click(channel('DS remote'))
    expect(await screen.findByText('Remote computers')).toBeInTheDocument()
    expect(screen.queryByText('Pairing form')).not.toBeInTheDocument()
    // 切走之后面板保留，登录流程不会因为看一眼别的通道就丢。
    fireEvent.click(channel('Pair'))
    expect(screen.getByText('Remote computers')).toBeInTheDocument()
    expect(screen.getByText('Remote computers').closest('[hidden]')).not.toBeNull()
  })

  it('keeps pairing and address entry in the browser and says where the rest lives', () => {
    platform.tauri = false
    render(<ControllerSettings />)
    expect(channel('Pair')).toBeInTheDocument()
    expect(channel('Address and key')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'DS remote' })).not.toBeInTheDocument()
    expect(screen.getByText(/mobile app/i)).toBeInTheDocument()
  })

  it('links to the Servers page instead of listing connected computers', () => {
    const openServers = vi.fn()
    render(<ControllerSettings onOpenServers={openServers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Servers page' }))
    expect(openServers).toHaveBeenCalledOnce()
  })

  it('adds a backend by address and key and switches to it', () => {
    render(<ControllerSettings />)
    fireEvent.click(channel('Address and key'))
    fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }))
    expect(connect).toHaveBeenCalledWith({ name: 'Backend', url: 'http://backend.test', token: 'key', source: 'manual' }, 'manual')
    expect(screen.getByRole('status')).toHaveTextContent('Added and connected to Backend')
  })

  it('shows the phone tailnet channel on Android and pairs tailnet computers once connected', () => {
    platform.android = true
    platform.mobile = true
    const completed = vi.fn()
    render(<ControllerSettings onPaired={completed} />)
    expect(channel('DS remote')).toHaveAttribute('aria-description', 'Not signed in')
    expect(channel('Tailscale')).toHaveAttribute('aria-description', 'Signed out')
    fireEvent.click(screen.getByRole('button', { name: 'Pairing form' }))
    expect(completed).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Use tailnet instead' }))
    expect(channel('Tailscale')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Tailnet computers')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Phone network' }))
    expect(channel('Tailscale')).toHaveAttribute('aria-description', 'Connected')
    expect(screen.getByText('Tailnet computers')).toBeInTheDocument()
  })

  it('reflects a DS remote sign-in on the channel strip', () => {
    dshControllerStore.update({
      session: {} as never,
      hosts: [{ id: 'a', name: 'Office', online: true }, { id: 'b', name: 'Laptop', online: false }],
    })
    render(<ControllerSettings />)
    expect(channel('DS remote')).toHaveAttribute('aria-description', '1 online')
    expect(channel('DS remote').querySelector('.cb-lamp')).toHaveAttribute('data-tone', 'on')
  })

  it.each([
    ['en', 'DS remote', '0 online · 1 unknown'],
    ['zh-CN', 'DS 远程', '0 台在线 · 1 台未知'],
  ])('shows an unknown-only DS list without a green lamp in %s', async (language, label, description) => {
    await i18n.changeLanguage(language)
    platform.mobile = true
    dshControllerStore.update({ session: {} as never, hosts: [{ id: 'a', name: 'Office' }] })
    render(<ControllerSettings />)
    expect(channel(label)).toHaveAttribute('aria-description', description)
    expect(channel(label).querySelector('.cb-lamp')).toHaveAttribute('data-tone', 'warn')
  })

  it('includes unknown computers alongside confirmed online computers', () => {
    dshControllerStore.update({
      session: {} as never,
      hosts: [{ id: 'a', name: 'Office', online: true }, { id: 'b', name: 'Laptop' }, { id: 'c', name: 'Home', online: false }],
    })
    render(<ControllerSettings />)
    expect(channel('DS remote')).toHaveAttribute('aria-description', '1 online · 1 unknown')
    expect(channel('DS remote').querySelector('.cb-lamp')).toHaveAttribute('data-tone', 'warn')
  })

  it('does not light the DS channel green when all computers are offline', () => {
    dshControllerStore.update({ session: {} as never, hosts: [{ id: 'a', name: 'Office', online: false }] })
    render(<ControllerSettings />)
    expect(channel('DS remote')).toHaveAttribute('aria-description', '0 online')
    expect(channel('DS remote').querySelector('.cb-lamp')).toHaveAttribute('data-tone', 'off')
  })

  it('offers DS remote in the mobile app without the Android tailnet channel', () => {
    platform.mobile = true
    platform.android = false
    render(<ControllerSettings />)
    expect(screen.queryByRole('button', { name: 'Tailscale' })).not.toBeInTheDocument()
    expect(channel('DS remote')).toHaveAttribute('aria-description', 'Not signed in')
  })
})
