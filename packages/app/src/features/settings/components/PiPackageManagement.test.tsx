import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiPackagesSnapshot } from '../../../omp/domain'
import { receivePackageProgress, receiveResourceRevision, resetManagementEvents } from '../../../omp/managementEventStore'
import { PiPackageManagement } from './PiPackageManagement'

vi.mock('../../../omp/eventStream', () => ({
  piEventStream: { connectWorkspace: vi.fn(), disconnectWorkspace: vi.fn() },
}))

const { listMock, manageMock, checkUpdatesMock } = vi.hoisted(() => ({ listMock: vi.fn(), manageMock: vi.fn(), checkUpdatesMock: vi.fn() }))
const snapshot: PiPackagesSnapshot = {
  packages: [{ source: 'fixture@local', scope: 'user', enabled: true, type: 'marketplace', version: '1.0.0', installedPath: '/plugins/fixture' }],
  marketplaces: [],
}

vi.mock('../../../omp/transport/index.js', () => ({
  listPiPackages: (...args: unknown[]) => listMock(...args),
  managePiPackage: (...args: unknown[]) => manageMock(...args),
  checkPiPackageUpdates: (...args: unknown[]) => checkUpdatesMock(...args),
  changePiPackageSource: vi.fn(),
  getPiPackageInstalledPath: vi.fn(),
  resolvePiExtensionSources: vi.fn(),
  resolvePiPackages: vi.fn(),
}))

describe('native package management', () => {
  beforeEach(() => {
    resetManagementEvents()
    listMock.mockReset().mockResolvedValue(snapshot)
    manageMock.mockReset()
    checkUpdatesMock.mockReset()
  })

  it('reports a failed enable change without pretending the plugin was disabled', async () => {
    manageMock.mockRejectedValue(new Error('Native registry is not writable'))
    render(<PiPackageManagement workspacePath="/workspace" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Native registry is not writable')
    expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
  })

  it('runs network update checks only after explicit user action and exposes errors', async () => {
    checkUpdatesMock.mockRejectedValue(new Error('Marketplace catalog fetch failed'))
    render(<PiPackageManagement workspacePath="/workspace" />)
    await screen.findByRole('button', { name: 'Disable' })
    expect(checkUpdatesMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check updates' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Marketplace catalog fetch failed'))
    expect(screen.getByText('fixture@local · 1.0.0')).toBeInTheDocument()
  })

  it('keeps the scoped snapshot unchanged while pending and applies only a completed mutation', async () => {
    let complete!: (value: typeof snapshot) => void
    manageMock.mockImplementation(() => new Promise<typeof snapshot>(resolve => { complete = resolve }))
    render(<PiPackageManagement workspacePath="/workspace" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Project scope' })).toBeDisabled()
    complete({ ...snapshot, packages: [{ ...snapshot.packages[0]!, enabled: false }] })
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shares scoped progress, terminal results and list refreshes between mounted clients', async () => {
    const first = render(<PiPackageManagement workspacePath="/workspace" />)
    const second = render(<PiPackageManagement workspacePath="/other" />)
    const a = within(first.container)
    const b = within(second.container)
    await a.findByRole('button', { name: 'Disable' })
    await b.findByRole('button', { name: 'Disable' })

    act(() => receivePackageProgress({ commandId: 'disable', action: 'disable', phase: 'started', workspacePath: '/workspace' }))
    expect(a.getByRole('button', { name: 'Disable' })).toBeDisabled()
    expect(b.getByRole('button', { name: 'Disable' })).toBeEnabled()
    listMock.mockImplementation(async (cwd: string) => cwd === '/workspace'
      ? { ...snapshot, packages: [{ ...snapshot.packages[0]!, enabled: false }] } : snapshot)
    act(() => {
      receivePackageProgress({ commandId: 'disable', action: 'disable', phase: 'completed', workspacePath: '/workspace' })
      receiveResourceRevision('/workspace', 'disabled')
    })
    expect(await a.findByRole('button', { name: 'Enable' })).toBeEnabled()
    expect(a.getByRole('status')).toHaveTextContent('does not reload running sessions')
    expect(b.getByRole('button', { name: 'Disable' })).toBeEnabled()

    listMock.mockResolvedValue({ ...snapshot, marketplaces: [{ name: 'new-market', source: '/market', sourceType: 'local', catalogPath: '/market/catalog.json' }] })
    act(() => {
      receivePackageProgress({ commandId: 'source', action: 'add-source', phase: 'completed' })
      receiveResourceRevision(undefined, 'source-added')
    })
    await a.findByText('new-market · /market')
    await b.findByText('new-market · /market')
    act(() => receivePackageProgress({ commandId: 'failed', action: 'install', phase: 'failed', message: 'Download failed' }))
    expect(b.getByRole('alert')).toHaveTextContent('Download failed')
    expect(checkUpdatesMock).not.toHaveBeenCalled()
  })

  it('restores an in-progress operation for a newly opened client', async () => {
    listMock.mockResolvedValue({ ...snapshot, activeOperations: [{ commandId: 'install', action: 'install', phase: 'started' }] })
    render(<PiPackageManagement workspacePath="/workspace" />)
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Processing plugin operation')
  })

  it('does not offer bulk mutation of an empty selected scope', async () => {
    render(<PiPackageManagement workspacePath="/workspace" />)
    await screen.findByRole('button', { name: 'Disable' })
    expect(screen.getByRole('button', { name: 'Update selected scope' })).toBeEnabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Project scope' }))
    expect(screen.getByRole('button', { name: 'Update selected scope' })).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Project scope' }))
    expect(screen.getByRole('button', { name: 'Update selected scope' })).toBeEnabled()
  })
})
