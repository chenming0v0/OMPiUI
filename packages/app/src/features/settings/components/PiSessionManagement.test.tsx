// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiSessionManagement } from './PiSessionManagement'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { setScopedModelsMock, loadSessionsMock, exportPiSessionMock } = vi.hoisted(() => ({
  setScopedModelsMock: vi.fn(),
  loadSessionsMock: vi.fn(),
  exportPiSessionMock: vi.fn(),
}))

vi.mock('../../../omp/controllers/index.js', () => ({
  abortPiBashExecution: vi.fn(),
  appendPiCustomEntry: vi.fn(),
  cyclePiModel: vi.fn(),
  cyclePiThinkingLevel: vi.fn(),
  executePiBash: vi.fn(),
  exportPiSession: (...args: unknown[]) => exportPiSessionMock(...args),
  loadPiSessionsForCwd: () => loadSessionsMock(),
  newPiSessionFrom: vi.fn(),
  openPiSession: vi.fn(),
  sendPiCustomMessage: vi.fn(),
  sendPiPrompt: vi.fn(),
  sendPiUserMessage: vi.fn(),
  setPiScopedModels: (...args: unknown[]) => setScopedModelsMock(...args),
  waitForPiIdle: vi.fn(),
}))

vi.mock('../../../omp/hooks/index.js', () => ({
  usePiSessionRuntimeState: () => ({
    scopedModels: ['anthropic:claude-sonnet-4', 'openai:gpt-5'],
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
    thinkingLevel: 'off',
    isStreaming: false,
  }),
}))

function scopedModelsTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'pi.scopedModelsLabel' }) as HTMLTextAreaElement
}

describe('PiSessionManagement scoped models', () => {
  beforeEach(() => {
    setScopedModelsMock.mockReset().mockResolvedValue(undefined)
    loadSessionsMock.mockReset().mockResolvedValue([])
    exportPiSessionMock.mockReset().mockResolvedValue({ path: 'E:\\out.jsonl' })
  })

  it('applies trimmed, non-empty patterns through the native command', async () => {
    render(<PiSessionManagement sessionId="session-1" workspacePath="E:\\workspace" />)
    fireEvent.click(screen.getByRole('button', { name: /pi\.sessionControls/ }))

    await waitFor(() => {
      expect(scopedModelsTextarea().value).toBe('anthropic:claude-sonnet-4\nopenai:gpt-5')
    })
    fireEvent.change(scopedModelsTextarea(), { target: { value: ' anthropic:claude-sonnet-4 \n\nopenai:gpt-5 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'pi.applyModelScope' }))

    await waitFor(() => {
      expect(setScopedModelsMock).toHaveBeenCalledWith('session-1', ['anthropic:claude-sonnet-4', 'openai:gpt-5'])
    })
  })
})
