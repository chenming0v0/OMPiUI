import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { serviceStore } from '../../../store/serviceStore'
import { RelaySettings } from './RelaySettings'

const platform = vi.hoisted(() => ({ desktop: true, mobile: false }))
const restart = vi.hoisted(() => vi.fn())
vi.mock('../../../utils/tauri', () => ({
  isTauri: () => platform.desktop,
  isTauriMobile: () => platform.mobile,
}))
vi.mock('../../../services/desktopService', () => ({ restartDesktopService: restart }))

beforeEach(async () => {
  platform.desktop = true
  platform.mobile = false
  restart.mockReset().mockResolvedValue({})
  await i18n.changeLanguage('en')
  serviceStore.setRunning(true)
  serviceStore.setStartedByUs(true)
  serviceStore.setEnvVars([
    { key: 'OMPIUI_PORT', value: '9191' },
    { key: 'OMPIUI_TUNNEL_URL', value: 'wss://saved-relay.test' },
    { key: 'OMPIUI_TUNNEL_KEY', value: 'saved-key' },
    { key: 'OMPIUI_TUNNEL_ID', value: 'saved-name' },
  ])
})
afterEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks() })

const save = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save and connect' })))

describe('RelaySettings', () => {
  it('displays existing relay credentials without changing storage on mount', () => {
    const saved = localStorage.getItem('ompiui-service-env-vars')
    const write = vi.spyOn(serviceStore, 'setEnvVars')
    render(<RelaySettings />)
    expect(screen.getByLabelText('Relay URL')).toHaveValue('wss://saved-relay.test')
    expect(screen.getByLabelText('Access key')).toHaveValue('saved-key')
    expect(screen.getByLabelText('Access key')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Tunnel ID (optional)')).toHaveValue('saved-name')
    expect(write).not.toHaveBeenCalled()
    expect(localStorage.getItem('ompiui-service-env-vars')).toBe(saved)
  })

  it('writes nothing while typing, then saves the three fields beside unrelated variables and restarts the service', async () => {
    render(<RelaySettings />)
    fireEvent.change(screen.getByLabelText('Relay URL'), { target: { value: ' wss://new-relay.test ' } })
    fireEvent.change(screen.getByLabelText('Access key'), { target: { value: 'new-key' } })
    fireEvent.change(screen.getByLabelText('Tunnel ID (optional)'), { target: { value: 'new-name' } })
    expect(serviceStore.envVarsRecord.OMPIUI_TUNNEL_URL).toBe('wss://saved-relay.test')
    expect(restart).not.toHaveBeenCalled()
    await save()
    expect(serviceStore.envVarsRecord).toEqual({
      OMPIUI_PORT: '9191',
      OMPIUI_TUNNEL_URL: 'wss://new-relay.test',
      OMPIUI_TUNNEL_KEY: 'new-key',
      OMPIUI_TUNNEL_ID: 'new-name',
    })
    expect(restart).toHaveBeenCalledOnce()
    expect(screen.getByText('Saving restarts the local service.')).toBeInTheDocument()
  })

  it('removes only the cleared relay field', async () => {
    render(<RelaySettings />)
    fireEvent.change(screen.getByLabelText('Tunnel ID (optional)'), { target: { value: '' } })
    await save()
    expect(serviceStore.envVarsRecord).toEqual({
      OMPIUI_PORT: '9191',
      OMPIUI_TUNNEL_URL: 'wss://saved-relay.test',
      OMPIUI_TUNNEL_KEY: 'saved-key',
    })
  })

  it('saves but leaves the restart to the user when another process owns the service', async () => {
    serviceStore.setStartedByUs(false)
    render(<RelaySettings />)
    fireEvent.change(screen.getByLabelText('Access key'), { target: { value: 'rotated-key' } })
    await save()
    expect(serviceStore.envVarsRecord.OMPIUI_TUNNEL_KEY).toBe('rotated-key')
    expect(restart).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('restart it yourself')
  })

  it('reports a failed restart and keeps the form usable', async () => {
    restart.mockRejectedValue(new Error('port in use'))
    render(<RelaySettings />)
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('port in use')
    expect(screen.getByRole('button', { name: 'Save and connect' })).toBeEnabled()
  })

  it('offers a way back only when there is a working relay to return to', () => {
    const cancel = vi.fn()
    const view = render(<RelaySettings />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    view.rerender(<RelaySettings onCancel={cancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['browser', 'mobile'])('does not offer a no-op local service form on %s', mode => {
    platform.desktop = mode === 'mobile'
    platform.mobile = mode === 'mobile'
    const saved = localStorage.getItem('ompiui-service-env-vars')
    render(<RelaySettings />)
    expect(screen.queryByLabelText('Relay URL')).not.toBeInTheDocument()
    expect(localStorage.getItem('ompiui-service-env-vars')).toBe(saved)
  })

  it('uses Chinese field names in the Chinese interface', async () => {
    await i18n.changeLanguage('zh-CN')
    const { container } = render(<RelaySettings />)
    expect(screen.getByLabelText('中转地址')).toBeInTheDocument()
    expect(screen.getByLabelText('接入密钥')).toBeInTheDocument()
    expect(screen.getByLabelText('隧道名称（可选）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeInTheDocument()
    expect(screen.getByText('保存后本机服务会重启。')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/Relay URL|Access key|Tunnel ID|Save and connect/)
  })
})
