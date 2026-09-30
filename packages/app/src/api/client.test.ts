import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentProject, getProjects } from './client'

const mocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(),
  getHostGitInfo: vi.fn(),
}))

vi.mock('../omp/transport/index.js', () => ({
  getHostGitInfo: mocks.getHostGitInfo,
}))
vi.mock('../omp/workspaces', () => ({
  resolveWorkspacePath: mocks.resolveWorkspacePath,
}))

describe('Pi project adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePath.mockResolvedValue('C:/work/OMPiUI')
  })

  it('maps the current workspace and Git state to a project', async () => {
    mocks.getHostGitInfo.mockResolvedValue({ root: true, branch: 'main', ahead: 0, behind: 0 })

    await expect(getCurrentProject('C:/work/OMPiUI')).resolves.toEqual({
      id: 'C:/work/OMPiUI',
      path: 'C:/work/OMPiUI',
      name: 'OMPiUI',
      gitRoot: 'C:/work/OMPiUI',
    })
    expect(mocks.getHostGitInfo).toHaveBeenCalledWith('C:/work/OMPiUI')
  })

  it('omits gitRoot outside a repository and tolerates git failures', async () => {
    mocks.getHostGitInfo.mockRejectedValue(new Error('not a repo'))

    await expect(getCurrentProject('C:/work/OMPiUI')).resolves.toEqual({
      id: 'C:/work/OMPiUI',
      path: 'C:/work/OMPiUI',
      name: 'OMPiUI',
      gitRoot: undefined,
    })
  })

  it('lists the selected directory as the only project', async () => {
    mocks.getHostGitInfo.mockResolvedValue({ root: false })

    await expect(getProjects('C:/work/OMPiUI')).resolves.toHaveLength(1)
    await expect(getProjects()).resolves.toEqual([])
  })

  it('fails when no workspace is available', async () => {
    mocks.resolveWorkspacePath.mockResolvedValue(null)

    await expect(getCurrentProject()).rejects.toThrow('No OMPiUI workspace is available')
  })
})
