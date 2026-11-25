import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ompSubagentStore } from '../../omp/ompSubagentStore'
import { SubagentPanel } from './SubagentPanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../message/tools/renderers/SubagentSessionPreview', () => ({ SubagentSessionPreview: ({ run }: { run?: { id: string; transcript: { text?: string }[] } }) =>
  <div data-testid="selected-transcript">{run?.id}{run?.transcript.map(item => item.text).join('\n')}</div> }))

beforeEach(() => ompSubagentStore.clearAll())
describe('subagent sidebar', () => {
  it('shows live output, switches agents, and does not leak another parent session', async () => {
    ompSubagentStore.applyLifecycle('parent', { id: 'First', parentToolCallId: 'task', index: 0, status: 'started' })
    ompSubagentStore.applyLifecycle('parent', { id: 'Second', parentToolCallId: 'task', index: 1, status: 'started' })
    ompSubagentStore.applyLifecycle('other', { id: 'OtherSession', status: 'started' })
    const view = render(<SubagentPanel sessionId="parent" />)
    expect(screen.queryByText('OtherSession')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Second/ }))
    act(() => ompSubagentStore.applyEvent('parent', { id: 'Second', event: { type: 'message_end', message: { role: 'assistant', content: 'Reading the source now' } } }))
    await waitFor(() => expect(screen.getByTestId('selected-transcript')).toHaveTextContent('Reading the source now'))
    view.rerender(<SubagentPanel sessionId="other" />)
    expect(screen.queryByRole('button', { name: /Second/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('selected-transcript')).toHaveTextContent('OtherSession')
  })
})
