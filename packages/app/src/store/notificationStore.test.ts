import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

// Exercise constructor-time history recovery; static imports would initialize before the stored fixture is installed.
it('restores native link history with a supported informational severity', async () => {
  const { serverStorage } = await import('../utils/perServerStorage')
  serverStorage.set('ompiui:notifications', JSON.stringify([
    { id: 'native-link', type: 'link', title: 'Extension', body: 'https://example.invalid/native-help', sessionId: 'native-session', timestamp: 1, read: false, target: 'extensions' },
    { id: 'native-error', type: 'error', title: 'Native error', body: 'Original failure', sessionId: 'native-session', timestamp: 2, read: true },
  ]))
  const { notificationStore } = await import('./notificationStore')
  expect(notificationStore.getSnapshot().notifications).toMatchObject([
    { id: 'native-link', type: 'info', body: 'https://example.invalid/native-help', read: false, target: 'extensions' },
    { id: 'native-error', type: 'error', body: 'Original failure', read: true },
  ])
})
