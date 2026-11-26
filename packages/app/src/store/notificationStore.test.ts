import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

it('applies a shared snapshot without persisting it or replaying a toast, then sends user changes to the backend', async () => {
  const { notificationStore } = await import('./notificationStore')
  const { serverStorage } = await import('../utils/perServerStorage')
  const change = vi.fn(async () => {})
  const announce = vi.fn()
  const off = notificationStore.onPush(announce)
  notificationStore.onSharedChange(change)
  const entry = { id: 'run-1', type: 'completed' as const, title: 'Task', body: '', sessionId: 'session-1', timestamp: 1, read: false }
  try {
    notificationStore.replaceShared([entry], new Set())
    expect(notificationStore.getSnapshot().notifications).toEqual([entry])
    expect(notificationStore.getSnapshot().toasts).toEqual([])
    expect(announce).not.toHaveBeenCalled()
    notificationStore.markRead(entry.id)
    expect(change).toHaveBeenLastCalledWith({ action: 'markRead', id: entry.id })
    notificationStore.replaceShared([{ ...entry, read: true }], new Set())
    expect(notificationStore.getSnapshot().notifications[0]?.read).toBe(true)
    notificationStore.clearAll()
    expect(change).toHaveBeenLastCalledWith({ action: 'clear' })
    expect(JSON.parse(serverStorage.get('ompiui:notifications') ?? '[]')).toEqual([])
  } finally {
    off()
  }
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
