import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueuedUserMessageQueue } from './QueuedUserMessageQueue'

vi.mock('../../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false }),
}))

describe('queued user message send-now action', () => {
  it('does not allow mutations before a pending preview acquires native identity', () => {
    const pending = { entryId: 'submitted:local:preview', text: 'waiting for admission', pending: true }
    const onSendNow = vi.fn()
    const view = render(<QueuedUserMessageQueue kind="next" items={[pending]} onSendNow={onSendNow} />)
    expect(screen.getByText(pending.text)).toBeVisible()
    expect(screen.queryByRole('button', { name: /立即发送|send now/i })).toBeNull()
    view.rerender(<QueuedUserMessageQueue kind="next" items={[{ ...pending, entryId: 'native-entry', pending: false }]} onSendNow={onSendNow} />)
    expect(screen.getByRole('button', { name: /立即发送|send now/i })).toBeEnabled()
  })
  it('submits the selected index once and blocks mutations until acceptance', async () => {
    const { promise: accepting, resolve: finish } = Promise.withResolvers<void>()
    const onSendNow = vi.fn(() => accepting)
    const onClear = vi.fn()
    render(<QueuedUserMessageQueue kind="next" items={[{ entryId: 'first', text: 'first' }, { entryId: 'second', text: 'second' }]} onSendNow={onSendNow} onClear={onClear} />)
    const buttons = screen.getAllByRole('button', { name: /立即发送|send now/i })
    fireEvent.click(buttons[1])
    fireEvent.click(buttons[1])
    await waitFor(() => expect(onSendNow).toHaveBeenCalledTimes(1))
    expect(buttons.every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    const clearButtons = screen.getAllByRole('button', { name: /移除|清除|remove|clear/i })
    for (const button of clearButtons) fireEvent.click(button)
    expect(onClear).not.toHaveBeenCalled()
    await act(async () => { finish(); await accepting })
    expect(buttons.every(button => !(button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('keeps an image-only queued message identifiable without inline image data', () => {
    render(<QueuedUserMessageQueue kind="current" items={[{ entryId: 'image-only', text: '', images: [{ mimeType: 'image/png', dataOmitted: true }] }]} />)
    expect(screen.getByLabelText(/1.*(?:image|图片)/i)).toBeVisible()
  })

  it('retains the queued image and unlocks actions after backend rejection', async () => {
    const rejecting = Promise.withResolvers<void>()
    render(<QueuedUserMessageQueue kind="next" items={[{ entryId: 'kept-image', text: 'keep me', images: [{ mimeType: 'image/png', dataOmitted: true }] }]} onClear={() => rejecting.promise} />)
    const remove = screen.getByRole('button', { name: /移除|清除|remove|clear/i })
    fireEvent.click(remove)
    expect(remove).toBeDisabled()
    await act(async () => { rejecting.reject(new Error('Native queue selection rejected')) })
    expect(screen.getByText('keep me')).toBeVisible()
    expect(screen.getByLabelText(/1.*(?:image|图片)/i)).toBeVisible()
    expect(remove).not.toBeDisabled()
  })
})
