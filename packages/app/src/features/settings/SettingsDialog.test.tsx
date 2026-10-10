import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SettingsDialog } from './SettingsDialog'

const notificationTargets = vi.hoisted(() => ({ mode: 'both' as 'both' | 'system' | 'sound' }))
const tauriState = vi.hoisted(() => ({ mobile: false, smallScreen: false }))

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children, ariaLabel }: { isOpen: boolean; children: React.ReactNode; ariaLabel: string }) =>
    isOpen ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null,
}))
vi.mock('../../hooks', () => ({ useIsMobile: () => tauriState.smallScreen }))
vi.mock('../../utils/tauri', () => ({ isTauri: () => true, isTauriMobile: () => tauriState.mobile }))
vi.mock('./KeybindingsSection', () => ({ KeybindingsSection: () => <div>Shortcuts content</div> }))
vi.mock('./components/AgentSettings', () => ({ AgentSettings: () => <div>Agent content</div> }))
vi.mock('./components/AppearanceSettings', () => ({
  AppearanceSettings: () => (
    <div data-setting-label="Color Mode">
      <button type="button" className="hidden">Hidden color control</button>
      <button type="button">Color control</button>
    </div>
  ),
}))
vi.mock('./components/AboutSettings', () => ({ AboutSettings: () => <div>About content</div> }))
vi.mock('./components/ChatSettings', () => ({ ChatSettings: () => <div>Chat content</div> }))
vi.mock('./components/ModelsSettings', () => ({ ModelsSettings: () => <div>Models content</div> }))
vi.mock('./components/NotificationSettings', () => ({
  NotificationSettings: () => (
    <div>
      <div data-setting-label="System Notifications"><button type="button">System settings</button></div>
      {notificationTargets.mode !== 'sound' && (
        <div data-setting-label="Session Completed" data-setting-context="Notification Types"><button type="button">System event control</button></div>
      )}
      {notificationTargets.mode !== 'system' && (
        <div data-setting-label="Session Completed" data-setting-context="Event Sounds"><button type="button">Sound event control</button></div>
      )}
      <div data-setting-label="Sound Settings"><button type="button">Sound settings</button></div>
    </div>
  ),
}))
vi.mock('./components/ServiceSettings', () => ({ ServiceSettings: () => <div>Service content</div> }))
vi.mock('./components/ServersSettings', () => ({
  ServersSettings: ({ initialAddingServer }: { initialAddingServer?: boolean }) => (
    <div>Servers content{initialAddingServer && <input aria-label="New connection" />}</div>
  ),
}))
vi.mock('./components/AuthenticationSettings', () => ({
  AuthenticationSettings: ({ onAuthenticated }: { onAuthenticated?: () => void }) => (
    <div data-setting-label="Authentication"><button type="button" onClick={onAuthenticated}>Complete authentication</button></div>
  ),
}))
vi.mock('./components/TrafficAuditSettings', () => ({
  TrafficAuditSettings: () => <div data-setting-label="Record traffic"><button type="button">Traffic control</button></div>,
}))
vi.mock('./components/WorkspaceSettings', () => ({ WorkspaceSettings: () => <div>Workspace content</div> }))
vi.mock('./components/ConfigSettings', () => ({ ConfigSettings: () => <div>Config content</div> }))

describe('SettingsDialog search', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    notificationTargets.mode = 'both'
    tauriState.mobile = false
    tauriState.smallScreen = false
    vi.stubGlobal('__APP_VERSION__', 'test')
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 0))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => clearTimeout(id))
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores categories and jumps to a highlighted search result', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByText('Core')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Color control').parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: 'Color control' })).toHaveFocus()
  })

  it('places the service tab under Advanced', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const advancedGroup = screen.getByText('Advanced').parentElement
    expect(advancedGroup).not.toBeNull()
    expect(within(advancedGroup!).getByRole('tab', { name: 'Service' })).toBeInTheDocument()
    expect(within(screen.getByText('Core').parentElement!).queryByRole('tab', { name: 'Service' })).not.toBeInTheDocument()
  })

  it('places authentication first under Advanced on desktop', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    const advancedGroup = screen.getByText('Advanced').parentElement!
    expect(within(advancedGroup).getAllByRole('tab')[0]).toHaveTextContent('Authentication')
    expect(within(screen.getByText('Core').parentElement!).queryByRole('tab', { name: 'Authentication' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Authentication' }))
    expect(screen.getByRole('button', { name: 'Complete authentication' })).toBeInTheDocument()
    expect(screen.queryByText('Service content')).not.toBeInTheDocument()
  })

  it('puts mobile authentication immediately right of Servers and opens a new connection after success', async () => {
    tauriState.mobile = true
    tauriState.smallScreen = true
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveTextContent('Servers')
    expect(tabs[1]).toHaveTextContent('Authentication')
    fireEvent.click(tabs[1])
    fireEvent.click(screen.getByRole('button', { name: 'Complete authentication' }))
    expect(screen.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('New connection')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Authentication' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Servers' }))
    expect(screen.queryByLabelText('New connection')).not.toBeInTheDocument()
  })

  it('finds Tailscale in the independent authentication page', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Tailscale' } })
    fireEvent.click(screen.getAllByRole('option')[0])
    await act(async () => vi.advanceTimersByTime(1))
    expect(screen.getByRole('tab', { name: 'Authentication' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Complete authentication' })).toHaveFocus()
  })

  it('hides desktop service controls in the Android shell', async () => {
    tauriState.mobile = true
    render(<SettingsDialog isOpen onClose={vi.fn()} initialTab="service" />)
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.queryByRole('tab', { name: 'Service' })).not.toBeInTheDocument()
    expect(screen.queryByText('Service content')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps traffic auditing available on Android and reachable from settings search', async () => {
    tauriState.mobile = true
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    expect(screen.getByRole('tab', { name: 'Traffic Audit' })).toBeInTheDocument()
    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Record traffic' } })
    fireEvent.click(screen.getByRole('option', { name: /Record traffic/ }))
    await act(async () => vi.advanceTimersByTime(1))
    expect(screen.getByRole('tab', { name: 'Traffic Audit' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Traffic control' })).toHaveFocus()
  })

  it('distinguishes duplicate setting labels by their subgroup', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Session Completed' } })
    fireEvent.click(screen.getByRole('option', { name: /Session Completed.*Event Sounds/ }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByText('Sound event control').parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: 'Sound event control' })).toHaveFocus()
  })

  it.each([
    { mode: 'sound' as const, context: 'Notification Types', fallback: 'System settings' },
    { mode: 'system' as const, context: 'Event Sounds', fallback: 'Sound settings' },
  ])('uses the $context fallback when its conditional target is absent', async ({ mode, context, fallback }) => {
    notificationTargets.mode = mode
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Session Completed' } })
    fireEvent.click(screen.getByRole('option', { name: new RegExp(`Session Completed.*${context}`) }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByText(fallback).parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: fallback })).toHaveFocus()
  })

  it('cancels a pending highlight when the dialog closes', async () => {
    const { rerender } = render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
    scrollIntoView.mockClear()

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    rerender(<SettingsDialog isOpen={false} onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(10))

    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
