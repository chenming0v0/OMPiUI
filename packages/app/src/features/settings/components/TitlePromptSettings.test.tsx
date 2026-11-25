import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyReconnected } from '../../../hooks/useGlobalEvents'
import { receiveSettingsUpdated, resetManagementEvents } from '../../../omp/managementEventStore'
import { TitlePromptSettings } from './TitlePromptSettings'

const mocks = vi.hoisted(() => ({ command: vi.fn() }))
vi.mock('../../../omp/transport', () => ({ postPiGlobalCommand: mocks.command }))

function configuration(prefix = 'original') {
  return {
    forkPrompt: `${prefix} fork`, tinyPrompt: `${prefix} tiny`, cardPrompt: `${prefix} card`,
    defaults: { forkPrompt: 'default fork', tinyPrompt: 'default tiny', cardPrompt: 'default card' },
  }
}

describe('authoritative title prompt settings', () => {
  beforeEach(() => {
    resetManagementEvents()
    mocks.command.mockReset().mockImplementation(async (name, prompts) =>
      name === 'title.settings.set' ? { ...configuration(), ...prompts } : configuration())
  })

  it('overwrites every dirty prompt on incoming configuration, then saves A fields with B new edit', async () => {
    render(<TitlePromptSettings />)
    const fork = await screen.findByRole('textbox', { name: 'Title generation prompt' })
    await waitFor(() => expect(fork).toHaveValue('original fork'))
    fireEvent.change(fork, { target: { value: 'B unsaved fork' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Fallback / replan title prompt' }), { target: { value: 'B unsaved tiny' } })
    mocks.command.mockResolvedValueOnce(configuration('A'))
    act(() => receiveSettingsUpdated())
    await waitFor(() => expect(fork).toHaveValue('A fork'))
    expect(screen.getByRole('textbox', { name: 'Fallback / replan title prompt' })).toHaveValue('A tiny')
    fireEvent.change(fork, { target: { value: 'B new fork' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith('title.settings.set', {
      forkPrompt: 'B new fork', tinyPrompt: 'A tiny', cardPrompt: 'A card',
    }, expect.any(AbortSignal)))
  })

  it('overwrites dirty prompts on reconnect rather than protecting unsaved edits', async () => {
    render(<TitlePromptSettings />)
    const fork = screen.getByRole('textbox', { name: 'Title generation prompt' })
    await waitFor(() => expect(fork).toHaveValue('original fork'))
    fireEvent.change(fork, { target: { value: 'B unsaved' } })
    mocks.command.mockResolvedValueOnce(configuration('A'))
    act(() => notifyReconnected())
    await waitFor(() => expect(fork).toHaveValue('A fork'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('ignores an older read after a newer title snapshot becomes effective', async () => {
    render(<TitlePromptSettings />)
    const fork = screen.getByRole('textbox', { name: 'Title generation prompt' })
    await waitFor(() => expect(fork).toHaveValue('original fork'))
    const old = Promise.withResolvers<ReturnType<typeof configuration>>()
    mocks.command.mockReturnValueOnce(old.promise)
    act(() => receiveSettingsUpdated())
    mocks.command.mockResolvedValueOnce(configuration('A'))
    act(() => receiveSettingsUpdated())
    await waitFor(() => expect(fork).toHaveValue('A fork'))
    await act(async () => { old.resolve(configuration('old')) })
    expect(fork).toHaveValue('A fork')
  })

  it('ignores an older save response after an incoming successful configuration', async () => {
    render(<TitlePromptSettings />)
    const fork = screen.getByRole('textbox', { name: 'Title generation prompt' })
    await waitFor(() => expect(fork).toHaveValue('original fork'))
    const old = Promise.withResolvers<ReturnType<typeof configuration>>()
    mocks.command.mockReturnValueOnce(old.promise)
    fireEvent.change(fork, { target: { value: 'B old save' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    mocks.command.mockResolvedValueOnce(configuration('A'))
    act(() => receiveSettingsUpdated())
    await waitFor(() => expect(fork).toHaveValue('A fork'))
    await act(async () => { old.resolve(configuration('B old')) })
    expect(fork).toHaveValue('A fork')
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
  })
})
