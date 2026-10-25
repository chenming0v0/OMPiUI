// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { YieldRenderer } from './YieldRenderer'
import { yieldExtractData } from '../registry'
import type { PiToolExecution } from '../../../../omp/domain/index.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue !== undefined ? String(opts.defaultValue) : key) }),
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

function yieldExecution(overrides?: Partial<PiToolExecution>): PiToolExecution {
  return {
    call: {
      type: 'toolCall',
      id: 'call-yield',
      name: 'yield',
      arguments: { data: { reply: 'pong' } },
    },
    result: {
      role: 'toolResult',
      toolCallId: 'call-yield',
      toolName: 'yield',
      content: [{ type: 'text', text: 'Result submitted.' }],
      isError: false,
      timestamp: 0,
      details: { status: 'success', data: { reply: 'pong' } },
    },
    ...overrides,
  }
}

describe('yieldExtractData', () => {
  it('extracts the submitted payload from result details and drops generic blocks', () => {
    const extracted = yieldExtractData(yieldExecution())

    // #364: 结果文本里负载之外的原始说明保留为 rawOutput，不再随结构化负载一起删除。
    expect(extracted.yieldResult).toEqual({ status: 'success', data: { reply: 'pong' }, rawOutput: 'Result submitted.' })
    expect(extracted.input).toBeUndefined()
    expect(extracted.output).toBeUndefined()
  })

  it('retains matching payload text for the raw reading and copy entry', () => {
    const extracted = yieldExtractData(yieldExecution({
      result: {
        role: 'toolResult',
        toolCallId: 'call-yield',
        toolName: 'yield',
        content: [{ type: 'text', text: 'pong' }],
        isError: false,
        timestamp: 0,
        details: { status: 'success', data: { reply: 'pong' } },
      },
    }))

    expect(extracted.yieldResult).toEqual({ status: 'success', data: { reply: 'pong' }, rawOutput: 'pong' })
  })

  it('marks failed yields and keeps the error text', () => {
    const extracted = yieldExtractData(
      yieldExecution({
        result: {
          role: 'toolResult',
          toolCallId: 'call-yield',
          toolName: 'yield',
          content: [{ type: 'text', text: 'yield used the last assistant turn as the result...' }],
          isError: true,
          timestamp: 0,
          details: {},
        },
      }),
    )

    expect(extracted.yieldResult?.status).toBe('error')
    expect(extracted.yieldResult?.error).toBe('yield used the last assistant turn as the result...')
  })
})

describe('YieldRenderer', () => {
  it('renders the structured payload as a labeled result card', () => {
    const execution = yieldExecution({
      result: {
        role: 'toolResult',
        toolCallId: 'call-yield',
        toolName: 'yield',
        content: [{ type: 'text', text: 'Result submitted.' }],
        isError: false,
        timestamp: 0,
        details: {
          status: 'success',
          data: {
            summary: 'OMPiUI 是一个基于 PiUI 的第三方客户端。',
            files: [{ path: 'C:/work/demo/README.md', description: '项目的主要文档' }],
          },
        },
      },
    })
    const { container } = render(<YieldRenderer execution={execution} partKey="p1" data={yieldExtractData(execution)} />)

    // 字段成段、文件行显示文件名 + 描述，而不是原始 JSON 文本
    expect(container.textContent).toContain('OMPiUI 是一个基于 PiUI 的第三方客户端。')
    expect(container.textContent).toContain('README.md')
    expect(container.textContent).toContain('项目的主要文档')
    expect(container.textContent).not.toContain('"summary"')
  })

  it('shows the submitted result payload when completed', () => {
    const { container } = render(<YieldRenderer execution={yieldExecution()} partKey="p1" data={yieldExtractData(yieldExecution())} />)

    expect(container.textContent).toMatch(/reply/i)
    expect(container.textContent).toContain('pong')
    expect(container.textContent).not.toContain('"reply"')
  })

  it('shows the raw result text when no payload is present (#364)', () => {
    const execution = yieldExecution({
      call: {
        type: 'toolCall',
        id: 'call-yield',
        name: 'yield',
        arguments: {},
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-yield',
        toolName: 'yield',
        content: [{ type: 'text', text: 'Result submitted.' }],
        isError: false,
        timestamp: 0,
        details: { status: 'success' },
      },
    })
    const { container } = render(<YieldRenderer execution={execution} partKey="p1" data={yieldExtractData(execution)} />)

    // 原始结果文本就是全部证据，不能只剩一个“已完成”标记
    expect(container.textContent).toContain('Result submitted.')
    expect(screen.getByText('yield.rawOutput')).toBeInTheDocument()
  })

  it('shows a completion line when no payload and no raw text is present', () => {
    const execution = yieldExecution({
      call: {
        type: 'toolCall',
        id: 'call-yield',
        name: 'yield',
        arguments: {},
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-yield',
        toolName: 'yield',
        content: [{ type: 'text', text: '' }],
        isError: false,
        timestamp: 0,
        details: { status: 'success' },
      },
    })
    render(<YieldRenderer execution={execution} partKey="p1" data={yieldExtractData(execution)} />)

    expect(screen.getByText('yield.completed')).toBeInTheDocument()
  })

  it('shows the error block for failed submissions', () => {
    const execution = yieldExecution({
      result: {
        role: 'toolResult',
        toolCallId: 'call-yield',
        toolName: 'yield',
        content: [{ type: 'text', text: 'Put your result in `data`.' }],
        isError: true,
        timestamp: 0,
        details: {},
      },
    })
    render(<YieldRenderer execution={execution} partKey="p1" data={yieldExtractData(execution)} />)

    expect(screen.getByText('yield.failed')).toBeInTheDocument()
  })

  it('shows a submitting line while running', () => {
    const execution = yieldExecution({ result: undefined, startedAt: 7_500 })
    render(<YieldRenderer execution={execution} partKey="p1" data={yieldExtractData(execution)} />)

    expect(screen.getByText('yield.submitting')).toBeInTheDocument()
  })
  it('does not submit or spin before the yield call starts', () => {
    const execution = yieldExecution({ result: undefined })
    const { container } = render(<YieldRenderer execution={execution} partKey="queued-yield" data={yieldExtractData(execution)} />)
    expect(screen.getByText('toolPart.pending')).toBeInTheDocument()
    expect(screen.queryByText('yield.submitting')).not.toBeInTheDocument()
    expect(screen.queryByText('yield.completed')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
