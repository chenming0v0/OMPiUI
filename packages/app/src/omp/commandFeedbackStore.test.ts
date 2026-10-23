import { beforeEach, describe, expect, it } from 'vitest'
import { commandFeedbackStore } from './commandFeedbackStore'

describe('commandFeedbackStore', () => {
  beforeEach(() => commandFeedbackStore.reset())

  it('retains complete multiline output in its owning session across other session updates', () => {
    const message = Array.from({ length: 120 }, (_, index) => `workspace ${index}: C:/工作区/long-directory-${index}`).join('\n') + '\n'
    commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: message })
    const before = commandFeedbackStore.getSnapshot()
    commandFeedbackStore.addNativeEvent('b', { type: 'command_output', text: 'Fast mode is off.' })
    commandFeedbackStore.remove('b')
    const entry = commandFeedbackStore.getSnapshot().sessions.a?.[0]
    expect(entry?.message).toBe(message)
    expect(entry?.status).toBe('info')
    expect(before.sessions.a).toBe(commandFeedbackStore.getSnapshot().sessions.a)
    expect(commandFeedbackStore.getSnapshot().sessions.b).toBeUndefined()
  })

  it('keeps the newest 100 results without truncating the retained boundary entry', () => {
    for (let index = 0; index < 101; index++) {
      commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: `result ${index}\nlast line ${index}` })
    }
    const rows = commandFeedbackStore.getSnapshot().sessions.a!
    expect(rows.map(row => row.message)).toEqual(
      Array.from({ length: 100 }, (_, index) => `result ${100 - index}\nlast line ${100 - index}`),
    )
  })

  it('does not fabricate command success for usage text or a completed prompt acknowledgement', () => {
    const usage = commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: 'Usage: /fast [on|off|status]' })
    expect(usage?.status).toBe('info')
    expect(commandFeedbackStore.addNativeEvent('a', { type: 'prompt_result', agentInvoked: false, status: 'completed' })).toBeNull()
    expect(commandFeedbackStore.getSnapshot().sessions.a?.map(row => row.message)).toEqual(['Usage: /fast [on|off|status]'])
  })

  it('retains explicit native errors and local prompt failures without requiring assistant messages', () => {
    commandFeedbackStore.addNativeEvent('a', { type: 'command_output', text: 'Command rejected.\nNo changes written.', isError: true })
    commandFeedbackStore.addNativeEvent('a', { type: 'prompt_result', agentInvoked: false, status: 'error', error: { message: 'Native failure\nDetails from engine', retryable: false } })
    expect(commandFeedbackStore.getSnapshot().sessions.a?.map(({ status, message }) => ({ status, message }))).toEqual([
      { status: 'error', message: 'Native failure\nDetails from engine' },
      { status: 'error', message: 'Command rejected.\nNo changes written.' },
    ])
    expect(commandFeedbackStore.addNativeEvent('b', { type: 'prompt_result', agentInvoked: true, status: 'error', error: { message: 'Agent failure' } })).toBeNull()
    expect(commandFeedbackStore.getSnapshot().sessions.b).toBeUndefined()
  })
  it('retains a real extension command throw as failure even when native local completion follows', () => {
    commandFeedbackStore.addNativeEvent('a', { type: 'extension_error', event: 'command', extensionPath: 'command:review', error: 'Permission denied\nNo changes written.' })
    expect(commandFeedbackStore.addNativeEvent('a', { type: 'prompt_result', agentInvoked: false, status: 'completed' })).toBeNull()
    expect(commandFeedbackStore.getSnapshot().sessions.a?.map(({ source, command, status, message }) => ({ source, command, status, message }))).toEqual([
      { source: 'command:review', command: 'review', status: 'error', message: 'Permission denied\nNo changes written.' },
    ])
    expect(commandFeedbackStore.addNativeEvent('b', { type: 'extension_error', event: 'agent_end', extensionPath: '/extension.ts', error: 'Background error' })).toBeNull()
    expect(commandFeedbackStore.getSnapshot().sessions.b).toBeUndefined()
  })

  it('does not report a cancelled native command as success', () => {
    const entry = commandFeedbackStore.addNativeEvent('a', { type: 'prompt_result', agentInvoked: false, status: 'aborted', error: { message: 'Cancelled by request' } })
    expect(entry?.status).toBe('info')
    expect(entry?.message).toBe('Cancelled by request')
  })
})
