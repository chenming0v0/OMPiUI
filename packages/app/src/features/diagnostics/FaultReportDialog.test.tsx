import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FaultReportDialog } from './FaultReportDialog'
import { faultAuditStore } from '../../omp/faultAudit/store'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../omp/faultAudit/controller', () => ({ startFaultAudit: () => () => {}, collectFaultReport: vi.fn() }))
vi.mock('../../omp/faultAudit/storage', () => ({
  readSavedFault: () => undefined, readFullSavedFault: () => Promise.resolve(undefined), saveFault: vi.fn(),
}))
const save = vi.hoisted(() => vi.fn())
const copy = vi.hoisted(() => vi.fn())
vi.mock('../../utils/downloadUtils', () => ({ saveData: save }))
vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: copy }))

describe('fault report dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      faultAuditStore.detect({ id: crypto.randomUUID(), kind: 'connection_lost', time: new Date().toISOString() }, crypto.randomUUID())
    })
  })
  it('requires explicit upload consent and allows offline download and dismissal', () => {
    const upload = vi.spyOn(faultAuditStore, 'upload').mockResolvedValue()
    render(<FaultReportDialog />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'upload' })).toBeDisabled()
    expect(upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    expect(save).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'upload' }))
    expect(upload).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'later' }))
    expect(screen.getByRole('button', { name: 'reopen' })).toBeInTheDocument()
    upload.mockRestore()
  })
  it('offers a mobile-visible close button without losing the local report', () => {
    render(<FaultReportDialog />)
    const close = screen.getByRole('button', { name: 'common:close' })
    expect(close.className).not.toMatch(/\bhidden\b/)
    fireEvent.click(close)
    expect(faultAuditStore.getSnapshot().saved?.open).toBe(false)
    expect(screen.getByRole('button', { name: 'reopen' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
    expect(faultAuditStore.getSnapshot().saved?.open).toBe(true)
  })
})
