import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginProviderAuthRecovery,
  clearProviderAuthEvent,
  dismissProviderAuthFlow,
  getManagementEventSnapshot,
  getTrackedManagementProviders,
  receivePackageProgress,
  receiveProviderAuthEvent,
  receiveResourceRevision,
  registerProviderAuthFlow,
  resetManagementEvents,
  restoreProviderAuthFlows,
  trackManagementProviders,
} from './managementEventStore'

describe('managementEventStore', () => {
  beforeEach(() => resetManagementEvents())

  it('tracks provider streams and preserves an early auth prompt when the flow is registered', () => {
    trackManagementProviders(['anthropic', 'anthropic', 'openai'])
    expect(getTrackedManagementProviders()).toEqual(['anthropic', 'openai'])

    receiveProviderAuthEvent({
      type: 'prompt',
      flowId: 'flow-1',
      promptId: 'prompt-1',
      providerId: 'anthropic',
      prompt: { type: 'secret', message: 'API key' },
    })
    registerProviderAuthFlow('flow-1', 'anthropic')
    expect(getManagementEventSnapshot().flows['flow-1'].event).toMatchObject({ type: 'prompt', promptId: 'prompt-1' })
  })

  it('does not let a refresh snapshot overwrite a newer prompt or revive a dismissed flow', () => {
    const recovery = beginProviderAuthRecovery()
    receiveProviderAuthEvent({
      type: 'prompt',
      flowId: 'flow-new',
      promptId: 'prompt-b',
      providerId: 'anthropic',
      prompt: { type: 'secret', message: 'newer prompt' },
    })
    receiveProviderAuthEvent({
      type: 'notification',
      flowId: 'flow-dismissed',
      providerId: 'openai',
      event: 'dismiss me',
    })
    dismissProviderAuthFlow('flow-dismissed')

    restoreProviderAuthFlows([
      {
        flowId: 'flow-new',
        providerId: 'anthropic',
        event: {
          type: 'prompt',
          flowId: 'flow-new',
          promptId: 'prompt-a',
          providerId: 'anthropic',
          prompt: { type: 'secret', message: 'stale prompt' },
        },
        notifications: [],
        response: 'credential-must-not-leak',
      },
      {
        flowId: 'flow-dismissed',
        providerId: 'openai',
        event: { type: 'notification', flowId: 'flow-dismissed', providerId: 'openai', event: 'come back' },
        notifications: [],
      },
      {
        flowId: 'flow-restored',
        providerId: 'google',
        event: {
          type: 'notification',
          flowId: 'flow-restored',
          providerId: 'google',
          event: { kind: 'open_url', url: 'https://example.test/device' },
        },
        notifications: ['opened'],
      },
    ], recovery)

    const flows = getManagementEventSnapshot().flows
    expect(flows['flow-new']?.event).toMatchObject({ promptId: 'prompt-b' })
    expect(flows['flow-dismissed']).toBeUndefined()
    expect(flows['flow-restored']?.event).toMatchObject({ type: 'notification' })
    expect(flows['flow-restored']?.notifications).toEqual(['opened'])
    expect(JSON.stringify(flows)).not.toContain('credential-must-not-leak')
  })

  it('ignores a snapshot from a recovery that is no longer current', () => {
    const stale = beginProviderAuthRecovery()
    const current = beginProviderAuthRecovery()
    const item = {
      flowId: 'flow-restored',
      providerId: 'google',
      event: { type: 'notification', flowId: 'flow-restored', providerId: 'google', event: 'hello' },
      notifications: [],
    }
    restoreProviderAuthFlows([item], stale)
    expect(getManagementEventSnapshot().flows['flow-restored']).toBeUndefined()
    restoreProviderAuthFlows([item], current)
    expect(getManagementEventSnapshot().flows['flow-restored']?.event).toMatchObject({ event: 'hello' })
  })

  it('does not clear prompt B when the response for prompt A is applied after B arrived', () => {
    const promptA = {
      type: 'prompt' as const,
      flowId: 'flow-1',
      promptId: 'prompt-a',
      providerId: 'anthropic',
      prompt: { type: 'secret', message: 'First step' },
    }
    const promptB = {
      type: 'prompt' as const,
      flowId: 'flow-1',
      promptId: 'prompt-b',
      providerId: 'anthropic',
      prompt: { type: 'secret', message: 'Second step' },
    }
    receiveProviderAuthEvent(promptA)
    receiveProviderAuthEvent(promptB)
    clearProviderAuthEvent('flow-1', promptA)
    expect(getManagementEventSnapshot().flows['flow-1']?.event).toMatchObject({ promptId: 'prompt-b' })
    clearProviderAuthEvent('flow-1', promptB)
    expect(getManagementEventSnapshot().flows['flow-1']?.event).toBeUndefined()
  })

  it('stores package progress and resource revisions independently', () => {
    receivePackageProgress({ commandId: 'package-1', workspacePath: '/repo', type: 'progress', action: 'install', source: 'pkg', message: 'downloading' })
    receiveResourceRevision('/repo', 'revision-2')
    expect(getManagementEventSnapshot().packageProgress['package-1'].message).toBe('downloading')
    expect(getManagementEventSnapshot().resourceRevisions['/repo']).toBe('revision-2')
  })
})
