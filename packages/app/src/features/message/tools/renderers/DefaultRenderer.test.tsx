// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultRenderer } from './DefaultRenderer'
import { liveToolOutputStore } from '../../../../omp/liveToolOutput'
import type { ExtractedToolData } from '../types'
import type { PiToolExecution } from '../../../../omp/domain/index.js'
import { themeStore } from '../../../../store/themeStore'
let previousCardStyle = themeStore.toolCardStyle

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../../../contexts', () => ({
  useFullscreen: () => ({
    activeId: null,
    openFullscreen: vi.fn(),
    updateFullscreen: vi.fn(),
    closeFullscreen: vi.fn(),
  }),
  useFullscreenLayer: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
}))



function runningEditExecution(toolCallId = 'call-edit'): PiToolExecution {
  return {
    call: {
      type: 'toolCall',
      id: toolCallId,
      name: 'edit',
      arguments: { filePath: 'src/app.ts', oldString: 'a', newString: 'b' },
    },
    result: undefined,
    startedAt: 7_500,
  }
}

function renderDefault(execution: PiToolExecution, data: ExtractedToolData) {
  return render(
    <DefaultRenderer
      execution={execution}
      partKey="p1"
      data={data}
      onFullscreenChange={vi.fn()}
    />,
  )
}

describe('DefaultRenderer', () => {
  beforeEach(() => {
    previousCardStyle = themeStore.toolCardStyle
    liveToolOutputStore.clearAll()
    themeStore.setToolCardStyle('classic')
  })
  afterEach(() => themeStore.setToolCardStyle(previousCardStyle))
  it('does not create a loading output block for a queued tool', () => {
    const queued = { ...runningEditExecution(), startedAt: undefined }
    const { container, rerender } = renderDefault(queued, { input: '{"filePath":"src/app.ts"}' })
    expect(screen.queryByText('defaultRenderer.output')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeNull()
    rerender(<DefaultRenderer execution={{ ...queued, startedAt: 7_500 }} partKey="p1" data={{ input: '{"filePath":"src/app.ts"}' }} />)
    expect(screen.getByText('defaultRenderer.output')).toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('streams live tool output for non-bash tools while running', async () => {
    renderDefault(runningEditExecution(), { input: '{"filePath":"src/app.ts"}' })

    act(() => {
      liveToolOutputStore.set('call-edit', 'session-1', 'editing src/app.ts...')
    })

    expect(await screen.findByText('editing src/app.ts...')).toBeInTheDocument()
  })

  it('retains received partial output beside the exit reason without a fabricated result', async () => {
    const execution = { ...runningEditExecution(), isRunning: false, error: 'Runtime exited with code 23 before returning', endedAt: 10_000 }
    liveToolOutputStore.set(execution.call.id, 'session-1', 'Last real output before exit')
    const { container } = renderDefault(execution, { error: execution.error })
    expect(await screen.findByText(execution.error)).toBeInTheDocument()
    expect(await screen.findByText('Last real output before exit')).toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('prefers the persisted result output once the tool completes', async () => {
    renderDefault(runningEditExecution(), { output: 'final result', filePath: 'src/app.ts' })
    act(() => {
      liveToolOutputStore.set('call-edit', 'session-1', 'stale live text')
    })
    expect(await screen.findByText('final result')).toBeInTheDocument()
    expect(screen.queryByText('stale live text')).not.toBeInTheDocument()
  })
})
