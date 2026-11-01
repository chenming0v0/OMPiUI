import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillPanel } from './SkillPanel'

const getSkillsMock = vi.fn()

vi.mock('../omp/transport/index.js', () => ({
  getPiSkills: (...args: unknown[]) => getSkillsMock(...args),
}))

vi.mock('../utils', () => ({
  apiErrorHandler: vi.fn(),
}))

describe('SkillPanel', () => {
  beforeEach(() => {
    getSkillsMock.mockReset()
    getSkillsMock.mockResolvedValue([
      {
        name: 'deploy-to-vercel',
        description: 'Deploy app to Vercel',
        filePath: '/skills/deploy-to-vercel/SKILL.md',
        baseDir: '/skills/deploy-to-vercel',
        sourceInfo: { origin: 'top-level', source: 'user' },
        disableModelInvocation: false,
      },
    ])
  })

  it('keeps a native dependency failure visible instead of saying the session must be started', async () => {
    getSkillsMock.mockRejectedValue(Object.assign(new Error('OMP_SOURCE_MISSING: matching sources unavailable'), { code: 'CAPABILITY_DISABLED' }))
    render(<SkillPanel sessionId="cold-session" />)
    expect(await screen.findByText(/OMP_SOURCE_MISSING/)).toBeInTheDocument()
    expect(screen.queryByText(/Send a message|发送一条消息/)).not.toBeInTheDocument()
  })

  it('expands the discovered skill to show its native path and details', async () => {
    render(<SkillPanel sessionId="session-1" />)
    const itemButton = await screen.findByRole('button', { name: /deploy-to-vercel/i })

    expect(itemButton).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(itemButton)

    expect(itemButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/baseDir/)).toBeInTheDocument()
    expect(screen.getByText('/skills/deploy-to-vercel/SKILL.md')).toBeInTheDocument()
  })
})
