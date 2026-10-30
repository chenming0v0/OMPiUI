import { describe, expect, it } from 'vitest'
import type { PiToolExecution } from '../../../omp/domain/index.js'
import { extractTaskProgress, findAsyncTaskResult, getTaskToolView, indexAsyncTaskResults, isAsyncTaskDispatch, resolveTaskExecution } from './taskToolData'
import { xdTaskAsyncCall, xdTaskAsyncDelivery, xdTaskAsyncResult } from './__fixtures__/xdTaskAsyncDispatch'

const writeCall = (args: Record<string, unknown>, extra: Partial<PiToolExecution> = {}): PiToolExecution => ({
  call: { type: 'toolCall', id: 'call-xd', name: 'write', arguments: args as never },
  ...extra,
})

describe('getTaskToolView', () => {
  it('passes native task through unchanged', () => {
    const execution: PiToolExecution = { call: { type: 'toolCall', id: 'call-1', name: 'task', arguments: { tasks: [] } } }
    const view = getTaskToolView(execution)
    expect(view).toMatchObject({ source: 'task', argumentsState: 'ready' })
    expect(view?.execution).toBe(execution)
  })

  it('unwraps write xd://task content without mutating the original call', () => {
    const execution = writeCall({ path: 'xd://task', content: JSON.stringify({ agent: 'task', tasks: [{ name: 'A', task: 'do' }] }) }, { startedAt: 1, isRunning: true })
    const view = getTaskToolView(execution)!
    expect(view.source).toBe('xd-write')
    expect(view.argumentsState).toBe('ready')
    expect(view.execution.call).toMatchObject({ id: 'call-xd', name: 'task', arguments: { tasks: [{ name: 'A', task: 'do' }] } })
    expect(view.rawCall).toMatchObject({ name: 'write', path: 'xd://task' })
    expect(execution.call.name).toBe('write')
    expect(execution.call.arguments).toHaveProperty('path', 'xd://task')
  })

  it('reports streaming content as generating instead of started', () => {
    expect(getTaskToolView(writeCall({ path: 'xd://task', content: '{"tasks":[{"na' }))?.argumentsState).toBe('streaming')
    expect(getTaskToolView(writeCall({ path: 'xd://task' }))?.argumentsState).toBe('streaming')
  })

  it('keeps the parse error once the call has started', () => {
    const view = getTaskToolView(writeCall({ path: 'xd://task', content: '{oops' }, { startedAt: 1, isRunning: true }))!
    expect(view.argumentsState).toBe('invalid')
    expect(view.argumentsError).toBeTruthy()
    expect(view.rawCall.content).toBe('{oops')
  })

  it('prefers xdev.args and xdev.inner once the result arrives', () => {
    const execution = writeCall({ path: 'xd://task', content: '{broken' }, {
      result: {
        role: 'toolResult', toolCallId: 'call-xd', toolName: 'write', content: [{ type: 'text', text: 'Running agent' }], isError: false, timestamp: 1,
        details: { xdev: { tool: 'task', args: { tasks: [{ name: 'B', task: 't' }] }, inner: { results: [{ index: 0, id: 'B', exitCode: 0 }] } } },
      },
    })
    const view = getTaskToolView(execution)!
    expect(view.argumentsState).toBe('ready')
    expect(view.execution.call.arguments).toEqual({ tasks: [{ name: 'B', task: 't' }], description: 'B' })
    expect(view.execution.result).toMatchObject({ toolName: 'task', details: { results: [{ id: 'B' }] } })
  })

  it('ignores read xd://task, plain writes and output text', () => {
    expect(getTaskToolView({ call: { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'xd://task' } } })).toBeUndefined()
    const plain = writeCall({ path: 'notes.md', content: '{"tasks":[]}' }, {
      result: { role: 'toolResult', toolCallId: 'call-xd', toolName: 'write', content: [{ type: 'text', text: 'Running agent' }], isError: false, timestamp: 1 },
    })
    expect(getTaskToolView(plain)).toBeUndefined()
    expect(resolveTaskExecution(plain)).toBe(plain)
  })
})

describe('structured async task outcome', () => {
  it('keeps structured fields and opaque output without parsing XML into status', () => {
    const content = '<task-result status="failed"><error>Text-only error</error><merge-summary>merged</merge-summary><preview full-output="agent://A">raw</preview></task-result>'
    const entries = [{ type: 'custom_message', customType: 'async-result', timestamp: 10, content,
      details: { jobs: [{ jobId: 'A', type: 'task', status: 'completed', meta: { exitCode: 0, mergeError: 'Conflict', changesApplied: false,
        stdout: 'execution output', stderr: 'diagnostic', outputPath: 'C:/sessions/A.md', recovery: { branch: 'keep-me' } } }] } }]
    const result = findAsyncTaskResult(indexAsyncTaskResults(entries), 'A', 5)!
    expect(result.output).toBe(content)
    expect(result.errors).toEqual([])
    expect(result.details).toMatchObject({ exitCode: 0, stdout: 'execution output', stderr: 'diagnostic', outputPath: 'C:/sessions/A.md', recovery: { branch: 'keep-me' } })
    expect(result.outcome).toMatchObject({ executionStatus: 'completed', mergeStatus: 'failed', presentationStatus: 'error' })
    expect(indexAsyncTaskResults(entries)).toBe(indexAsyncTaskResults(entries))
  })

  it('does not invent structured completion or merge evidence from delivery text', () => {
    const entries = [{ type: 'custom_message', customType: 'async-result', timestamp: 10,
      content: '<task-result status="completed"><merge-summary>All changes applied</merge-summary></task-result>',
      details: { jobs: [{ jobId: 'A', type: 'task' }] } }]
    expect(findAsyncTaskResult(indexAsyncTaskResults(entries), 'A', 5)).toMatchObject({ status: 'unknown', outcome: { executionStatus: 'unknown', mergeStatus: 'unconfirmed' } })
  })
})

describe('async xd://task dispatch (real OMP 18.12.6 fixture)', () => {
  const view = getTaskToolView({ call: xdTaskAsyncCall, result: xdTaskAsyncResult })!

  it('is a ready task, not invalid, and exposes progress[] as subagent metadata', () => {
    expect(view.argumentsState).toBe('ready')
    const details = view.execution.result?.details as Record<string, unknown>
    expect(isAsyncTaskDispatch(details)).toBe(true)
    expect(extractTaskProgress(details)).toEqual([
      expect.objectContaining({ index: 0, id: 'ReviewNativeIntegration', agent: 'reviewer', status: 'pending', assignment: '# Target\n[sanitized]' }),
      expect.objectContaining({ index: 1, id: 'ReviewGuiGitIntegration', agent: 'reviewer' }),
    ])
  })

  it('titles a multi-task call from the write intent', () => {
    expect((view.execution.call.arguments as Record<string, unknown>).description).toBe('Dispatching independent integration reviews using task')
  })

  it('indexes the later async-result delivery by job id after the dispatch', () => {
    const index = indexAsyncTaskResults([xdTaskAsyncDelivery])
    const delivered = findAsyncTaskResult(index, 'ReviewGuiGitIntegration', xdTaskAsyncResult.timestamp)
    expect(delivered).toMatchObject({ status: 'completed', durationMs: 432244 })
    expect(delivered?.output).toContain('### [P1] Normalize link notifications')
    expect(findAsyncTaskResult(index, 'ReviewNativeIntegration', xdTaskAsyncResult.timestamp)).toBeUndefined()
    expect(findAsyncTaskResult(index, 'ReviewGuiGitIntegration', Date.parse(xdTaskAsyncDelivery.timestamp) + 1)).toBeUndefined()
  })

  it('keeps content upstream also rejects (raw newline inside a string) invalid', () => {
    const rejected = getTaskToolView(writeCall({ path: 'xd://task', content: '{"tasks":[{"name":"RepairCiWorktreePaths","task":"line one\nline two"}]}' }, {
      result: { role: 'toolResult', toolCallId: 'call-xd', toolName: 'write', isError: true, timestamp: 1,
        content: [{ type: 'text', text: 'xd://task expects a JSON args object as content (JSON Parse error: Unterminated string)' }],
        details: { xdev: { tool: 'task', mode: 'execute' } } },
    }))!
    expect(rejected.argumentsState).toBe('invalid')
    expect(rejected.attemptedNames).toEqual(['RepairCiWorktreePaths'])
  })
})
