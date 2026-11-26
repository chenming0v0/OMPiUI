import { describe, expect, it } from 'vitest'
import { selectDshHosts } from './dshRemote'

const client = '3f2a6c1e-8b4d-4f7a-9c2e-1d5b7a9c0e11'
const host = '7c1d3e5f-2a4b-4c6d-8e0f-1a3b5c7d9e22'

describe('DS Harness Remote host selection', () => {
  it('keeps only work computers that are not this device', () => {
    const hosts = selectDshHosts([
      { deviceId: host, name: 'Desk PC', role: 'host', online: true },
      { deviceId: client, name: 'This phone', role: 'client', online: true },
      { deviceId: 'aa11bb22-cc33-dd44-ee55-ff6677889900', name: 'Other phone', role: 'client' },
    ], client)
    expect(hosts).toEqual([{ id: host, name: 'Desk PC', online: true }])
  })

  it('treats a missing role as a host for older services but filters an explicit role', () => {
    const hosts = selectDshHosts([
      { deviceId: host, name: 'Desk PC' },
      { deviceId: 'aa11bb22-cc33-dd44-ee55-ff6677889900', name: 'Tablet', role: 'client' },
    ], client)
    expect(hosts).toEqual([{ id: host, name: 'Desk PC', online: undefined }])
  })

  it('never returns this device even when it is reported as a host', () => {
    expect(selectDshHosts([{ deviceId: client, name: 'This PC', role: 'host' }], client)).toEqual([])
  })

  it('rejects a host entry without a usable name', () => {
    expect(() => selectDshHosts([{ deviceId: host, role: 'host' }], client)).toThrow(/host/)
    expect(() => selectDshHosts([{ deviceId: host, name: '  ', role: 'host' }], client)).toThrow(/host/)
  })
})
