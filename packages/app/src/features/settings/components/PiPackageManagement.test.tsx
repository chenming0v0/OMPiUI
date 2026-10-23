import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiPackageManagement } from './PiPackageManagement'

const { manageMock, checkUpdatesMock } = vi.hoisted(() => ({ manageMock: vi.fn(), checkUpdatesMock: vi.fn() }))
const snapshot = {
  packages: [{ source: 'fixture@local', scope: 'user', enabled: true, type: 'marketplace', version: '1.0.0', installedPath: '/plugins/fixture' }],
  marketplaces: [],
}

vi.mock('../../../omp/transport/index.js', () => ({
  listPiPackages: vi.fn(async () => snapshot),
  managePiPackage: (...args: unknown[]) => manageMock(...args),
  checkPiPackageUpdates: (...args: unknown[]) => checkUpdatesMock(...args),
  changePiPackageSource: vi.fn(),
  getPiPackageInstalledPath: vi.fn(),
  resolvePiExtensionSources: vi.fn(),
  resolvePiPackages: vi.fn(),
}))

describe('native package management', () => {
  beforeEach(() => {
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
