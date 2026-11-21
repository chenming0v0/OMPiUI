// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNavigationContext } from '../../../../contexts/SessionNavigationContext'
import { FullOutputControl } from './FullOutputControl'

const { postPiSessionCommand } = vi.hoisted(() => ({ postPiSessionCommand: vi.fn() }))

vi.mock('../../../../omp/transport', () => ({ postPiSessionCommand }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function renderControl() {
  return render(
    <SessionNavigationContext.Provider value={{ currentSessionId: 'session-1', currentDirectory: '/work', navigateToSession: vi.fn() }}>
      <FullOutputControl artifactId="3" />
    </SessionNavigationContext.Provider>,
  )
}

describe('FullOutputControl', () => {
  beforeEach(() => postPiSessionCommand.mockReset())

  it('loads output only on click and renders the complete artifact', async () => {
    postPiSessionCommand.mockResolvedValue({
      data: 'first line\nsecond line', nextOffset: 22, totalBytes: 22, hasMore: false, revision: '22:1',
    })
    renderControl()

    expect(postPiSessionCommand).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'truncation.expandFullOutput' }))
    const output = await screen.findByText((_text, element) => element?.tagName === 'PRE')
    expect(output.textContent).toBe('first line\nsecond line')
    expect(postPiSessionCommand).toHaveBeenCalledWith(
      'session-1', 'toolOutput.get', { artifactId: '3', offset: 0 }, expect.any(AbortSignal), 30_000,
    )
  })
})
