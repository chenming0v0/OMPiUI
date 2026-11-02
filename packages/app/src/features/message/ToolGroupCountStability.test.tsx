/**
 * 复现 #426 报告的工具组计数闪烁：disk preview（awaitingSnapshot）↔ 正式快照
 * 交替应用时 doneCount 0↔N 翻转。执行状态投影必须是单调收敛的：
 * awaitingSnapshot 不得把已有 result 的执行打回 unknown。
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageRenderer } from './MessageRenderer'
import { buildVisibleTimelineEntries } from '../chat/chatAreaVisibility'
import type { PiAssistantMessageItem } from '../../omp/domain/index.js'
import { FullscreenProvider } from '../../contexts'

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
    descriptiveToolSteps: false, immersiveMode: false, processCollapseEnabled: false,
  }),
}))

function assistant(id: string, calls: string[], timestamp: number): PiAssistantMessageItem {
  const blocks = calls.map(callId => ({ type: 'toolCall' as const, id: callId, name: 'bash', arguments: { command: callId } }))
  const message: PiAssistantMessageItem['message'] = {
    role: 'assistant', content: blocks, api: 'anthropic-messages', provider: 'anthropic', model: 'model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp,
  }
  return {
    kind: 'assistant_message', entryId: id, timestamp, message, blocks,
    rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(timestamp).toISOString(), message },
    toolResults: Object.fromEntries(calls.map(callId => [callId, {
      role: 'toolResult' as const, toolCallId: callId, toolName: 'bash',
      content: [{ type: 'text' as const, text: callId }], isError: false, timestamp: timestamp + 1,
    }])),
    renderKey: id,
  }
}

function renderCounts(item: PiAssistantMessageItem): string {
  const entries = buildVisibleTimelineEntries([item])
  const { container, unmount } = render(<FullscreenProvider><MessageRenderer item={entries[0].item} processContentScope="inline" /></FullscreenProvider>)
  const text = container.textContent ?? ''
  unmount()
  return text
}

describe('tool group count does not flip between snapshot passes', () => {
  it('keeps a settled count when executions gain awaitingSnapshot then lose it', () => {
    const settled = assistant('flip', Array.from({ length: 12 }, (_, i) => `flip-bash-${i}`), 100)
    // 快照通过：全部完成 → 12/12
    expect(renderCounts(settled)).toContain('12/12')
    // disk preview 快照通过：同一份结果上等待快照确认（isRunning 置 false + awaitingSnapshot）
    // —— 有 result 的执行不允许被打回 unknown
    const snapshotPass: PiAssistantMessageItem = {
      ...settled,
      toolExecutions: Object.fromEntries(Object.keys(settled.toolResults).map(id => [id, { awaitingSnapshot: true }])),
    }
    expect(renderCounts(snapshotPass)).toContain('12/12')
  })

  it('keeps 0/12 stable while genuinely awaiting and 12/12 after results land', () => {
    // 真正的等待态（没有 result）：0/12 → 结果落地 → 12/12，只单向前进
    const pending = assistant('pending', Array.from({ length: 12 }, (_, i) => `pending-bash-${i}`), 100)
    pending.toolResults = {}
    expect(renderCounts(pending)).toContain('0/12')
    expect(renderCounts(assistant('pending-done', Array.from({ length: 12 }, (_, i) => `pending-bash-${i}`), 100)))
      .toContain('12/12')
  })
})
