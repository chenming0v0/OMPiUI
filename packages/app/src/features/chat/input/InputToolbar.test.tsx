import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputToolbar } from './InputToolbar'

const useIsMobileMock = vi.fn()
const isTauriMock = vi.fn()
const isTauriMobileMock = vi.fn()
const openMock = vi.fn()
const readFileMock = vi.fn()

vi.mock('../../../hooks', () => ({
  useIsMobile: () => useIsMobileMock(),
}))

vi.mock('../chatViewport', () => ({
  useChatViewport: () => ({
    presentation: { surfaceVariant: 'desktop', isCompact: false },
    interaction: {
      mode: 'pointer',
      touchCapable: false,
      sidebarBehavior: 'docked',
      rightPanelBehavior: 'docked',
      bottomPanelBehavior: 'docked',
      outlineInteraction: 'pointer',
      enableCollapsedInputDock: false,
    },
  }),
  useChatViewportSelect: <S,>(selector: (value: unknown) => S) =>
    selector({
      presentation: { surfaceVariant: 'desktop', isCompact: false },
      interaction: { mode: 'pointer', touchCapable: false, sidebarBehavior: 'docked', rightPanelBehavior: 'docked', bottomPanelBehavior: 'docked', outlineInteraction: 'pointer', enableCollapsedInputDock: false },
    }),}))

vi.mock('../../../utils/tauri', () => ({
  isTauri: () => isTauriMock(),
  isTauriMobile: () => isTauriMobileMock(),
  extToMime: (ext: string) => {
    if (ext === 'png') return 'image/png'
    return 'application/octet-stream'
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}))

vi.mock('../../../components/ui', () => ({
  DropdownMenu: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  MenuItem: ({
    label,
    onClick,
    selectionRole,
    selected,
  }: {
    label: string
    onClick: () => void
    selectionRole?: 'menuitemradio' | 'option'
    selected?: boolean
  }) => {
    const selectionProps =
      selectionRole === 'menuitemradio'
        ? { role: selectionRole, 'aria-checked': selected, tabIndex: selected ? 0 : -1 }
        : selectionRole === 'option'
          ? { role: selectionRole, 'aria-selected': selected, tabIndex: selected ? 0 : -1 }
          : {}

    return (
      <button type="button" onClick={onClick} {...selectionProps}>
        {label}
      </button>
    )
  },
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AnimatedPresence: ({ show, children }: { show: boolean; children: React.ReactNode }) =>
    show ? <>{children}</> : null,
}))

vi.mock('../ModelSelector', () => ({
  ModelSelector: () => null,
}))

describe('InputToolbar file selection', () => {
  beforeEach(() => {
    useIsMobileMock.mockReturnValue(false)
    isTauriMock.mockReturnValue(false)
    isTauriMobileMock.mockReturnValue(false)
    openMock.mockReset()
    readFileMock.mockReset()
  })

  it('uses the browser file input on Tauri mobile', () => {
    useIsMobileMock.mockReturnValue(true)
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(true)

    const onFilesSelected = vi.fn()
    const inputClickSpy = vi.spyOn(HTMLInputElement.prototype, 'click')

    const { container } = render(
      <InputToolbar
        fileCapabilities={{ image: true, pdf: false, audio: false, video: false }}
        onFilesSelected={onFilesSelected}
        canSend={false}
        onSend={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    expect(inputClickSpy).toHaveBeenCalledTimes(1)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(onFilesSelected).toHaveBeenCalledWith([file])
    inputClickSpy.mockRestore()
  })

  it('uses the Tauri native picker on desktop', async () => {
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(false)
    openMock.mockResolvedValue(['/tmp/photo.png'])
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]))

    const onFilesSelected = vi.fn()

    render(
      <InputToolbar
        fileCapabilities={{ image: true, pdf: false, audio: false, video: false }}
        onFilesSelected={onFilesSelected}
        canSend={false}
        onSend={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledTimes(1)
      expect(readFileMock).toHaveBeenCalledWith('/tmp/photo.png')
      expect(onFilesSelected).toHaveBeenCalledTimes(1)
    })

    const [files] = onFilesSelected.mock.calls[0] as [File[]]
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('photo.png')
    expect(files[0].type).toBe('image/png')
  })

  it('toggles the delivery mode inside the composer while streaming', () => {
    const onDeliveryModeChange = vi.fn()
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        isStreaming
        deliveryMode="followUp"
        onDeliveryModeChange={onDeliveryModeChange}
        canSteer
        canFollowUp
        canSend
        onSend={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Running message timing: Follow-up' })
    expect(trigger).toHaveAttribute('title', 'Send this message as the next turn after the current response finishes')
    fireEvent.click(trigger)
    expect(onDeliveryModeChange).toHaveBeenCalledWith('steer')
  })

  it('cycles through abort-and-prompt when the native command is advertised (#360)', () => {
    const onDeliveryModeChange = vi.fn()
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        isStreaming
        deliveryMode="followUp"
        onDeliveryModeChange={onDeliveryModeChange}
        canSteer
        canFollowUp
        canInterruptAndPrompt
        canSend
        onSend={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Running message timing: Follow-up' })
    fireEvent.click(trigger)
    expect(onDeliveryModeChange).toHaveBeenLastCalledWith('steer')
  })

  it('offers interrupt-and-prompt even without steer/follow-up capabilities', () => {
    const onDeliveryModeChange = vi.fn()
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        isStreaming
        deliveryMode="abortAndPrompt"
        onDeliveryModeChange={onDeliveryModeChange}
        canInterruptAndPrompt
        canSend
        onSend={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Running message timing: Interrupt & prompt' })
    expect(trigger).toHaveAttribute('title', 'Abort the current work and immediately start a new turn with this message')
    fireEvent.click(trigger)
    expect(onDeliveryModeChange).toHaveBeenCalledWith('abortAndPrompt')
  })

  it('shows Stop while session is active and the input is empty', () => {
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        sessionActive
        canSend={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /stop|停止/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send|发送/i })).toBeNull()
  })

  it.each([
    { isStreaming: true },
    { sessionActive: true },
    { isCompacting: true },
  ])('uses one action slot through draft and submission transitions: %j', activity => {
    const props = { onFilesSelected: vi.fn(), onSend: vi.fn(), onAbort: vi.fn() }
    const view = render(<InputToolbar {...props} {...activity} canSend={false} />)
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()

    view.rerender(<InputToolbar {...props} {...activity} canSend />)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull()

    view.rerender(<InputToolbar {...props} {...activity} canSend isSending />)
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Sending message…' })).toBeNull()

    view.rerender(<InputToolbar {...props} {...activity} canSend={false} />)
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()

    view.rerender(<InputToolbar {...props} canSend={false} />)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull()
  })

  it('shows Stop while compacting and the input is empty', () => {
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        isCompacting
        canSend={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /stop|停止/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send|发送/i })).toBeNull()
  })

  it('keeps Stop clickable while Send is awaiting acceptance', () => {
    const onAbort = vi.fn()
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        isStreaming
        isSending
        canSend
        onSend={vi.fn()}
        onAbort={onAbort}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /stop|停止/i }))
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('shows an in-progress stop state and prevents duplicate stop clicks', () => {
    const onAbort = vi.fn()
    render(
      <InputToolbar
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
        isStopping
        canSend
        onSend={vi.fn()}
        onAbort={onAbort}
      />,
    )

    const stop = screen.getByRole('button', { name: /stop|停止/i })
    expect(stop).toBeDisabled()
    fireEvent.click(stop)
    expect(onAbort).not.toHaveBeenCalled()
  })
})
