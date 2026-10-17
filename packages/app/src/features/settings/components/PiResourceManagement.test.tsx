// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiResourceManagement } from './PiResourceManagement'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { registryMock, skillsMock, promptsMock, agentsFilesMock, reloadMock } = vi.hoisted(() => ({
  registryMock: vi.fn(),
  skillsMock: vi.fn(),
  promptsMock: vi.fn(),
  agentsFilesMock: vi.fn(),
  reloadMock: vi.fn(),
}))

vi.mock('../../../omp/controllers/index.js', () => ({
  loadPiSessionRegistry: () => registryMock(),
  reloadPiSessionResources: (...args: unknown[]) => reloadMock(...args),
}))

vi.mock('../../../omp/transport/index.js', () => ({
  getPiSkills: () => skillsMock(),
  getPiPrompts: () => promptsMock(),
  getPiAgentsFiles: () => agentsFilesMock(),
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
  })
})
