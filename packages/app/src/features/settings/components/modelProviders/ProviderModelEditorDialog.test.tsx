import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blankModelDraft } from './providerTypes'
import { ProviderModelEditorDialog } from './ProviderModelEditorDialog'
import { lookupModelsDevModel } from '../../../../omp/transport/index.js'
import type { PiModelsDevLookupResult } from '../../../../omp/domain/index.js'

vi.mock('../../../../omp/transport/index.js', () => ({
  lookupModelsDevModel: vi.fn(),
}))

function pendingLookup() {
  let resolve!: (result: PiModelsDevLookupResult) => void
  const promise = new Promise<PiModelsDevLookupResult>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function renderEditor(overrides: Partial<ComponentProps<typeof ProviderModelEditorDialog>> = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  const props: ComponentProps<typeof ProviderModelEditorDialog> = {
    isOpen: true,
    providerName: 'Demo relay',
    model: null,
    siblings: [],
    onClose,
    onSave,
    ...overrides,
  }
  const view = render(<ProviderModelEditorDialog {...props} />)
  return {
    onSave,
    onClose,
    rerender: (next: Partial<typeof props>) => view.rerender(<ProviderModelEditorDialog {...props} {...next} />),
  }
}

describe('ProviderModelEditorDialog', () => {
  beforeEach(() => {
    vi.mocked(lookupModelsDevModel).mockReset().mockResolvedValue({ found: false })
  })

  it.each([true, false])('blocks saving a seeded new model on opening (initially open: %s)', async initiallyOpen => {
    const pending = pendingLookup()
    vi.mocked(lookupModelsDevModel).mockReturnValueOnce(pending.promise)
    const { onSave, rerender } = renderEditor({ isOpen: initiallyOpen, model: blankModelDraft('gpt-seeded') })
    if (!initiallyOpen) rerender({ isOpen: true })

    expect(lookupModelsDevModel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('blocks saving when smart config is enabled and ignores a cancelled lookup', async () => {
    const pending = pendingLookup()
    vi.mocked(lookupModelsDevModel).mockReturnValueOnce(pending.promise)
    renderEditor({ model: { ...blankModelDraft('gpt-seeded'), originalId: 'gpt-seeded' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Smart config' }))
    expect(lookupModelsDevModel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    const contextWindow = (screen.getByLabelText(/Context window/) as HTMLInputElement).value
    fireEvent.click(screen.getByRole('switch', { name: 'Smart config' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(vi.mocked(lookupModelsDevModel).mock.calls[0]![1]!.aborted).toBe(true)
    await act(async () => pending.resolve({ found: true, contextWindow: 999_999 }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(Number(contextWindow))
  })

  it.each([
    { providerId: 'other-provider' },
    { providerApi: 'openai-responses' },
    { model: blankModelDraft('gpt-other') },
    { model: blankModelDraft('gpt-seeded') },
  ])('marks a new lookup pending when editor inputs change: %j', async next => {
    const previous = pendingLookup()
    const current = pendingLookup()
    vi.mocked(lookupModelsDevModel).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const { rerender } = renderEditor({
      providerId: 'demo',
      providerApi: 'openai-completions',
      model: blankModelDraft('gpt-seeded'),
    })
    const oldSignal = vi.mocked(lookupModelsDevModel).mock.calls[0]![1]!
    rerender(next)
    expect(lookupModelsDevModel).toHaveBeenCalledTimes(2)
    expect(lookupModelsDevModel).toHaveBeenLastCalledWith(
      {
        modelId: next.model?.id ?? 'gpt-seeded',
        providerHint: next.providerId ?? 'demo',
        api: next.providerApi ?? 'openai-completions',
      },
      expect.any(AbortSignal),
    )
    expect(oldSignal.aborted).toBe(true)
    await act(async () => previous.resolve({ found: true, contextWindow: 999_999 }))
    expect(screen.getByLabelText(/Context window/)).not.toHaveValue(999_999)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await act(async () => current.resolve({ found: false }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it.each([{ providerId: 'other-provider' }, { providerApi: 'openai-responses' }])(
    'blocks saving on provider identity changes after the previous lookup finishes: %j',
    async next => {
      const pending = pendingLookup()
      vi.mocked(lookupModelsDevModel).mockResolvedValueOnce({ found: false }).mockReturnValueOnce(pending.promise)
      const { rerender } = renderEditor({
        providerId: 'demo',
        providerApi: 'openai-completions',
        model: blankModelDraft('gpt-seeded'),
      })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
      rerender(next)
      expect(lookupModelsDevModel).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      await act(async () => {})
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    },
  )

  it('starts with smart config enabled, applies defaults and looks up model metadata', async () => {
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-opus-4-6' } })
    expect(screen.getByLabelText(/Context window/)).toHaveValue(1_000_000)
    expect(screen.getByLabelText(/Max output tokens/)).toHaveValue(128_000)
    await waitFor(() =>
      expect(lookupModelsDevModel).toHaveBeenCalledWith({ modelId: 'claude-opus-4-6' }, expect.any(AbortSignal)),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      id: 'claude-opus-4-6',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
    })
  })

  it('does not look up model metadata while smart config is disabled', async () => {
    renderEditor()
    fireEvent.click(screen.getByRole('switch', { name: 'Smart config' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-opus-4-6' } })
    expect(screen.getByLabelText(/Context window/)).toHaveValue(128_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lookupModelsDevModel).not.toHaveBeenCalled()
  })

  it('shows no fabricated reasoning levels when metadata only declares support', async () => {
    vi.mocked(lookupModelsDevModel).mockResolvedValueOnce({ found: true, reasoning: true, thinking: null })
    renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'glm-reasoner' } })
    await waitFor(() =>
      expect(screen.getByText('The model supports reasoning but lists no configurable levels.')).toBeVisible(),
    )
    expect(screen.queryByRole('button', { name: 'minimal' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Reasoning model' })).toHaveAttribute('aria-checked', 'true')
  })

  it('preserves an existing model until smart config is explicitly enabled', async () => {
    const model = {
      ...blankModelDraft('claude-opus-4-6'),
      originalId: 'claude-opus-4-6',
      name: 'Custom Claude',
      contextWindow: 200_000,
      maxTokens: 16_000,
      reasoning: false,
    }
    const { onSave } = renderEditor({ model })
    await act(async () => {})
    expect(lookupModelsDevModel).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: 'Smart config' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(model)
  })

  it('fills exact levels, preserves a custom name and clears an old parameter map', async () => {
    vi.mocked(lookupModelsDevModel).mockResolvedValueOnce({
      found: true,
      name: 'Catalog name',
      reasoning: true,
      thinking: { mode: 'anthropic-adaptive', efforts: ['low', 'high', 'max'], defaultLevel: 'high' },
    })
    const { onSave } = renderEditor({
      providerApi: 'anthropic-messages',
      model: { ...blankModelDraft('claude-opus-4-6'), name: 'My Claude', effortMap: { high: 'old-value' } },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'max' })).toBeVisible())
    expect(screen.getByLabelText('Display name')).toHaveValue('My Claude')
    expect(screen.getByLabelText('Reasoning parameter map')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      name: 'My Claude',
      thinkingConfigured: true,
      thinkingMode: 'anthropic-adaptive',
      efforts: ['low', 'high', 'max'],
      effortMap: {},
    })
  })

  it('does not overwrite manual edits with a late lookup result', async () => {
    const pending = pendingLookup()
    vi.mocked(lookupModelsDevModel).mockReturnValueOnce(pending.promise)
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'gpt-5.4' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Context window/), { target: { value: '64000' } })
    await act(async () => pending.resolve({ found: true, contextWindow: 1_050_000 }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(64_000)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave.mock.calls[0]![0]).toMatchObject({ contextWindow: 64_000 })
  })

  it('ignores the previous model lookup after switching IDs', async () => {
    const pending = pendingLookup()
    vi.mocked(lookupModelsDevModel)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ found: true, reasoning: true, thinking: null, contextWindow: 202_752 })
    renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'gpt-5.4' } })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'glm-5' } })
    await waitFor(() => expect(screen.getByLabelText(/Context window/)).toHaveValue(202_752))
    await act(async () => pending.resolve({ found: true, contextWindow: 1_050_000 }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(202_752)
    await waitFor(() =>
      expect(screen.getByText('The model supports reasoning but lists no configurable levels.')).toBeVisible(),
    )
  })

  it('restores the original draft and cancels lookup when reset is clicked', async () => {
    const pending = pendingLookup()
    vi.mocked(lookupModelsDevModel).mockReturnValueOnce(pending.promise)
    const model = { ...blankModelDraft('gpt-5.4'), originalId: 'gpt-5.4', contextWindow: 64_000 }
    renderEditor({ model })
    fireEvent.click(screen.getByRole('switch', { name: 'Smart config' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset form' }))
    await act(async () => pending.resolve({ found: true, contextWindow: 1_050_000 }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(64_000)
    expect(screen.getByRole('switch', { name: 'Smart config' })).toHaveAttribute('aria-checked', 'false')
    expect(lookupModelsDevModel).toHaveBeenCalledTimes(1)
  })

  it('clears old reasoning metadata when changing to an unknown model', async () => {
    vi.mocked(lookupModelsDevModel)
      .mockResolvedValueOnce({
        found: true,
        reasoning: true,
        thinking: { mode: 'effort', efforts: ['low', 'high'], defaultLevel: 'high' },
      })
      .mockResolvedValueOnce({ found: false })
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'gpt-5.4' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'unknown-model' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave.mock.calls[0]![0]).toMatchObject({ reasoning: false, thinkingConfigured: false, effortMap: {} })
  })

  it('rejects a duplicate model id instead of saving', async () => {
    const sibling = { ...blankModelDraft('duplicate-id'), originalId: 'duplicate-id' }
    const { onSave } = renderEditor({ siblings: [sibling] })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'duplicate-id' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('A model with this ID already exists for the provider')
  })

  it('rejects an invalid reasoning parameter map', () => {
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'new-model' } })
    fireEvent.change(screen.getByLabelText('Reasoning parameter map'), { target: { value: '[1, 2]' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Reasoning parameter map must be a valid JSON object')
  })
})
