import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolInteractionDescriptor } from '@ompiui/protocol'
import { FullscreenProvider } from '../../../../contexts'
import { ToolInteractionTerminal } from './ToolInteractionTerminal'

const { createViewport, fit, dispose } = vi.hoisted(() => ({
  createViewport: vi.fn(), fit: vi.fn(), dispose: vi.fn(),
}))
vi.mock('../../../../components/terminalViewport', () => ({ createTerminalViewport: createViewport }))
vi.mock('../../../../hooks/useInputCapabilities', () => ({ useInputCapabilities: () => ({ preferTouchUi: false }) }))
vi.mock('../../../../omp/toolInteraction', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../omp/toolInteraction')>(),
  issueToolInteractionTicket: () => new Promise(() => {}),
}))

const descriptor: ToolInteractionDescriptor = {
  protocolVersion: 1, sessionId: 'session', runtimeId: 'runtime', toolCallId: 'call', executionId: 'execution',
  status: 'running', command: 'read answer', cwd: '/repo', cols: 80, rows: 24, cursor: 0, oldestCursor: 0,
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ToolInteractionTerminal viewport hosts', () => {
  it('preserves the viewport and definite-height fullscreen ancestors when moving and reopening', async () => {
    createViewport.mockImplementation(() => ({
      fit, dispose, terminal: { textarea: document.createElement('textarea'), options: {}, focus: vi.fn() },
    }))
    const view = render(<FullscreenProvider><ToolInteractionTerminal descriptor={descriptor} serverId="server" /></FullscreenProvider>)
    const viewport = document.querySelector('[data-tool-terminal-viewport]')!
    const portal = viewport.parentElement!.parentElement!
    expect(viewport).toHaveClass('h-72')
    expect(createViewport).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
    const host = portal.parentElement!
    expect(host).toHaveClass('h-full', 'min-h-0', 'p-4', '[&>div]:h-full')
    expect(viewport).toHaveClass('flex-1', 'min-h-0')
    expect(viewport).not.toHaveClass('h-72')
    expect(createViewport).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }))
    expect(portal.parentElement).not.toBe(host)
    expect(portal.parentElement).toHaveClass('min-h-0')
    expect(viewport).toHaveClass('h-72')
    // Reopen while the previous modal is still closing, using a fresh host.
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
    expect(portal.parentElement).not.toBe(host)
    expect(portal.parentElement).toHaveClass('h-full', 'p-4', '[&>div]:h-full')
    await waitFor(() => expect(document.querySelector('[data-tool-terminal-viewport]')).toBe(viewport))
    expect(createViewport).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    view.unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
