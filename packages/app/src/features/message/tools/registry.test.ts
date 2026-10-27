import { describe, expect, it } from 'vitest'
import { getToolExecutionStatus, type PiToolExecution } from '../../../omp/domain/index.js'
import { defaultExtractData, extractToolData } from './registry'

describe('defaultExtractData', () => {
  it('extracts files and diagnostics from result details', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        arguments: { filePath: 'src/app.ts' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 0,
        details: {
          files: [
            {
              filePath: 'src/app.ts',
              diff: '@@ -1 +1 @@',
              additions: 1,
              deletions: 1,
            },
          ],
          diagnostics: {
            'src/app.ts': [
              {
                severity: 1,
                message: 'Syntax error',
                range: { start: { line: 3, character: 5 } },
              },
            ],
          },
        },
      },
    }

    const extracted = defaultExtractData(execution)

    expect(extracted.files).toEqual([expect.objectContaining({ filePath: 'src/app.ts', additions: 1, deletions: 1 })])
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({ file: 'app.ts', severity: 'error', line: 3, column: 5 }),
    ])
  })

  it('extracts native bash truncation fields from result details', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-2',
        name: 'bash',
        arguments: { command: 'make build' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'bash',
        content: [{ type: 'text', text: 'truncated output...' }],
        isError: false,
        timestamp: 0,
        details: {
          truncated: true,
          fullOutputPath: '/tmp/pi-bash-abc.log',
          exitCode: 0,
        },
      },
    }

    const extracted = extractToolData(execution)

    expect(extracted.cwd).toBeUndefined()
    expect(extracted.truncated).toBe(true)
    expect(extracted.fullOutputPath).toBe('/tmp/pi-bash-abc.log')
  })

  it.each([
    { name: 'bash', state: 'failed', timedOut: false, status: 'error' },
    { name: 'bash', state: 'starting', timedOut: true, status: 'completed' },
    { name: 'read', state: 'failed', timedOut: false, status: 'completed' },
  ] as const)('uses native $name service $state without inferring failure from readiness', ({ name, state, timedOut, status }) => {
    const text = state === 'starting' ? 'NOT ready — readiness timed out; process state: starting.' : 'Native service state: failed'
    const execution: PiToolExecution = {
      call: { type: 'toolCall', id: 'service-outcome', name, arguments: {} },
      result: { role: 'toolResult', toolCallId: 'service-outcome', toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: 0,
        details: { service: { state, ready: false, timedOut } } },
    }
    const extracted = defaultExtractData(execution)
    expect(getToolExecutionStatus(execution)).toBe(status)
    expect(extracted.error).toBe(status === 'error' ? text : undefined)
  })

  it('keeps OMP glob/grep string file lists as text output instead of per-file cards', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-3',
        name: 'glob',
        arguments: { pattern: '**/*.tsx' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-3',
        toolName: 'glob',
        content: [{ type: 'text', text: 'src/App.tsx\nsrc/main.tsx' }],
        isError: false,
        timestamp: 0,
        details: {
          files: ['src/App.tsx', 'src/main.tsx'],
          fileCount: 2,
          cwd: 'C:/work/demo',
        },
      },
    }

    const extracted = defaultExtractData(execution)

    expect(extracted.files).toBeUndefined()
    expect(extracted.output).toBe('src/App.tsx\nsrc/main.tsx')
    expect(extracted.cwd).toBe('C:/work/demo')
  })

  it('uses resolvedPath from OMP read details as filePath', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-4',
        name: 'read',
        arguments: { path: 'app.ts' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-4',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 0,
        details: {
          resolvedPath: 'C:/work/demo/app.ts',
        },
      },
    }

    const extracted = defaultExtractData(execution)

    expect(extracted.filePath).toBe('C:/work/demo/app.ts')
  })

  it('preserves content images alongside nested details attachment images', () => {
    const execution: PiToolExecution = {
      call: { type: 'toolCall', id: 'images', name: 'read', arguments: {} },
      result: { role: 'toolResult', toolCallId: 'images', toolName: 'read', timestamp: 1, isError: false,
        content: [{ type: 'image', data: 'inline', mimeType: 'image/png' }],
        details: { xdev: { result: { type: 'image', data: 'blob:sha256:abc', mimeType: 'image/png', attachment: { entryId: 'e1', blockIndex: 0, source: 'details' } } } },
      },
    }
    expect(defaultExtractData(execution).images).toMatchObject([
      { url: 'data:image/png;base64,inline' },
      { block: { data: 'blob:sha256:abc', attachment: { entryId: 'e1', source: 'details' } } },
    ])
  })

  it('retains raw failure content when details also describes file changes', () => {
    const execution: PiToolExecution = {
      call: { type: 'toolCall', id: 'edit-failed', name: 'edit', arguments: {} },
      result: { role: 'toolResult', toolCallId: 'edit-failed', toolName: 'edit', timestamp: 1, isError: true,
        content: [{ type: 'text', text: 'Permission denied while saving app.ts' }], details: { files: [{ filePath: 'app.ts', before: 'a', after: 'b' }] } },
    }
    expect(defaultExtractData(execution).error).toBe('Permission denied while saving app.ts')
  })
  it('retains a yield failure payload even when structured yield metadata is also present', () => {
    const execution: PiToolExecution = { call: { type: 'toolCall', id: 'yield-error', name: 'yield', arguments: { data: { reply: 'Attempted response' } } },
      result: { role: 'toolResult', toolCallId: 'yield-error', toolName: 'yield', timestamp: 1, isError: true,
        content: [{ type: 'text', text: 'Submission rejected by the parent' }], details: { error: 'Result contract violated' } } }
    expect(extractToolData(execution).error).toBe('Submission rejected by the parent\nResult contract violated')
  })

  it('classifies native-details merge failure as failure despite successful exit metadata', () => {
    const execution: PiToolExecution = { call: { type: 'toolCall', id: 'merge-error', name: 'eval', arguments: {} },
      result: { role: 'toolResult', toolCallId: 'merge-error', toolName: 'eval', timestamp: 1, isError: false,
        content: [{ type: 'text', text: 'Child execution completed' }], details: { exitCode: 0, nativeDetails: { mergeError: 'Worktree merge conflicted' } } } }
    expect(extractToolData(execution).error).toBe('Child execution completed\nWorktree merge conflicted')
    expect(extractToolData(execution).output).toBeUndefined()
  })
})

describe('write destinations', () => {
  function writeExecution(path: string, details?: unknown): PiToolExecution {
    return {
      call: { type: 'toolCall', id: 'write-call', name: 'write', arguments: { path, content: 'submitted payload' } },
      result: {
        role: 'toolResult', toolCallId: 'write-call', toolName: 'write', timestamp: 0,
        content: [{ type: 'text', text: 'Noted, thanks!' }], isError: false, details,
      },
    }
  }

  it.each([
    'xd://report_issue', 'xd://lsp', 'agent://Main', 'proc://123',
    'cfg://settings', 'issue://42', 'custom-device://invoke',
  ])('shows actual output instead of inventing a file for %s', path => {
    const extracted = extractToolData(writeExecution(path, {
      xdev: { tool: path.slice('xd://'.length), mode: 'execute', args: { report: 'submitted payload' } },
    }))
    expect(extracted.output).toBe('Noted, thanks!')
    expect(extracted.diff).toBeUndefined()
    expect(extracted.files).toBeUndefined()
    expect(extracted.filePath).toBeUndefined()
  })

  it.each([
    'src/app.ts', '/tmp/app.ts', 'C:\\work\\app.ts',
    'file:///tmp/app.ts', 'local://app.ts', 'ssh://host/tmp/app.ts',
  ])('preserves file content rendering for %s', path => {
    const extracted = extractToolData(writeExecution(path))
    expect(extracted.filePath).toBe(path)
    expect(extracted.diff).toEqual({ before: '', after: 'submitted payload' })
  })

  it('preserves real file changes reported by a virtual tool', () => {
    const extracted = extractToolData(writeExecution('xd://lsp', {
      filepath: 'src/app.ts', filediff: { before: 'old name', after: 'new name' },
    }))
    expect(extracted.filePath).toBe('src/app.ts')
    expect(extracted.diff).toEqual({ before: 'old name', after: 'new name' })
  })
})
