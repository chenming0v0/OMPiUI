// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OmpSubagentTranscriptItem } from '../../../../omp/ompSubagentStore'
import { SubagentTranscriptPreview } from './SubagentTranscriptPreview'
import { formatToolName } from '../../../../utils/formatUtils'

function tool(toolName: string, timestamp: number, isError = false): OmpSubagentTranscriptItem {
  return { kind: 'tool', text: '', toolName, timestamp, isError }
}

describe('SubagentTranscriptPreview', () => {
  it('puts consecutive tools in one wrapping row without full-width item wrappers', () => {
    const { container } = render(
      <SubagentTranscriptPreview items={[tool('read', 1), tool('grep', 2), tool('bash', 3)]} isRunning={false} />,
    )

    const row = screen.getByTitle('read').parentElement!
    expect(container.children).toHaveLength(1)
    expect(row).toHaveClass('flex', 'flex-wrap', 'gap-1')
    expect(Array.from(row.children).map(node => node.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN'])
    expect(row).toHaveTextContent('ReadGrepBash')
  })

  it('keeps user and assistant messages between separate tool groups', () => {
    const { container } = render(
      <SubagentTranscriptPreview
        items={[
          tool('read', 1),
          tool('grep', 2),
          { kind: 'assistant', text: 'Reviewing the results', timestamp: 3 },
          tool('bash', 4),
          { kind: 'user', text: 'Check the tests too', timestamp: 5 },
          tool('edit', 6),
          tool('lsp', 7),
        ]}
        isRunning={false}
      />,
    )

    expect(Array.from(container.children).map(node => node.textContent)).toEqual([
      'ReadGrep',
      'Reviewing the resultsBash',
      'Check the tests too',
      'EditLsp',
    ])
    expect(container.children[2]).toHaveClass('justify-end')
  })

  it('preserves error styling and the full tool name in the tooltip', () => {
    const name = 'mcp__workspace__a_very_long_tool_name'
    render(<SubagentTranscriptPreview items={[tool(name, 1, true)]} isRunning={false} />)

    const badge = screen.getByTitle(name)
    expect(badge).toHaveClass('text-danger-100', 'max-w-full')
    expect(badge.textContent).toBe(`${formatToolName(name).slice(0, 30)}...`)
    expect(badge.firstElementChild).toHaveClass('truncate')
  })

  it('adds live tools to the same row and keeps trailing streamed text untruncated', () => {
    const items = [tool('read', 1), tool('grep', 2)]
    const { container, rerender } = render(<SubagentTranscriptPreview items={items} isRunning />)
    const row = container.firstElementChild
    const text = 'x'.repeat(600)

    rerender(
      <SubagentTranscriptPreview
        items={[...items, tool('bash', 3), { kind: 'assistant', text, timestamp: 4 }]}
        isRunning
      />,
    )
    expect(container.firstElementChild).toBe(row)
    expect(screen.getByTitle('bash').parentElement!.children).toHaveLength(3)
    expect(screen.getByText(text)).toBeInTheDocument()

    rerender(
      <SubagentTranscriptPreview
        items={[...items, tool('bash', 3), { kind: 'assistant', text, timestamp: 4 }]}
        isRunning={false}
      />,
    )
    expect(container.lastElementChild).toHaveTextContent(text)
  })

  it('keeps consecutive tool-only messages in one badge flow even when message ids differ', () => {
    const { container } = render(
      <SubagentTranscriptPreview
        items={[
          { kind: 'assistant', text: 'Inspecting the project', timestamp: 1, messageId: 'message-1' },
          { ...tool('read', 2), messageId: 'message-1' },
          { ...tool('grep', 3), messageId: 'message-1' },
          { ...tool('bash', 4), messageId: 'message-2' },
          { ...tool('lsp', 5), messageId: 'message-3' },
        ]}
        isRunning
      />,
    )
    expect(Array.from(container.children).map(node => node.textContent)).toEqual([
      'Inspecting the projectReadGrepBashLsp',
    ])
    expect(screen.getByTitle('read').parentElement).toBe(screen.getByTitle('lsp').parentElement)
    expect(container.firstElementChild).toHaveClass('space-y-1.5')
  })

  it('does not drop the initial user preview when more than twenty message groups exist', () => {
    const items: OmpSubagentTranscriptItem[] = [
      { kind: 'user', text: 'Initial assignment preview', timestamp: 0, messageId: 'assignment' },
      ...Array.from({ length: 25 }, (_, index): OmpSubagentTranscriptItem => ({
        kind: 'assistant',
        text: `Summary ${index}`,
        timestamp: index + 1,
        messageId: `message-${index}`,
      })),
    ]
    const { container } = render(<SubagentTranscriptPreview items={items} isRunning={false} />)
    expect(screen.getByText('Initial assignment preview')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('justify-end')
    expect(screen.getByText('Summary 24')).toBeInTheDocument()
  })

  it('shows a running indicator and readable title, then settles the same badge', () => {
    const item = {
      ...tool('read', 1),
      toolCallId: 'call-1',
      toolTitle: 'Read package.json',
      toolStatus: 'running' as const,
    }
    const { rerender } = render(<SubagentTranscriptPreview items={[item]} isRunning />)
    const badge = screen.getByTitle('Read package.json')
    expect(badge).toHaveTextContent('Read package.json')
    expect(badge).toHaveClass('text-accent-main-100')
    expect(badge.querySelector('.animate-pulse')).not.toBeNull()
    rerender(<SubagentTranscriptPreview items={[{ ...item, toolStatus: 'error', isError: true }]} isRunning />)
    expect(screen.getByTitle('Read package.json')).toBe(badge)
    expect(badge).toHaveClass('text-danger-100')
    expect(badge.querySelector('.animate-pulse')).toBeNull()
  })

  it('truncates old assistant text from its beginning while keeping users and the final reply complete', () => {
    const old = `${'a'.repeat(500)}OLD_END`
    const user = 'u'.repeat(600)
    const final = 'f'.repeat(600)
    render(
      <SubagentTranscriptPreview
        items={[
          { kind: 'assistant', text: old, timestamp: 1 },
          { kind: 'user', text: user, timestamp: 2 },
          { kind: 'assistant', text: final, timestamp: 3 },
        ]}
        isRunning={false}
      />,
    )
    expect(screen.getByText(`${old.slice(0, 500)}...`)).toBeInTheDocument()
    expect(screen.queryByText(/OLD_END/)).not.toBeInTheDocument()
    expect(screen.getByText(user)).toBeInTheDocument()
    expect(screen.getByText(final)).toBeInTheDocument()
  })

  it('leaves an empty transcript empty so the parent can show its waiting state', () => {
    const { container } = render(<SubagentTranscriptPreview items={[]} isRunning />)
    expect(container).toBeEmptyDOMElement()
  })
})
