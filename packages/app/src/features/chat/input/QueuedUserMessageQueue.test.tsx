import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueuedUserMessageQueue } from './QueuedUserMessageQueue'

vi.mock('../../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false }),
}))

describe('queued user message send-now action', () => {
  it('submits the selected index once and blocks mutations until acceptance', async () => {
    let finish!: () => void
    const accepting = new Promise<void>(resolve => { finish = resolve })
    const onSendNow = vi.fn(() => accepting)
    const onClear = vi.fn()
    render(<QueuedUserMessageQueue kind="next" items={['first', 'second']} onSendNow={onSendNow} onClear={onClear} />)
    const buttons = screen.getAllByRole('button', { name: /立即发送|send now/i })
    fireEvent.click(buttons[1])
    fireEvent.click(buttons[1])
    await waitFor(() => expect(onSendNow).toHaveBeenCalledExactlyOnceWith('followUp', 1))
    expect(buttons.every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    const clearButtons = screen.getAllByRole('button', { name: /移除|清除|remove|clear/i })
    for (const button of clearButtons) fireEvent.click(button)
    expect(onClear).not.toHaveBeenCalled()
    await act(async () => { finish(); await accepting })
    expect(buttons.every(button => !(button as HTMLButtonElement).disabled)).toBe(true)
  })
})
