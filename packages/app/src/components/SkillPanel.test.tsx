import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillPanel } from './SkillPanel'

const getSkillsMock = vi.fn()
const getDetailsMock = vi.fn()
vi.mock('../omp/transport/index.js', () => ({
  getPiSkills: (...args: unknown[]) => getSkillsMock(...args),
  getPiSkillDetails: (...args: unknown[]) => getDetailsMock(...args),
}))
vi.mock('../utils', () => ({ apiErrorHandler: vi.fn() }))

const skill = {
  name: 'deploy-to-vercel', description: 'Deploy app to Vercel',
  filePath: '/skills/deploy-to-vercel/SKILL.md', baseDir: '/skills/deploy-to-vercel',
  sourceInfo: { origin: 'top-level', source: 'user' }, disableModelInvocation: false,
}
async function expandSkill() {
  fireEvent.click(await screen.findByRole('button', { name: /deploy-to-vercel/i }))
}
function expandParameters() {
  fireEvent.click(screen.getByRole('button', { name: /其他参数|Other parameters/ }))
}

describe('SkillPanel', () => {
  beforeEach(() => {
    getSkillsMock.mockReset().mockResolvedValue([skill])
    getDetailsMock.mockReset().mockResolvedValue({ frontmatter: { name: skill.name, description: skill.description } })
  })

  it('keeps a native dependency failure visible instead of suggesting a writer', async () => {
    getSkillsMock.mockRejectedValue(new Error('OMP_SOURCE_MISSING: matching sources unavailable'))
    render(<SkillPanel sessionId="cold-session" />)
    expect(await screen.findByText(/OMP_SOURCE_MISSING/)).toBeInTheDocument()
    expect(screen.queryByText(/Send a message|发送一条消息/)).not.toBeInTheDocument()
  })

  it('shows only primary metadata first and reads other parameters on demand', async () => {
    render(<SkillPanel sessionId="session-1" />)
    await expandSkill()
    const table = screen.getByRole('table', { name: skill.name })
    expect(within(table).getByText(skill.description)).toBeInTheDocument()
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByText(skill.filePath)).not.toBeInTheDocument()
    const secondary = screen.getByRole('button', { name: /其他参数|Other parameters/ })
    expect(secondary).toHaveAttribute('aria-expanded', 'false')
    expect(getDetailsMock).not.toHaveBeenCalled()
    expandParameters()
    expect(await screen.findByText(/没有其他参数|No other parameters/)).toBeInTheDocument()
    expect(screen.getByText(skill.filePath)).toBeInTheDocument()
    expect(getDetailsMock).toHaveBeenCalledWith('session-1', skill, expect.any(AbortSignal))
    fireEvent.click(secondary)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByText(skill.filePath)).not.toBeInTheDocument()
    fireEvent.click(secondary)
    expect(getDetailsMock).toHaveBeenCalledTimes(1)
  })

  it('preserves arbitrary keys, multiline values, empty values and safe text', async () => {
    const description = '执行 shell 命令、读写文件。\n无需用户手动复制输出。'
    getDetailsMock.mockResolvedValue({ frontmatter: {
      name: skill.name, description, 'allowed-tools': ['Read', 'Bash'],
      custom: { enabled: false, retries: 0, missing: null, blank: '', nested: { label: '<script>alert(1)</script>' } },
      tags: [], options: {}, source: 'custom frontmatter source',
    } })
    render(<SkillPanel sessionId="session-1" />)
    await expandSkill()
    expandParameters()
    expect(await screen.findByText('allowed-tools')).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    for (const value of ['false', '0', 'null', '<script>alert(1)</script>', 'custom frontmatter source']) expect(screen.getByText(value)).toBeInTheDocument()
    expect(screen.getByText(/空字符串|Empty string/)).toBeInTheDocument()
    expect(screen.getByText(/空列表|Empty list/)).toBeInTheDocument()
    expect(screen.getByText(/空对象|Empty object/)).toBeInTheDocument()
    expect(screen.getByRole('table').querySelectorAll('td')[1].textContent).toBe(description)
    expect(document.querySelector('script')).toBeNull()
  })

  it('keeps an explicit false invocation flag and does not invent missing discovery values', async () => {
    getSkillsMock.mockResolvedValue([{ ...skill, hide: true, sourceInfo: undefined, source: undefined }])
    render(<SkillPanel sessionId="session-1" />)
    await expandSkill()
    expandParameters()
    expect(await screen.findByText(/允许|Allowed/)).toBeInTheDocument()
    expect(screen.queryByText(/禁用|Disabled/)).not.toBeInTheDocument()
    expect(screen.queryByText('sourceInfo.source')).not.toBeInTheDocument()
  })

  it('keeps errors separate from empty metadata and allows retry', async () => {
    getDetailsMock.mockRejectedValueOnce(new Error('SKILL_FRONTMATTER_INVALID'))
    render(<SkillPanel sessionId="session-1" />)
    await expandSkill()
    expandParameters()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/没有其他参数|No other parameters/)).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }))
    expect(await screen.findByText(/没有其他参数|No other parameters/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('aborts old details when changing sessions and ignores a late response', async () => {
    let resolve!: (value: unknown) => void
    getDetailsMock.mockReturnValueOnce(new Promise(yes => { resolve = yes }))
    const view = render(<SkillPanel sessionId="session-1" />)
    await expandSkill()
    expandParameters()
    const signal = getDetailsMock.mock.calls[0][2] as AbortSignal
    view.rerender(<SkillPanel sessionId="session-2" />)
    await expandSkill()
    expect(signal.aborted).toBe(true)
    await act(async () => { resolve({ frontmatter: { description: 'stale description', leaked: true } }) })
    expect(screen.queryByText('stale description')).not.toBeInTheDocument()
    expect(screen.queryByText('leaked')).not.toBeInTheDocument()
  })

  it('invalidates details after a registry refresh', async () => {
    render(<SkillPanel sessionId="session-1" />)
    await expandSkill()
    expandParameters()
    await screen.findByText(/没有其他参数|No other parameters/)
    await act(async () => { window.dispatchEvent(new CustomEvent('ompiui:registry-updated', { detail: { sessionId: 'session-1' } })) })
    await expandSkill()
    expect(screen.queryByText(skill.filePath)).not.toBeInTheDocument()
    expandParameters()
    await screen.findByText(/没有其他参数|No other parameters/)
    expect(getDetailsMock).toHaveBeenCalledTimes(2)
  })
})
