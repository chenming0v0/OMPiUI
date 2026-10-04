// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNavigationContext } from '../../../../contexts/SessionNavigationContext'
import { piSessionStateStore } from '../../../../omp/state/index.js'
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

function renderTask(execution: PiToolExecution) {
  return render(
    <SessionNavigationContext.Provider
      value={{ navigateToSession: vi.fn(), currentSessionId: 'parent-session', currentDirectory: 'C:\\proj' }}
    >
      <TaskRenderer execution={execution} partKey="p1" data={noopData} onFullscreenChange={vi.fn()} />
    </SessionNavigationContext.Provider>,
  )
}

describe('persisted subagent fallback', () => {
  beforeEach(() => {
    getOmpSubagentMessagesMock.mockReset()
    piSessionStateStore.clearAll()
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
    // sessionFile 从 outputPath 同目录推导
    expect(getOmpSubagentMessagesMock).toHaveBeenCalledWith(
      'parent-session',
      { sessionFile: 'C:\\sessions\\proj\\2026-parent/ReadmeScout.jsonl' },
    )
    // 状态行显示 agent 名（completed 绿点由样式类承载）；header 徽章也用同名
    expect(screen.getAllByText('scout').length).toBeGreaterThanOrEqual(1)
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
