import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { trafficAuditStore } from '../../../omp/trafficAudit/store'
import { TrafficAuditSettings } from './TrafficAuditSettings'

const { saveDataMock } = vi.hoisted(() => ({ saveDataMock: vi.fn() }))
vi.mock('../../../hooks/useServerStore', () => ({
  useServerStore: () => ({ activeServer: { id: 'remote', url: 'http://remote.test', name: 'Remote' } }),
}))
vi.mock('../../../utils/downloadUtils', () => ({ saveData: saveDataMock }))

function addRequest(path: string, bytes = 10, server = 'http://remote.test') {
  const handle = trafficAuditStore.start(`${server}${path}`, {
    protocol: 'http',
    direction: 'exchange',
    operation: 'GET',
    status: 'pending',
    sentBytes: 0,
    receivedBytes: null,
    attempt: 1,
  })
  trafficAuditStore.update(handle, { status: 'complete', statusCode: 200, receivedBytes: bytes, durationMs: 12 })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  trafficAuditStore.setEnabled(true)
  trafficAuditStore.setPreviews(false)
  trafficAuditStore.clear()
  saveDataMock.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TrafficAuditSettings', () => {
  it('shows current-server traffic, expands details and searches requests', () => {
    addRequest('/api/branch', 1024)
    addRequest('/api/models', 7)
    addRequest('/api/other', 999, 'http://other.test')
    render(<TrafficAuditSettings />)
    const list = screen.getByRole('list', { name: 'Requests and messages' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('http://other.test/api/other')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /Search URL/ }), { target: { value: 'branch' } })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(within(list).getByRole('button'))
    expect(screen.queryByText('Response headers time')).not.toBeInTheDocument()
    expect(screen.queryByText('Declared length', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('Duration', { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/No preview retained/)).toBeInTheDocument()
  })

  it('pauses capture, clears records and toggles previews with the shared switches', () => {
    addRequest('/api/read')
    render(<TrafficAuditSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Record traffic' }))
    expect(trafficAuditStore.isEnabled()).toBe(false)
    expect(screen.getByText('Paused', { exact: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Keep payload previews' }))
    expect(trafficAuditStore.getSnapshot().previews).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clear audit records' }))
    expect(screen.getByText('No requests recorded')).toBeInTheDocument()
  })

  it('limits displayed records to a page and exports all filtered records rather than only that page', () => {
    for (let i = 0; i < 55; i++) addRequest(`/api/read/${i}`)
    render(<TrafficAuditSettings />)
    const list = screen.getByRole('list', { name: 'Requests and messages' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(50)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Export filtered records' }))
    const report = JSON.parse(new TextDecoder().decode(saveDataMock.mock.calls[0][0]))
    expect(report.records).toHaveLength(55)
    expect(report.scope).toContain('Current client')
    expect(report.totals.httpRequests).toBe(55)
  })

  it('updates live and isolates failed requests with the checkbox', async () => {
    render(<TrafficAuditSettings />)
    act(() => {
      addRequest('/api/good')
      const handle = trafficAuditStore.start('http://remote.test/api/bad', {
        protocol: 'http',
        direction: 'exchange',
        operation: 'POST',
        status: 'pending',
        sentBytes: 2,
        receivedBytes: null,
      })
      trafficAuditStore.update(handle, { status: 'error', statusCode: 503 })
    })
    await act(async () => vi.advanceTimersByTime(500))
    fireEvent.click(screen.getByRole('button', { name: 'Filters and sorting' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Failed or cancelled only' }))
    const list = screen.getByRole('list', { name: 'Requests and messages' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('503')).toBeInTheDocument()
  })
})
