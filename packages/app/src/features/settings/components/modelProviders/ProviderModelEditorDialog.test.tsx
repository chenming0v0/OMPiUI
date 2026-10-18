import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { blankModelDraft } from './providerTypes'
import { ProviderModelEditorDialog } from './ProviderModelEditorDialog'

function renderEditor(overrides: Partial<ComponentProps<typeof ProviderModelEditorDialog>> = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(
    <ProviderModelEditorDialog
      isOpen
      providerName="Demo relay"
      model={null}
      siblings={[]}
      onClose={onClose}
      onSave={onSave}
      {...overrides}
    />,
  )
  return { onSave, onClose }
}

describe('ProviderModelEditorDialog', () => {
  it('applies smart defaults from the model id and saves the draft', () => {
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-opus-4-6' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Smart config' }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(1_000_000)
    expect(screen.getByLabelText(/Max output tokens/)).toHaveValue(128_000)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      id: 'claude-opus-4-6',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
    })
  })

  it('rejects a duplicate model id instead of saving', () => {
    const sibling = { ...blankModelDraft('duplicate-id'), originalId: 'duplicate-id' }
    const { onSave } = renderEditor({ siblings: [sibling] })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'duplicate-id' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A model with this ID already exists for the provider',
    )
  })

  it('rejects an invalid reasoning parameter map', () => {
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'new-model' } })
    fireEvent.change(screen.getByLabelText('Reasoning parameter map'), { target: { value: '[1, 2]' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reasoning parameter map must be a valid JSON object',
    )
  })
})
