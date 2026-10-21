import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchModelProviderModels } from '../../../../omp/transport/index.js'
import { blankModelDraft, type ProviderDraft } from './providerTypes'
import { ProviderModelPickerDialog } from './ProviderModelPickerDialog'

const viewport = vi.hoisted(() => ({ mobile: true }))
vi.mock('../../../../hooks', () => ({ useIsMobile: () => viewport.mobile }))
vi.mock('../../../../omp/transport/index.js', () => ({ fetchModelProviderModels: vi.fn() }))

const initialProvider: ProviderDraft = {
  id: 'demo',
  name: 'Demo',
  baseUrl: 'https://example.test/v1',
  apiKey: '',
  api: 'openai-responses',
  models: [blankModelDraft('gpt-existing'), blankModelDraft('local-only')],
}

function LivePicker() {
  const [provider, setProvider] = useState(initialProvider)
  return (
    <ProviderModelPickerDialog
      isOpen
      provider={provider}
      onClose={vi.fn()}
      onAddModels={ids =>
        setProvider(current => ({
          ...current,
          models: [...current.models, ...ids.map(id => blankModelDraft(id))],
        }))
      }
      onRemoveModels={ids =>
        setProvider(current => ({
          ...current,
          models: current.models.filter(model => !ids.includes(model.id)),
        }))
      }
    />
  )
}

describe('ProviderModelPickerDialog responsive flows', () => {
  beforeEach(() => {
    viewport.mobile = true
    vi.mocked(fetchModelProviderModels)
      .mockReset()
      .mockResolvedValue({
      models: ['gpt-existing', 'gpt-new', 'claude-new'],
      removed: ['local-only'],
      total: 3,
      })
  })

  it('keeps the mobile sheet and query open after adding and removing without refetching', async () => {
    render(<LivePicker />)
    await screen.findByRole('button', { name: 'Add model gpt-new' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: 'gpt-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add model gpt-new' }))
    expect(screen.getByRole('button', { name: 'Delete model gpt-new' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Filter by model name' })).toHaveValue('gpt-new')
    fireEvent.click(screen.getByRole('button', { name: 'Delete model gpt-new' }))
    expect(screen.getByRole('button', { name: 'Add model gpt-new' })).toBeVisible()
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(1)
  })

  it('adds only filtered unconfigured models and keeps local-only models visible', async () => {
    render(<LivePicker />)
    await screen.findByRole('button', { name: 'Add model gpt-new' })
    expect(screen.getByRole('button', { name: 'Delete model local-only' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: 'gpt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select all (1)' }))
    expect(screen.getByRole('button', { name: 'Delete model gpt-new' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Add model claude-new' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete model gpt-existing' })).toBeVisible()
  })

  it('keeps desktop selection staged until confirmation', async () => {
    viewport.mobile = false
    const onAddModels = vi.fn()
    render(
      <ProviderModelPickerDialog
        isOpen
        provider={initialProvider}
        onClose={vi.fn()}
        onAddModels={onAddModels}
        onRemoveModels={vi.fn()}
      />,
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search models' }), {
      target: { value: 'gpt-new' },
    })
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'gpt-new' })).toBeVisible())
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'gpt-new' }))
    expect(onAddModels).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add selected' }))
    expect(onAddModels).toHaveBeenCalledWith(['gpt-new'])
  })
})
