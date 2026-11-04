import { describe, expect, it, vi } from 'vitest'
import { getConnectionInfo, setEventStreamState } from './events'
import { serverStore } from '../store/serverStore'

describe('connection state', () => {
  it('does not report a healthy HTTP backend as connected while its subscribed event socket is down', () => {
    vi.spyOn(serverStore, 'getHealth').mockReturnValue({ status: 'online', lastCheck: 1 })
    try {
      setEventStreamState('disconnected', 10)
      expect(getConnectionInfo()).toMatchObject({ state: 'disconnected', reconnectAttempt: 10 })
      setEventStreamState('connecting', 10)
      expect(getConnectionInfo().state).toBe('connecting')
      setEventStreamState('connected')
      expect(getConnectionInfo().state).toBe('connected')
      setEventStreamState('unused')
      expect(getConnectionInfo().state).toBe('connected')
    } finally {
      setEventStreamState('unused')
      vi.restoreAllMocks()
    }
  })
})
