// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiResourceManagement } from './PiResourceManagement'

function translate(key: string) { return key }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}))

const { registryMock, skillsMock, promptsMock, agentsFilesMock, reloadMock } = vi.hoisted(() => ({
  registryMock: vi.fn(),
  skillsMock: vi.fn(),
  promptsMock: vi.fn(),
  agentsFilesMock: vi.fn(),
  reloadMock: vi.fn(),
}))

vi.mock('../../../omp/controllers/index.js', () => ({
  reloadPiSessionResources: (...args: unknown[]) => reloadMock(...args),
}))

vi.mock('../../../omp/transport/index.js', () => ({
  getPiSessionRegistry: (...args: unknown[]) => registryMock(...args),
  getPiSkills: (...args: unknown[]) => skillsMock(...args),
  getPiPrompts: (...args: unknown[]) => promptsMock(...args),
  getPiAgentsFiles: (...args: unknown[]) => agentsFilesMock(...args),
}))

const emptyExtensionUi = { sessions: {} }
vi.mock('../../../omp/extensionUiStore', () => ({
  extensionUiStore: {
    subscribe: () => () => {},
    getSnapshot: () => emptyExtensionUi,
  },
}))

vi.mock('../../../omp/managementEventStore', () => ({
  useManagementEvents: () => ({ resourceRevisions: {} }),
}))

vi.mock('../../../store/serverStore', () => ({
  serverStore: { subscribe: () => () => {}, getActiveServerGeneration: () => 0 },
}))

describe('PiResourceManagement', () => {
  beforeEach(() => {
    registryMock.mockReset().mockResolvedValue({
      extensions: [],
      tools: [{ name: 'mock-tool', description: 'a mock tool' }],
      activeTools: ['mock-tool'],
      commands: [{ name: 'reload', description: 'reload resources' }],
      eventHandlers: ['message_end'],
    })
    promptsMock.mockReset().mockResolvedValue([
      { name: 'code-review', description: 'Review this change', argumentHint: '<files>', content: '...', sourceInfo: { source: 'omp-extension' }, filePath: '/tmp/review.md' },
    ])
    skillsMock.mockReset().mockResolvedValue([
      { name: 'debug', description: 'Debug a failing test', filePath: '/tmp/debug.md', baseDir: '/tmp', sourceInfo: { source: 'omp-extension' }, disableModelInvocation: false },
    ])
    agentsFilesMock.mockReset().mockResolvedValue([
      { path: 'AGENTS.md', content: '# rules\none rule' },
    ])
    reloadMock.mockReset().mockResolvedValue(undefined)
  })


  it('checks whether an extension event type has a registered handler', async () => {
    render(<PiResourceManagement sessionId="session-1" workspacePath="E:\\workspace" />)
    fireEvent.click(screen.getByRole('button', { name: 'pi.resourcesAdvanced' }))
    fireEvent.click(await screen.findByRole('button', { name: /pi\.eventHandlers/ }))
    await screen.findByText('message_end')

    const input = screen.getByPlaceholderText('pi.eventTypePlaceholder')
    fireEvent.change(input, { target: { value: 'message_end' } })
    fireEvent.click(screen.getByRole('button', { name: 'pi.checkHandler' }))

    await waitFor(() => {
      expect(screen.getByText('pi.handlerRegistered')).toBeInTheDocument()
    })
    fireEvent.change(input, { target: { value: 'repair341-never-registered' } })
    fireEvent.click(screen.getByRole('button', { name: 'pi.checkHandler' }))
    expect(screen.getByText('pi.handlerNotRegistered')).toBeInTheDocument()
  })

  it('does not report unavailable handler metadata as unregistered', async () => {
    registryMock.mockResolvedValue({ tools: [], activeTools: [], commands: [], extensions: null, eventHandlers: null, resourceErrors: { eventHandlers: 'Enumeration unavailable' } })
    render(<PiResourceManagement sessionId="session-1" workspacePath="/one" />)
    fireEvent.click(screen.getByRole('button', { name: 'pi.resourcesAdvanced' }))
    await screen.findByText('pi.resourcesHandlerUnknown')
    fireEvent.change(screen.getByPlaceholderText('pi.eventTypePlaceholder'), { target: { value: 'message_end' } })
    expect(screen.getByRole('button', { name: 'pi.checkHandler' })).toBeDisabled()
    expect(screen.queryByText('pi.handlerNotRegistered')).not.toBeInTheDocument()
  })

  it('keeps available knowledge when registry inspection fails', async () => {
    registryMock.mockRejectedValue(new Error('Runtime unavailable'))
    render(<PiResourceManagement sessionId="session-1" workspacePath="/one" />)
    await screen.findByText(/Runtime unavailable/)
    fireEvent.click(screen.getByRole('button', { name: /pi.skills/ }))
    expect(screen.getByText('debug')).toBeInTheDocument()
    expect(screen.getByText('/tmp/debug.md')).toBeInTheDocument()
  })

  it('shows discovery warnings even when no skills were loaded', async () => {
    skillsMock.mockResolvedValue([])
    registryMock.mockResolvedValue({ tools: [], activeTools: [], commands: [], extensions: [], eventHandlers: [], skillWarnings: [{ skillPath: '/skills', message: 'Skill directory was unreadable' }] })
    render(<PiResourceManagement sessionId="session-1" workspacePath="/one" />)
    fireEvent.click(await screen.findByRole('button', { name: 'pi.resourcesSkillWarnings' }))
    expect(screen.getByText(/Skill directory was unreadable/)).toBeInTheDocument()
  })

  it('clears old rows when a read-only refresh fails', async () => {
    render(<PiResourceManagement sessionId="session-1" workspacePath="/one" />)
    fireEvent.click(await screen.findByRole('button', { name: /pi.skills/ }))
    expect(screen.getByText('debug')).toBeInTheDocument()
    skillsMock.mockRejectedValue(new Error('Skills discovery unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'common:refresh' }))
    await screen.findByText(/Skills discovery unavailable/)
    expect(screen.queryByText('debug')).not.toBeInTheDocument()
    expect(reloadMock).not.toHaveBeenCalled()
  })

  it('does not expose old session knowledge after a delayed response', async () => {
    const old = Promise.withResolvers<unknown[]>()
    skillsMock.mockImplementation((id: string) => id === 'session-1' ? old.promise : Promise.resolve([{ name: 'new-session-skill', description: 'Current', filePath: '/new/SKILL.md' }]))
    const view = render(<PiResourceManagement sessionId="session-1" workspacePath="/one" />)
    await waitFor(() => expect(skillsMock.mock.calls.some(([id]) => id === 'session-1')).toBe(true))
    view.rerender(<PiResourceManagement sessionId="session-2" workspacePath="/two" />)
    fireEvent.click(await screen.findByRole('button', { name: /pi.skills/ }))
    await screen.findByText('new-session-skill')
    await act(async () => { old.resolve([{ name: 'old-session-secret', description: 'Old', filePath: '/old/SKILL.md' }]); await old.promise })
    expect(screen.queryByText('old-session-secret')).not.toBeInTheDocument()
    expect(screen.getByText('new-session-skill')).toBeInTheDocument()
  })
})
