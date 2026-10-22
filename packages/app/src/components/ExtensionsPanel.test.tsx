import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionsPanel } from './ExtensionsPanel'
import { commandFeedbackStore } from '../omp/commandFeedbackStore'
import { extensionUiStore } from '../omp/extensionUiStore'
import { extensionTuiStore } from '../omp/extensionTuiStore'
import i18n from '../i18n'

describe('native command feedback panel', () => {
  beforeEach(async () => {
    commandFeedbackStore.reset()
    extensionUiStore.reset()
    extensionTuiStore.reset()
    await i18n.changeLanguage('en')
  })
  afterEach(cleanup)

  it('shows every line including the final line without an assistant message or toast', () => {
    const message = Array.from({ length: 120 }, (_, index) => `workspace ${index}: C:/工作区/directory-${index}`).join('\n') + '\n'
    commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: message })
    const { container } = render(<ExtensionsPanel sessionId="a" />)
    expect(container.querySelector('pre')?.textContent).toBe(message)
  })

  it('keeps a background pane result in its session and clears only the displayed session', () => {
    commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: 'workspace-a\nextra-a' })
    const { rerender } = render(<ExtensionsPanel sessionId="b" />)
    act(() => {
      commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: 'Fast mode is off.' })
      commandFeedbackStore.addNativeEvent('b', { type: 'command_output', text: 'workspace-b' })
    })
    expect(screen.queryByText('Fast mode is off.')).toBeNull()
    expect(screen.getByText('workspace-b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText('workspace-b')).toBeNull()
    rerender(<ExtensionsPanel sessionId="a" />)
    expect(screen.getByText('Fast mode is off.')).toBeInTheDocument()
    expect(screen.getByText(/extra-a/)).toBeInTheDocument()
  })

  it('displays native error semantics without terminal colour escape characters', () => {
    const message = '\u001b[31mNative command rejected.\u001b[0m\nNo changes written.'
    commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: message, isError: true })
    const { container } = render(<ExtensionsPanel sessionId="a" />)
    expect(screen.getByText('error')).toBeInTheDocument()
    expect(screen.queryByText('ok')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('Native command rejected.\nNo changes written.')
    expect(commandFeedbackStore.getSnapshot().sessions.a?.[0]?.message).toBe(message)
  })
})
