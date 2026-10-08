import { Fragment } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import type { PiAssistantMessageItem, PiTimelineItem, PiUserMessageItem } from '../../omp/domain/index.js'
import { buildProcessTimeline } from '../chat/chatPageModel'
import { buildVisibleTimelineEntries } from '../chat/chatAreaVisibility'
import { MessageRenderer, ProcessCollapseBlock, assistantHasFinalContent, assistantHasProcessContent } from './MessageRenderer'

function assistant(id: string, blocks: PiAssistantMessageItem['blocks'], stopReason: 'error' | 'aborted' | 'stop'): PiAssistantMessageItem {
  const message: PiAssistantMessageItem['message'] = {
    role: 'assistant', content: blocks, api: 'anthropic-messages', provider: 'anthropic', model: 'model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 200,
  }
  return {
    kind: 'assistant_message', entryId: id, timestamp: 100, message, blocks, toolResults: {},
    rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(100).toISOString(), message },
  }
}

function user(id: string): PiUserMessageItem {
  const message = { role: 'user' as const, content: 'Run the task', timestamp: 1 }
  return {
    kind: 'user_message', entryId: id, timestamp: 1, message, blocks: [{ type: 'text', text: message.content }],
    rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(1).toISOString(), message },
  }
}

// Exercise the production model and shell/message components without the
// viewport virtualizer: JSDOM cannot measure physical row positions.
function ProcessTimeline({ items, stateKey }: { items: PiTimelineItem[]; stateKey: string }) {
  const visibleItems = buildVisibleTimelineEntries(items).map(entry => entry.item)
  const timeline = buildProcessTimeline(visibleItems, {
    turnDurationMap: new Map(), sessionIsStreaming: false,
    messageHasProcess: assistantHasProcessContent, messageHasFinal: assistantHasFinalContent,
  })
  return <>{timeline.map(row => row.kind === 'message'
    ? <MessageRenderer key={row.key} item={row.item} processContentScope={row.processContentScope} />
    : <Fragment key={row.key}>
        <div data-testid="process-shell">
          <ProcessCollapseBlock stateKey={stateKey} isActive={row.isActive} durationMs={row.durationMs}>
            {row.children.map(child => <div key={child.item.entryId} data-testid="process-child">
              <MessageRenderer item={child.item} processContentScope={child.processContentScope} />
            </div>)}
          </ProcessCollapseBlock>
        </div>
        {row.finalItem && <MessageRenderer item={row.finalItem} processContentScope="final" />}
      </Fragment>,
  )}</>
}

const processBlocks: Array<{ name: string; blocks: PiAssistantMessageItem['blocks'] }> = [
  { name: 'thinking', blocks: [{ type: 'thinking', thinking: 'Checking the task' }] },
  { name: 'tool', blocks: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'README.md' } }] },
]

describe.each(['error', 'aborted'] as const)('process-only %s indication', stopReason => {
  const title = () => i18n.t(stopReason === 'error' ? 'errors.unknownError' : 'errors.messageAborted', { ns: 'message' })

  it.each(processBlocks)('keeps exactly one accessible $name failure outside a collapsed or expanded process', async ({ name, blocks }) => {
    const id = `${stopReason}-${name}`
    const failed = assistant(id, blocks, stopReason)
    failed.message.errorMessage = 'The request did not finish.'
    expect(assistantHasProcessContent(failed)).toBe(true)
    expect(assistantHasFinalContent(failed)).toBe(true)
    render(<ProcessTimeline items={[user(`user-${id}`), failed]} stateKey={`test:${id}`} />)

    const shell = screen.getByTestId('process-shell')
    const toggle = within(shell).getByRole('button', { expanded: false })
    expect(within(shell).queryByTestId('process-child')).toBeNull()
    const indication = screen.getByRole('button', { name: title() })
    expect(indication).toBeVisible()
    expect(screen.getByRole('status')).toContainElement(indication)
    expect(shell.contains(indication)).toBe(false)
    expect(screen.getAllByText(title(), { exact: true })).toHaveLength(1)

    // The existing details affordance remains keyboard-focusable.
    indication.focus()
    expect(indication).toHaveFocus()
    fireEvent.click(indication)
    expect(indication).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('The request did not finish.')).toBeVisible()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(shell).getByTestId('process-child')).not.toBeEmptyDOMElement()
    expect(screen.getByRole('button', { name: title() })).toBe(indication)
    expect(screen.getAllByText(title(), { exact: true })).toHaveLength(1)
    expect(within(shell).queryByText(title(), { exact: true })).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(within(shell).queryByTestId('process-child')).toBeNull())
    expect(indication).toBeVisible()
    expect(screen.getAllByText(title(), { exact: true })).toHaveLength(1)
  })

  it.each(['all', 'final', 'process', 'inline'] as const)('assigns an empty failure to the correct %s scope without duplication', scope => {
    const failed = assistant(`${stopReason}-empty-${scope}`, [], stopReason)
    render(<MessageRenderer item={failed} processContentScope={scope} />)
    expect(screen.queryAllByText(title(), { exact: true })).toHaveLength(scope === 'all' || scope === 'final' ? 1 : 0)
  })

  it('keeps the fallback indication when a tool chain ends without provider error text', () => {
    const first = assistant(`${stopReason}-first`, [{ type: 'toolCall', id: 'first', name: 'read', arguments: {} }], 'stop')
    const failed = assistant(`${stopReason}-last`, processBlocks[1].blocks, stopReason)
    const entries = buildVisibleTimelineEntries([first, failed])
    expect(entries).toHaveLength(1)
    expect((entries[0].item as PiAssistantMessageItem).message.stopReason).toBe(stopReason)
    render(<ProcessTimeline items={[user(`${stopReason}-merged-user`), first, failed]} stateKey={`test:${stopReason}:merged`} />)
    expect(screen.getAllByText(title(), { exact: true })).toHaveLength(1)
  })

  it('does not duplicate the failure when a partial final answer also exists', () => {
    const failed = assistant(`${stopReason}-partial`, [...processBlocks[0].blocks, { type: 'text', text: 'Partial answer' }], stopReason)
    render(<ProcessTimeline items={[user(`${stopReason}-partial-user`), failed]} stateKey={`test:${stopReason}:partial`} />)
    expect(screen.getByText('Partial answer')).toBeVisible()
    expect(screen.getAllByText(title(), { exact: true })).toHaveLength(1)
    fireEvent.click(within(screen.getByTestId('process-shell')).getByRole('button'))
    expect(screen.getAllByText('Partial answer')).toHaveLength(1)
    expect(screen.getAllByText(title(), { exact: true })).toHaveLength(1)
  })
})

it('does not invent a failure or final answer for successful process-only work', () => {
  const completed = assistant('success', processBlocks[0].blocks, 'stop')
  expect(assistantHasFinalContent(completed)).toBe(false)
  render(<ProcessTimeline items={[user('success-user'), completed]} stateKey="test:success" />)
  expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(1)
  expect(screen.queryByText(i18n.t('errors.unknownError', { ns: 'message' }))).toBeNull()
  expect(screen.queryByText(i18n.t('errors.messageAborted', { ns: 'message' }))).toBeNull()
})
