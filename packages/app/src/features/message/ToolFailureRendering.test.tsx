// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FullscreenProvider } from '../../contexts/FullscreenContext'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { ToolPartView } from './parts/ToolPartView'
import { ToolGroup } from './parts/ToolGroup'
import i18n from '../../i18n'
import type { PiToolExecution } from '../../omp/domain'
import { themeStore } from '../../store/themeStore'

let previousStyle = themeStore.toolCardStyle
beforeEach(() => { previousStyle = themeStore.toolCardStyle; themeStore.setToolCardStyle('classic') })
afterEach(() => themeStore.setToolCardStyle(previousStyle))

function surface(execution: PiToolExecution, key: string) {
  return <FullscreenProvider><SessionNavigationContext.Provider value={{ currentSessionId: 'render-failure', currentDirectory: undefined, navigateToSession: () => {} }}><ToolPartView execution={execution} partKey={key} defaultExpanded /></SessionNavigationContext.Provider></FullscreenProvider>
}

describe('specialized tool failures', () => {
  it.each([['en', 'Subagent failed'], ['zh-CN', '子代理失败']] as const)('localizes the native task rejection summary in %s', async (language, label) => {
    const previousLanguage = i18n.language
    const previousDescriptive = themeStore.descriptiveToolSteps
    try {
      await i18n.changeLanguage(language)
      themeStore.setDescriptiveToolSteps(true)
      const execution: PiToolExecution = { call: { type: 'toolCall', id: `task-rejected-${language}`, name: 'task', arguments: {} },
        result: { role: 'toolResult', toolCallId: `task-rejected-${language}`, toolName: 'task', timestamp: 1, isError: true,
          content: [{ type: 'text', text: 'Missing `context`. Provide the shared background for this batch.' }], details: { results: [], totalDurationMs: 0 } } }
      render(<FullscreenProvider><SessionNavigationContext.Provider value={{ currentSessionId: 'render-failure', currentDirectory: undefined, navigateToSession: () => {} }}><ToolGroup groupId={`task-rejected-${language}`} executions={[execution]} /></SessionNavigationContext.Provider></FullscreenProvider>)
      expect(await screen.findByRole('button', { name: label })).toBeVisible()
      expect(screen.queryByText('toolSteps.taskFailed')).not.toBeInTheDocument()
    } finally {
      themeStore.setDescriptiveToolSteps(previousDescriptive)
      await i18n.changeLanguage(previousLanguage)
    }
  })

  it.each(['ask', 'todo', 'yield', 'bash'] as const)('keeps the original %s rejection visible instead of showing its specialized success view', async name => {
    const explanation = `${name}: rejected because the session ended before acceptance`
    const execution: PiToolExecution = { call: { type: 'toolCall', id: `failed-${name}`, name, arguments: { data: { reply: 'Rejected reply' }, todos: [{ content: 'Attempted task', status: 'completed' }] } },
      result: { role: 'toolResult', toolCallId: `failed-${name}`, toolName: name, timestamp: 200, isError: true,
        content: [{ type: 'text', text: explanation }], details: { status: 'success', data: { reply: 'Rejected reply' }, todos: [{ content: 'Attempted task', status: 'completed' }] } } }
    render(surface(execution, `failed-render-${name}`))
    expect(await screen.findByText(explanation)).toBeVisible()
    expect(screen.queryByText('Rejected reply')).not.toBeInTheDocument()
  })

  it('shows the aggregate task failure together with the per-child merge explanation', async () => {
    const execution: PiToolExecution = { call: { type: 'toolCall', id: 'task-merge', name: 'task', arguments: {} },
      result: { role: 'toolResult', toolCallId: 'task-merge', toolName: 'task', timestamp: 1, isError: false,
        content: [{ type: 'text', text: 'Execution completed but changes were not applied' }],
        details: { results: [{ id: 'MergeChild', exitCode: 0, mergeError: 'Cannot merge conflicting changes', output: 'Child analysis finished' }] } } }
    render(surface(execution, 'task-merge-render'))
    expect(await screen.findByText(/Execution completed but changes were not applied/)).toBeVisible()
    expect(screen.getByText(/Cannot merge conflicting changes/)).toBeVisible()
  })

  it('keeps a deferred details image accessible beside a specialized yield result', async () => {
    const execution: PiToolExecution = { call: { type: 'toolCall', id: 'yield-image', name: 'yield', arguments: { data: { reply: 'Image report submitted' } } },
      result: { role: 'toolResult', toolCallId: 'yield-image', toolName: 'yield', timestamp: 1, isError: false,
        content: [{ type: 'text', text: 'Result submitted' }], details: { data: { reply: 'Image report submitted' }, images: [{ data: '', mimeType: 'image/png', attachment: { entryId: 'yield-result', blockIndex: 0, source: 'details' } }] } } }
    render(surface(execution, 'yield-image-render'))
    expect(await screen.findByText('Image report submitted')).toBeVisible()
    expect(screen.getByRole('button', { name: 'image.png' })).toBeVisible()
  })
})
