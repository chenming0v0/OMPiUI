// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNavigationContext } from '../../../../contexts/SessionNavigationContext'
import { piSessionStateStore } from '../../../../omp/state/index.js'
import { ompSubagentStore } from '../../../../omp/ompSubagentStore'
import type { JsonObject } from '@ompiui/protocol'
import type { PiToolExecution } from '../../../../omp/domain/index.js'
import type { ExtractedToolData } from '../types'
import { buildPersistedSubagentRun, deriveChildSessionFile } from './persistedSubagentRun'
import { TaskHeader, TaskRenderer } from './TaskRenderer'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const getOmpSubagentMessagesMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../omp/transport/index.js', () => ({
  getOmpSubagentMessages: getOmpSubagentMessagesMock,
}))
const openSubagentSessionMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../omp/controllers/index.js', () => ({
  openSubagentSession: openSubagentSessionMock,
  abortPiOperation: vi.fn(),
}))

vi.mock('../../../../utils/uiDisclosureState', () => ({
  useUiDisclosureState: () => [true, vi.fn()],
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

function renderHeader(options: { sessionId?: string } = { sessionId: 'child-session' }) {
  const sessionId = options.sessionId
  const navigateToSession = vi.fn()
  const onToggle = vi.fn()

  render(
    <SessionNavigationContext.Provider
      value={{ navigateToSession, currentSessionId: 'parent-session', currentDirectory: 'E:\\workspace' }}
    >
      <TaskHeader
        agentType="explore"
        description="Inspect the renderer"
        status="completed"
        expanded={false}
        onToggle={onToggle}
        sessionId={sessionId}
      />
    </SessionNavigationContext.Provider>,
  )

  return { navigateToSession, onToggle }
}

describe('TaskHeader', () => {
  it('opens the child session from the jump button', () => {
    const { navigateToSession, onToggle } = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('also opens the child session from the agent badge', () => {
    const { navigateToSession, onToggle } = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: 'explore' }))

    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('uses the title and its remaining row space to toggle details', () => {
    const { navigateToSession, onToggle } = renderHeader()
    const titleButton = screen.getByRole('button', { name: /Inspect the renderer/ })

    expect(titleButton).toHaveClass('flex-1')
    fireEvent.click(titleButton)

    expect(onToggle).toHaveBeenCalledOnce()
    expect(navigateToSession).not.toHaveBeenCalled()
  })

  it('hides the jump button until a child session exists', () => {
    const { onToggle } = renderHeader({ sessionId: undefined })

    expect(screen.queryByRole('button', { name: 'task.openSession' })).not.toBeInTheDocument()
    expect(screen.getByText('explore').tagName).toBe('SPAN')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('keeps navigation independent from disclosure when onOpenSession is provided', () => {
    const onOpenSession = vi.fn()
    const onToggle = vi.fn()
    render(<TaskHeader agentType="scout" description="Read the project" status="completed" expanded={false} onToggle={onToggle} onOpenSession={onOpenSession} />)
    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))
    fireEvent.click(screen.getByRole('button', { name: 'scout' }))
    expect(onOpenSession).toHaveBeenCalledTimes(2)
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Read the project' }))
    expect(onToggle).toHaveBeenCalledOnce()
    expect(onOpenSession).toHaveBeenCalledTimes(2)
  })
})

// ============================================
// 落盘回退：注册表为空时从持久化 result.details 重建 run，
// 转录从子会话文件（subagent.messages 磁盘兜底）读回
// ============================================

const noopData: ExtractedToolData = {}

function completedTaskExecution(): PiToolExecution {
  return {
    call: {
      type: 'toolCall',
      id: 'call-task-1',
      name: 'task',
      arguments: { agent: 'scout', task: '读 README' },
    },
    result: {
      role: 'toolResult',
      toolCallId: 'call-task-1',
      toolName: 'task',
      content: [{ type: 'text', text: 'done' }],
      isError: false,
      timestamp: 1_791_000_000_000,
      details: {
        results: [{
          index: 0,
          id: 'ReadmeScout',
          agent: 'scout',
          description: 'Summarize the project from README.md',
          exitCode: 0,
          outputPath: 'C:\\sessions\\proj\\2026-parent\\ReadmeScout.md',
        }],
      },
    },
  }
}

function renderTask(execution: PiToolExecution, navigateToSession = vi.fn()) {
  return render(
    <SessionNavigationContext.Provider
      value={{ navigateToSession, currentSessionId: 'parent-session', currentDirectory: 'C:\\proj' }}
    >
      <TaskRenderer execution={execution} partKey="p1" data={noopData} onFullscreenChange={vi.fn()} />
    </SessionNavigationContext.Provider>,
  )
}

describe('persisted subagent fallback', () => {
  beforeEach(() => {
    getOmpSubagentMessagesMock.mockReset()
    piSessionStateStore.clearAll()
    ompSubagentStore.clearAll()
    openSubagentSessionMock.mockReset()
  })

  it('derives the child session file from outputPath / parent session file', () => {
    expect(deriveChildSessionFile({ id: 'ReadmeScout', outputPath: 'C:\\dir\\sub\\ReadmeScout.md' }))
      .toBe('C:\\dir\\sub/ReadmeScout.jsonl')
    expect(deriveChildSessionFile({ id: 'ReadmeScout' }, 'C:\\sessions\\proj\\parent.jsonl'))
      .toBe('C:\\sessions\\proj\\parent/ReadmeScout.jsonl')
    expect(deriveChildSessionFile({})).toBeUndefined()
  })

  it('builds a completed read-only run from the persisted result', () => {
    const run = buildPersistedSubagentRun('call-1', { id: 'ReadmeScout', agent: 'scout', exitCode: 0 }, 'C:/x.jsonl', 'parent-session')
    expect(run).toMatchObject({
      parentToolCallId: 'call-1',
      agent: 'scout',
      status: 'completed',
      sessionFile: 'C:/x.jsonl',
      historyLoaded: true,
      detached: false,
      sessionId: 'parent-session',
    })
    const aborted = buildPersistedSubagentRun('call-1', { id: 'a', aborted: true }, undefined, 'parent-session')
    expect(aborted?.status).toBe('aborted')
    expect(buildPersistedSubagentRun('call-1', {}, undefined, 'parent-session')).toBeUndefined()
  })

  it('shows the disk transcript instead of the waiting placeholder after reopen', async () => {
    piSessionStateStore.setState('parent-session', {
      sessionFile: 'C:\\sessions\\proj\\2026-parent.jsonl',
    } as JsonObject)
    getOmpSubagentMessagesMock.mockResolvedValue({
      messages: [
        { role: 'user', content: 'Complete assignment thoroughly' },
        { role: 'assistant', content: [{ type: 'text', text: 'OMPiUI 摘要文本' }] },
      ],
    })

    renderTask(completedTaskExecution())

    // 转录从磁盘回填：占位符消失，子会话内容可见
    await waitFor(() => {
      expect(screen.queryByText('task.waitingForResponse')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('OMPiUI 摘要文本')).toBeInTheDocument()
    expect(getOmpSubagentMessagesMock).toHaveBeenCalledWith(
      'parent-session',
      { sessionFile: 'C:\\sessions\\proj\\2026-parent/ReadmeScout.jsonl' },
    )
    expect(screen.getByRole('button', { name: 'scout' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ReadmeScout · Summarize the project from README.md' })).toBeInTheDocument()
  })

  it('maps out-of-order persisted siblings to their own names, transcripts and destinations', async () => {
    const execution = completedTaskExecution()
    execution.call.arguments = { tasks: [
      { name: 'ReadmeScout', agent: 'scout', task: 'Read README' },
      { name: 'SecurityReview', agent: 'reviewer', task: 'Review security' },
    ] }
    execution.result!.details = { results: [
      { index: 1, id: 'SecurityReview', agent: 'reviewer', outputPath: 'C:/sessions/parent/SecurityReview.md', exitCode: 0 },
      { index: 0, id: 'ReadmeScout', agent: 'scout', outputPath: 'C:/sessions/parent/ReadmeScout.md', exitCode: 0 },
    ] }
    getOmpSubagentMessagesMock.mockImplementation((_parent, { sessionFile }) => Promise.resolve({ messages: [
      { role: 'assistant', content: [{ type: 'text', text: sessionFile.includes('ReadmeScout') ? 'README findings' : 'Security findings' }] },
    ] }))
    openSubagentSessionMock.mockImplementation((_directory, file) => Promise.resolve({
      id: file.includes('ReadmeScout') ? 'child-readme' : 'child-security',
      directory: 'C:\\proj',
    }))
    const navigate = vi.fn()
    renderTask(execution, navigate)
    expect(screen.getByRole('button', { name: 'ReadmeScout' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'SecurityReview' })).toBeInTheDocument()
    expect(await screen.findByText('README findings')).toBeInTheDocument()
    expect(await screen.findByText('Security findings')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'scout' }))
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('child-readme', 'C:\\proj'))
    fireEvent.click(screen.getAllByRole('button', { name: 'task.openSession' })[1])
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('child-security', 'C:\\proj'))
  })

  it('never assigns the only live run to its not-yet-started sibling', () => {
    ompSubagentStore.applyLifecycle('parent-session', { id: 'first', parentToolCallId: 'batch-live', index: 0, agent: 'scout', status: 'started', sessionFile: 'C:/sessions/parent/first.jsonl' })
    getOmpSubagentMessagesMock.mockResolvedValue({ messages: [] })
    renderTask({ call: { type: 'toolCall', id: 'batch-live', name: 'task', arguments: { tasks: [
      { name: 'First', agent: 'scout', task: 'Read first' }, { name: 'Second', agent: 'reviewer', task: 'Review second' },
    ] } } })
    expect(screen.getByRole('button', { name: 'scout' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'reviewer' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'task.openSession' })).toHaveLength(1)
  })

  it('does not put the wrapping assignment prompt in the task title', () => {
    getOmpSubagentMessagesMock.mockResolvedValue({ messages: [] })
    ompSubagentStore.applyLifecycle('parent-session', {
      id: 'ReadmeScout',
      parentToolCallId: 'call-wrap',
      index: 0,
      agent: 'scout',
      status: 'started',
      sessionFile: 'C:/sessions/parent/ReadmeScout.jsonl',
      description: 'Complete assignment thoroughly:\n\n# Target',
    })
    renderTask({
      call: {
        type: 'toolCall',
        id: 'call-wrap',
        name: 'task',
        arguments: {
          tasks: [{ name: 'ReadmeScout', agent: 'scout', task: 'Complete assignment thoroughly:\n\n# Target' }],
        },
      },
    })
    expect(screen.getByRole('button', { name: 'ReadmeScout' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Complete assignment thoroughly/ })).not.toBeInTheDocument()
  })

  it('shows an opening failure instead of a silent no-op', async () => {
    getOmpSubagentMessagesMock.mockResolvedValue({ messages: [] })
    openSubagentSessionMock.mockRejectedValue(new Error('Child transcript is missing'))
    const navigate = vi.fn()
    renderTask(completedTaskExecution(), navigate)
    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Child transcript is missing')
    expect(navigate).not.toHaveBeenCalled()
  })


  it('keeps the waiting placeholder when nothing is persisted', () => {
    renderTask({
      call: { type: 'toolCall', id: 'call-2', name: 'task', arguments: {} },
      result: {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'task',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        timestamp: 1_791_000_000_000,
      },
    })
    expect(screen.getByText('task.waitingForResponse')).toBeInTheDocument()
  })
})
