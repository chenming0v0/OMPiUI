import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiManagementSettings } from './PiManagementSettings'

const { patchSettingsMock } = vi.hoisted(() => ({ patchSettingsMock: vi.fn() }))

const settings = {
  global: {},
  project: {},
  errors: [],
  effective: {},
}

vi.mock('../../../hooks', () => ({ useCurrentDirectory: () => '/workspace' }))
vi.mock('../../../omp/hooks/index.js', () => ({ useFocusedSessionId: () => 'session' }))
vi.mock('../../../omp/transport/index.js', () => ({
  getPiSettings: vi.fn(async () => settings),
  getProjectTrust: vi.fn(async () => ({
    trusted: false,
    decision: null,
    required: true,
    defaultDecision: 'ask',
  })),
  patchPiSettings: (...args: unknown[]) => patchSettingsMock(...args),
  setProjectTrust: vi.fn(),
}))
vi.mock('../../../omp/workspaces', () => ({
  listHostWorkspaces: vi.fn(async () => []),
  resolveWorkspacePath: vi.fn(async () => '/workspace'),
}))
vi.mock('./PiPackageManagement', () => ({ PiPackageManagement: () => null }))
vi.mock('./PiResourceManagement', () => ({ PiResourceManagement: () => null }))
vi.mock('./PiSessionManagement', () => ({ PiSessionManagement: () => null }))

describe('PiManagementSettings', () => {
  beforeEach(() => {
    patchSettingsMock.mockReset().mockResolvedValue(settings)
  })

  it('keeps unspecified runtime defaults distinct from explicitly disabled settings', async () => {
    render(<PiManagementSettings />)
    const compaction = await screen.findByRole('button', { name: 'Auto-compact context' })
    expect(compaction).toHaveTextContent('Runtime default')
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveTextContent('Runtime default')

    fireEvent.click(compaction)
    fireEvent.click(screen.getByRole('option', { name: 'Off' }))
    expect(compaction).toHaveTextContent('Off')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSettingsMock).toHaveBeenCalled())
    const submitted = JSON.parse(JSON.stringify(patchSettingsMock.mock.calls[0][1]))
    expect(submitted.compactionEnabled).toBe(false)
    expect(submitted).not.toHaveProperty('retryEnabled')
    expect(submitted).not.toHaveProperty('enableSkillCommands')
    expect(submitted).not.toHaveProperty('showImages')
    expect(submitted).not.toHaveProperty('defaultThinkingLevel')
  })
})
