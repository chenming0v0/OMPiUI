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

    expect(extracted.yieldResult).toEqual({ status: 'success', data: { reply: 'pong' } })
    expect(extracted.input).toBeUndefined()
    expect(extracted.output).toBeUndefined()
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

  it('shows a completion line when no payload is present', () => {
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
    const execution = yieldExecution({ result: undefined })
    render(<YieldRenderer execution={execution} partKey="p1" data={yieldExtractData(execution)} />)

    expect(screen.getByText('yield.submitting')).toBeInTheDocument()
  })
})
