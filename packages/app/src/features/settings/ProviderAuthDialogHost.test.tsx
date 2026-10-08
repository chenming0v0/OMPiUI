import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderAuthDialogHost } from './ProviderAuthDialogHost'
import {
  receiveProviderAuthEvent,
  registerProviderAuthFlow,
  resetManagementEvents,
} from '../../omp/managementEventStore'

const mocks = vi.hoisted(() => ({ respond: vi.fn(), cancel: vi.fn(), listFlows: vi.fn() }))
vi.mock('../../omp/transport/index.js', () => ({
  respondProviderAuth: mocks.respond,
  cancelProviderAuth: mocks.cancel,
  listActiveProviderFlows: mocks.listFlows,
}))

describe('ProviderAuthDialogHost', () => {
  beforeEach(() => {
    resetManagementEvents()
    mocks.respond.mockReset().mockResolvedValue(undefined)
    mocks.cancel.mockReset().mockResolvedValue(undefined)
    mocks.listFlows.mockReset().mockResolvedValue([])
  })

  it('renders a secret prompt and submits it to the matching global flow', async () => {
    render(<ProviderAuthDialogHost />)
    act(() => {
      registerProviderAuthFlow('flow-1', 'anthropic')
      receiveProviderAuthEvent({
        type: 'prompt',
        flowId: 'flow-1',
        promptId: 'prompt-1',
        providerId: 'anthropic',
        prompt: { type: 'secret', message: 'Enter API key', placeholder: 'key' },
      })
    })

    const input = screen.getByPlaceholderText('key')
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'secret-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith('flow-1', 'prompt-1', 'secret-value'))
  })

  it('cancels the flow when the dialog closes', async () => {
    render(<ProviderAuthDialogHost />)
    act(() => {
      registerProviderAuthFlow('flow-2', 'openai', 'session-1')
      receiveProviderAuthEvent({ type: 'notification', flowId: 'flow-2', providerId: 'openai', event: { url: 'https://example.test/login' } }, 'session-1')
    })
    expect(screen.getByRole('link', { name: 'Open authentication URL' })).toHaveAttribute('href', 'https://example.test/login')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('flow-2'))
  })

  it('restores an in-flight prompt from the active-flow snapshot after a refresh', async () => {
    mocks.listFlows.mockResolvedValue([{
      flowId: 'flow-3',
      providerId: 'anthropic',
      event: {
        type: 'prompt',
        flowId: 'flow-3',
        promptId: 'prompt-3',
        providerId: 'anthropic',
        prompt: { type: 'secret', message: 'Enter API key', placeholder: 'key' },
      },
      notifications: [],
    }])
    render(<ProviderAuthDialogHost />)

    const input = await screen.findByPlaceholderText('key')
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'recovered' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith('flow-3', 'prompt-3', 'recovered'))
  })

  it('restores the current notification from the active-flow snapshot', async () => {
    mocks.listFlows.mockResolvedValue([{
      flowId: 'flow-4',
      providerId: 'openai',
      event: {
        type: 'notification',
        flowId: 'flow-4',
        providerId: 'openai',
        event: { kind: 'open_url', url: 'https://example.test/device' },
      },
      notifications: [{ kind: 'open_url', url: 'https://example.test/device' }],
    }])
    render(<ProviderAuthDialogHost />)
    expect(await screen.findByRole('link', { name: 'Open authentication URL' })).toHaveAttribute('href', 'https://example.test/device')
  })

  it('does not let a refresh snapshot overwrite a newer prompt', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    mocks.listFlows.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    render(<ProviderAuthDialogHost />)
    act(() => {
      receiveProviderAuthEvent({
        type: 'prompt',
        flowId: 'flow-new',
        promptId: 'prompt-b',
        providerId: 'anthropic',
        prompt: { type: 'text', message: 'Newer prompt', placeholder: 'newer' },
      })
    })
    expect(screen.getByPlaceholderText('newer')).toBeInTheDocument()

    await act(async () => {
      for (const resolve of resolvers) resolve([{
        flowId: 'flow-new',
        providerId: 'anthropic',
        event: {
          type: 'prompt',
          flowId: 'flow-new',
          promptId: 'prompt-a',
          providerId: 'anthropic',
          prompt: { type: 'text', message: 'Stale prompt', placeholder: 'stale' },
        },
        notifications: [],
        response: 'credential-must-not-leak',
      }])
    })
    expect(screen.getByPlaceholderText('newer')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('stale')).not.toBeInTheDocument()
    expect(screen.queryByText('credential-must-not-leak')).not.toBeInTheDocument()
  })

  it('does not let a refresh snapshot revive a dismissed flow', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    mocks.listFlows.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    render(<ProviderAuthDialogHost />)
    act(() => {
      receiveProviderAuthEvent({
        type: 'notification',
        flowId: 'flow-dismissed',
        providerId: 'openai',
        event: { url: 'https://example.test/old' },
      })
    })
    expect(screen.getByRole('link', { name: 'Open authentication URL' })).toHaveAttribute('href', 'https://example.test/old')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('flow-dismissed'))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Open authentication URL' })).not.toBeInTheDocument())

    await act(async () => {
      for (const resolve of resolvers) resolve([{
        flowId: 'flow-dismissed',
        providerId: 'openai',
        event: {
          type: 'notification',
          flowId: 'flow-dismissed',
          providerId: 'openai',
          event: { url: 'https://example.test/revived' },
        },
        notifications: [],
      }])
    })
    expect(screen.queryByRole('link', { name: 'Open authentication URL' })).not.toBeInTheDocument()
  })

  it('does not clear prompt B when the response for prompt A resolves after B arrived', async () => {
    let resolveRespond: (value?: unknown) => void = () => {}
    mocks.respond.mockImplementation(() => new Promise(resolve => { resolveRespond = resolve }))
    render(<ProviderAuthDialogHost />)
    act(() => {
      registerProviderAuthFlow('flow-1', 'anthropic')
      receiveProviderAuthEvent({
        type: 'prompt',
        flowId: 'flow-1',
        promptId: 'prompt-a',
        providerId: 'anthropic',
        prompt: { type: 'secret', message: 'First prompt', placeholder: 'first' },
      })
    })
    fireEvent.change(screen.getByPlaceholderText('first'), { target: { value: 'one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith('flow-1', 'prompt-a', 'one'))
    act(() => {
      receiveProviderAuthEvent({
        type: 'prompt',
        flowId: 'flow-1',
        promptId: 'prompt-b',
        providerId: 'anthropic',
        prompt: { type: 'secret', message: 'Second prompt', placeholder: 'second' },
      })
    })
    expect(screen.getByPlaceholderText('second')).toBeInTheDocument()
    await act(async () => { resolveRespond() })
    expect(screen.getByPlaceholderText('second')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('first')).not.toBeInTheDocument()
  })
})
