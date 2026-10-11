import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalBar } from './GoalBar'

const { manageGoal, waitCommand, state } = vi.hoisted(() => ({
  manageGoal: vi.fn(), waitCommand: vi.fn(), state: { goal: null as unknown },
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../omp/transport/index.js', () => ({ manageSessionGoal: manageGoal, waitHostCommand: waitCommand }))
vi.mock('../../../omp/state/index.js', () => ({ piSessionStateStore: {
  subscribe: () => () => {}, getState: () => state,
} }))

function pasteImage() {
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [
    { kind: 'file', getAsFile: () => new File(['image'], 'reference.png', { type: 'image/png' }) },
  ] } })
}

describe('goal image editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.goal = null
    manageGoal.mockResolvedValue({ id: 'goal-command' })
    waitCommand.mockResolvedValue({})
  })

  it.each([false, true])('pastes, previews, removes and submits images in compact=%s', async isCompact => {
    const onSetGoal = vi.fn().mockResolvedValue(true)
    render(<GoalBar isCompact={isCompact} supportsImages onSetGoal={onSetGoal} />)
    fireEvent.click(screen.getByText('goalBar.setGoal'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '修复图片中的布局' } })
    pasteImage()
    expect(screen.getByRole('button', { name: 'common:save' })).toBeDisabled()
    await screen.findByRole('img', { name: 'goalBar.imageAlt' })
    fireEvent.click(screen.getByRole('button', { name: 'goalBar.removeImage' }))
    expect(screen.queryByRole('img')).toBeNull()
    pasteImage()
    await screen.findByRole('img', { name: 'goalBar.imageAlt' })
    fireEvent.click(screen.getByRole('button', { name: 'common:save' }))
    await waitFor(() => expect(onSetGoal).toHaveBeenCalledWith('修复图片中的布局', [
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
    ]))
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  })

  it('sends images through the existing-session command and preserves the draft on failure', async () => {
    waitCommand.mockRejectedValue(new Error('failed'))
    render(<GoalBar sessionId="session" isCompact={false} supportsImages />)
    fireEvent.click(screen.getByText('goalBar.setGoal'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '修复截图' } })
    pasteImage()
    await screen.findByRole('img', { name: 'goalBar.imageAlt' })
    fireEvent.click(screen.getByRole('button', { name: 'common:save' }))
    await screen.findByRole('alert')
    expect(manageGoal).toHaveBeenCalledWith('session', 'set', '修复截图', undefined, [
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
    ])
    expect(screen.getByRole('textbox')).toHaveValue('修复截图')
    expect(screen.getByRole('img', { name: 'goalBar.imageAlt' })).toBeInTheDocument()
  })

  it('restores stored goal images when editing and reports unsupported image input', () => {
    state.goal = { id: 'goal', objective: '原目标', status: 'paused', images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] }
    render(<GoalBar sessionId="session" isCompact={false} supportsImages={false} />)
    fireEvent.click(screen.getByText('原目标'))
    expect(screen.getByRole('img', { name: 'goalBar.imageAlt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common:save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'goalBar.removeImage' }))
    pasteImage()
    expect(screen.getByRole('alert')).toHaveTextContent('goalBar.imagesUnsupported')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
