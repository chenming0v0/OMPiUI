import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { serviceStore } from '../../../store/serviceStore'
import { RelaySettings } from './RelaySettings'

const platform = vi.hoisted(() => ({ desktop: true, mobile: false }))
vi.mock('../../../utils/tauri', () => ({
  isTauri: () => platform.desktop,
  isTauriMobile: () => platform.mobile,
}))

beforeEach(async () => {
  platform.desktop = true
  platform.mobile = false
  await i18n.changeLanguage('en')
  serviceStore.setEnvVars([
    { key: 'OMPIUI_PORT', value: '9191' },
    { key: 'OMPIUI_TUNNEL_URL', value: 'wss://saved-relay.test' },
    { key: 'OMPIUI_TUNNEL_KEY', value: 'saved-key' },
    { key: 'OMPIUI_TUNNEL_ID', value: 'saved-name' },
  ])
})
afterEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks() })

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

  it('updates the same service startup settings and preserves unrelated variables', () => {
    const view = render(<RelaySettings />)
    fireEvent.change(screen.getByLabelText('Relay URL'), { target: { value: 'wss://new-relay.test' } })
    fireEvent.change(screen.getByLabelText('Access key'), { target: { value: 'new-key' } })
    fireEvent.change(screen.getByLabelText('Tunnel ID (optional)'), { target: { value: 'new-name' } })
    expect(serviceStore.envVarsRecord).toEqual({
      OMPIUI_PORT: '9191',
      OMPIUI_TUNNEL_URL: 'wss://new-relay.test',
      OMPIUI_TUNNEL_KEY: 'new-key',
      OMPIUI_TUNNEL_ID: 'new-name',
    })
    view.unmount()
    render(<RelaySettings />)
    expect(screen.getByLabelText('Access key')).toHaveValue('new-key')
    expect(screen.getByLabelText('Relay URL')).toHaveValue('wss://new-relay.test')
  })

  it('removes only the cleared relay field', () => {
    render(<RelaySettings />)
    fireEvent.change(screen.getByLabelText('Tunnel ID (optional)'), { target: { value: '' } })
    expect(serviceStore.envVarsRecord).toEqual({
      OMPIUI_PORT: '9191',
      OMPIUI_TUNNEL_URL: 'wss://saved-relay.test',
      OMPIUI_TUNNEL_KEY: 'saved-key',
    })
  })

  it.each(['browser', 'mobile'])('does not offer a no-op local service form on %s', mode => {
    platform.desktop = mode === 'mobile'
    platform.mobile = mode === 'mobile'
    const saved = localStorage.getItem('ompiui-service-env-vars')
    render(<RelaySettings />)
    expect(screen.queryByLabelText('Relay URL')).not.toBeInTheDocument()
    expect(localStorage.getItem('ompiui-service-env-vars')).toBe(saved)
  })

  it('uses Chinese field names, instructions and warnings in the Chinese interface', async () => {
    await i18n.changeLanguage('zh-CN')
    const { container } = render(<RelaySettings />)
    expect(screen.getByRole('heading', { name: '自建中转' })).toBeInTheDocument()
    expect(screen.getByLabelText('中转地址')).toBeInTheDocument()
    expect(screen.getByLabelText('接入密钥')).toBeInTheDocument()
    expect(screen.getByLabelText('隧道名称（可选）')).toBeInTheDocument()
    expect(screen.getByText(/请到「服务」页面重启本机服务/)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/Relay settings|Access key|Tunnel ID|Restart the service/)
  })
})
