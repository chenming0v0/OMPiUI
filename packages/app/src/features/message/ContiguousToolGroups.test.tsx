import type { ComponentProps } from 'react'
import { ToolGroup } from './parts/ToolGroup'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageRenderer } from './MessageRenderer'
import { buildVisibleTimelineEntries } from '../chat/chatAreaVisibility'
import type { PiAssistantMessageItem } from '../../omp/domain/index.js'

vi.mock('motion/mini', () => ({ animate: () => Promise.resolve() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, args?: { done: number; total: number }) =>
    key === 'stepsCount' ? `${args?.done}/${args?.total}` : key }),
}))
vi.mock('../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined, headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
  useCompositorExpand: (open: boolean) => ({
    contentRef: { current: null }, layoutOpen: open, keepMounted: open, panelClassName: '',
  }),
}))
vi.mock('../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false, canHover: true }),
}))
vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    stepFinishDisplay: {}, actionsOnLatestAssistantOnly: true,
    descriptiveToolSteps: false, immersiveMode: false, processCollapseEnabled: true,
  }),
}))
vi.mock('./parts', () => ({
  ToolGroup: (props: ComponentProps<typeof ToolGroup>) => <ToolGroup {...props} />,
  TextPartView: ({ part }: { part: { text: string } }) => <p>{part.text}</p>,
  ReasoningPartView: ({ part }: { part: { thinking: string } }) => <p>{part.thinking}</p>,
  MessageErrorView: () => null,
}))

function assistant(id: string, blocks: PiAssistantMessageItem['blocks'], timestamp: number): PiAssistantMessageItem {
  const message: PiAssistantMessageItem['message'] = {
    role: 'assistant', content: blocks, api: 'anthropic-messages', provider: 'anthropic', model: 'model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp,
  }
  return {
    kind: 'assistant_message', entryId: id, timestamp, message, blocks,
    rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(timestamp).toISOString(), message },
    toolResults: Object.fromEntries(blocks.flatMap(block => block.type === 'toolCall' ? [[block.id, {
      role: 'toolResult', toolCallId: block.id, toolName: block.name,
      content: [{ type: 'text', text: block.id }], isError: block.id === 'eval-failed', timestamp: timestamp + 1,
    }]] : [])),
  }
}
const call = (id: string, name: string) => ({ type: 'toolCall' as const, id, name, arguments: {} })

function fixture() {
  return [
    assistant('first', [
      { type: 'thinking', thinking: 'Updating progress tracking' },
      call('read-1', 'read'), call('read-2', 'read'), call('read-3', 'read'), call('edit', 'edit'),
      { type: 'thinking', thinking: '' },
    ], 100),
    assistant('eval-failed-message', [{ type: 'text', text: ' \n' }, call('eval-failed', 'eval')], 200),
    assistant('eval-completed-message', [call('eval-completed', 'eval')], 300),
    assistant('next', [{ type: 'thinking', thinking: 'Evaluating tool functionality' },
      call('next-read', 'read'), call('next-eval', 'eval')], 400),
  ]
}

describe('contiguous assistant tool groups', () => {
  it('renders one settled six-tool group including a failed Eval, then starts a new reasoning segment', () => {
    const entries = buildVisibleTimelineEntries(fixture())
    render(<>{entries.map(({ item }) => <MessageRenderer key={item.entryId} item={item} processContentScope="inline" />)}</>)
    expect(screen.getAllByRole('button', { name: /^6\/6/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^2\/2/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^4\/4/ })).toBeNull()
    expect(screen.getByText('Updating progress tracking')).toBeInTheDocument()
    expect(screen.getByText('Evaluating tool functionality')).toBeInTheDocument()
  })

  it('retains every result and source timestamp while reusing unchanged virtual identities', () => {
    const sources = fixture()
    const first = buildVisibleTimelineEntries(sources)
    const repeated = buildVisibleTimelineEntries([...sources])
    const merged = first[0].item as PiAssistantMessageItem
    expect(merged).toBe(repeated[0].item)
    expect(first[0].sourceIds).toEqual(['first', 'eval-failed-message', 'eval-completed-message'])
    expect(merged.blocks.filter(block => block.type === 'toolCall').map(block => block.id))
      .toEqual(['read-1', 'read-2', 'read-3', 'edit', 'eval-failed', 'eval-completed'])
    expect(merged.toolResults['eval-failed']).toBe(sources[1].toolResults['eval-failed'])
    expect(merged.toolResults['eval-completed']).toBe(sources[2].toolResults['eval-completed'])
    expect(merged.toolCallTimestamps).toEqual({
      'read-1': 100, 'read-2': 100, 'read-3': 100, edit: 100, 'eval-failed': 200, 'eval-completed': 300,
    })
  })

  it('keeps the group key and transitions the progress count as the final Eval result arrives', () => {
    const sources = fixture().slice(0, 3)
    const pending = { ...sources[2], toolResults: {}, isStreaming: true }
    const live = buildVisibleTimelineEntries([sources[0], sources[1], pending])[0]
    const { rerender } = render(<MessageRenderer item={live.item} processContentScope="inline" />)
    expect(screen.getByRole('button', { name: /^5\/6/ })).toBeInTheDocument()
    expect((live.item as PiAssistantMessageItem).isStreaming).toBe(true)
    const settled = buildVisibleTimelineEntries(sources)[0]
    expect(settled.item.entryId).toBe(live.item.entryId)
    rerender(<MessageRenderer item={settled.item} processContentScope="inline" />)
    expect(screen.getByRole('button', { name: /^6\/6/ })).toBeInTheDocument()
  })

  it.each(['text', 'thinking'] as const)('does not merge across visible %s', type => {
    const first = assistant('one', [call('one', 'read')], 100)
    const boundary = type === 'text'
      ? { type, text: 'Separate segment' }
      : { type, thinking: 'Separate segment' }
    const second = assistant('two', [boundary, call('two', 'eval')], 200)
    expect(buildVisibleTimelineEntries([first, second]).map(entry => entry.sourceIds))
      .toEqual([['one'], ['two']])
  })

  it('preserves a reasoning boundary after leading Eval calls in the same message', () => {
    const first = assistant('one', [call('read', 'read')], 100)
    const second = assistant('two', [call('eval', 'eval'),
      { type: 'thinking', thinking: 'New reasoning' }, call('next', 'read'), call('last', 'edit')], 200)
    const entries = buildVisibleTimelineEntries([first, second])
    render(<MessageRenderer item={entries[0].item} processContentScope="inline" />)
    expect(screen.getAllByRole('button', { name: /^2\/2/ })).toHaveLength(2)
    expect(screen.getByText('New reasoning')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^4\/4/ })).toBeNull()
  })

  it('never joins tools across a user boundary, even an empty user entry', () => {
    const [first, second] = fixture()
    const user = {
      kind: 'user_message' as const, entryId: 'user', timestamp: 150, rawEntry: first.rawEntry,
      message: { role: 'user' as const, content: '', timestamp: 150 }, blocks: [],
    }
    expect(buildVisibleTimelineEntries([first, user, second]).map(entry => entry.sourceIds))
      .toEqual([['first'], ['eval-failed-message']])
  })
})
