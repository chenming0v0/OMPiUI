import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalBar } from './GoalBar'

const { manageGoal, waitCommand, refresh, state } = vi.hoisted(() => ({
  manageGoal: vi.fn(), waitCommand: vi.fn(), refresh: vi.fn(), state: { goalState: null as unknown },
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../omp/transport/index.js', () => ({ manageSessionGoal: manageGoal, waitHostCommand: waitCommand }))
vi.mock('../../../omp/controllers/index.js', () => ({ refreshPiSessionState: refresh }))
vi.mock('../../../omp/state/index.js', () => ({ piSessionStateStore: { subscribe: () => () => {}, getState: () => state } }))

const nativeGoal = (status = 'active') => ({ enabled: status === 'active', mode: 'active', goal: {
  id: 'native-id', objective: 'Native objective', status, tokensUsed: 123, tokenBudget: 1000,
  timeUsedSeconds: 7, createdAt: 1, updatedAt: 1,
} })

describe('native goal UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.goalState = null
    manageGoal.mockResolvedValue({ id: 'goal-command' })
    waitCommand.mockResolvedValue({})
    refresh.mockResolvedValue(undefined)
  })
  it.each([false, true])('rejects goal images without a shadow attachment in compact=%s', isCompact => {
    render(<GoalBar sessionId="session" isCompact={isCompact} />)
    fireEvent.click(screen.getByText('goalBar.setGoal'))
    fireEvent.paste(screen.getByRole('textbox', { name: 'goalBar.objective' }), { clipboardData: { items: [{ kind: 'file', type: 'image/png' }] } })
    expect(screen.getByRole('alert')).toHaveTextContent('goalBar.imagesUnsupported')
    expect(screen.queryByRole('img')).toBeNull()
    expect(manageGoal).not.toHaveBeenCalled()
  })
  it('creates with native token budget and preserves the draft on actual command failure', async () => {
    waitCommand.mockRejectedValue(new Error('native rejected objective'))
    render(<GoalBar sessionId="session" isCompact={false} />)
    fireEvent.click(screen.getByText('goalBar.setGoal'))
    fireEvent.change(screen.getByRole('textbox', { name: 'goalBar.objective' }), { target: { value: 'Fix layout' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'goalBar.tokenBudget' }), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'common:save' }))
    await screen.findByRole('alert')
    expect(manageGoal).toHaveBeenCalledWith('session', 'create', { objective: 'Fix layout', tokenBudget: 500 })
    expect(screen.getByRole('textbox', { name: 'goalBar.objective' })).toHaveValue('Fix layout')
    expect(screen.getByRole('alert')).toHaveTextContent('native rejected objective')
  })
  it('projects real usage/time and adjusts budget without replacing the goal', async () => {
    state.goalState = nativeGoal('paused')
    render(<GoalBar sessionId="session" isCompact={false} />)
    expect(screen.getByText(/877/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Native objective/))
    expect(screen.getByText('native-id')).toBeInTheDocument()
    expect(screen.getByText('7s')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'goalBar.objective' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'goalBar.tokenBudget' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'common:save' }))
    await waitFor(() => expect(manageGoal).toHaveBeenCalledWith('session', 'budget', { clearBudget: true }))
  })
  it('uses explicit completion and read-only refresh, not a get that opens a writer', async () => {
    state.goalState = nativeGoal()
    render(<GoalBar sessionId="session" isCompact={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'goalBar.refresh' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledWith('session'))
    expect(manageGoal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'goalBar.completeAction' }))
    await waitFor(() => expect(manageGoal).toHaveBeenCalledWith('session', 'complete', {}))
  })
  it('prevents invalid token budgets from reaching the native runtime', () => {
    render(<GoalBar sessionId="session" isCompact={false} />)
    fireEvent.click(screen.getByText('goalBar.setGoal'))
    fireEvent.change(screen.getByRole('textbox', { name: 'goalBar.objective' }), { target: { value: 'objective' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'goalBar.tokenBudget' }), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'common:save' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('goalBar.invalidBudget')
  })
})
