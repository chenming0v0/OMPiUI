import { useId, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { NativeAskAnswer, NativeAskQuestion as Question } from '@ompiui/protocol'
import { CheckIcon } from '../../components/Icons'

export function NativeAskQuestion({ question, answer, custom, disabled, onChange, onCustomChange }: {
  question: Question
  answer: NativeAskAnswer
  custom: boolean
  disabled: boolean
  onChange: (answer: NativeAskAnswer) => void
  onCustomChange: (enabled: boolean) => void
}) {
  const { t } = useTranslation('components')
  const labelId = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`
  }, [answer.customInput, custom])
  const select = (label: string) => {
    if (question.multi) {
      onChange({ ...answer, selectedOptions: answer.selectedOptions.includes(label) ? answer.selectedOptions.filter(value => value !== label) : [...answer.selectedOptions, label] })
    } else {
      onChange({ ...answer, selectedOptions: [label], customInput: undefined })
      onCustomChange(false)
    }
  }
  const toggleCustom = () => {
    const enabled = !custom
    onCustomChange(enabled)
    onChange({ ...answer, ...(enabled && !question.multi ? { selectedOptions: [] } : {}), customInput: enabled ? '' : undefined })
  }
  const optionClass = (selected: boolean) => `inline-flex min-h-7 max-w-full items-start gap-1.5 rounded-md border px-2.5 py-1 text-[length:var(--fs-sm)] leading-5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ${selected ? 'border-text-100 text-text-100 bg-bg-300/40' : 'border-border-200/60 text-text-300 hover:border-text-400 hover:text-text-200'}`

  return <section className="space-y-2" aria-labelledby={labelId}>
    <div>
      {question.header && question.header !== question.question && <div className="mb-0.5 text-[length:var(--fs-xs)] font-medium text-text-400">{question.header}</div>}
      <div id={labelId} className="whitespace-pre-wrap break-words text-[length:var(--fs-md)] text-text-100">{question.question}</div>
    </div>
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
      {question.options.map((option, index) => {
        const selected = answer.selectedOptions.includes(option.label)
        return <button key={option.label} type="button" aria-pressed={selected} title={option.description} disabled={disabled} onClick={() => select(option.label)} className={optionClass(selected)}>
          {question.multi && <span aria-hidden="true" className="inline-flex h-5 w-3.5 shrink-0 items-center justify-center">
            <span className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border ${selected ? 'border-text-100 bg-text-100 text-bg-000' : 'border-border-300'}`}>
              {selected && <CheckIcon size={10} />}
            </span>
          </span>}
          <span className="min-w-0 whitespace-normal break-words">
            {option.label}{question.recommended === index && <span className="ml-1.5 text-[length:var(--fs-xs)] text-text-400">({t('dialog.recommended')})</span>}
            {option.description && <span className="block text-[length:var(--fs-xs)] text-text-400">{option.description}</span>}
          </span>
        </button>
      })}
      <button type="button" aria-pressed={custom} disabled={disabled} onClick={toggleCustom} className={`${optionClass(custom)} ${custom ? '' : 'border-dashed'}`}>{t('dialog.other')}</button>
    </div>
    {question.options.filter(option => option.preview && answer.selectedOptions.includes(option.label)).map(option => (
      <pre key={option.label} className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/40 px-2.5 py-2 font-mono text-[length:var(--fs-xs)] text-text-300">{option.preview}</pre>
    ))}
    {custom && <textarea
      ref={inputRef}
      aria-label={t('dialog.customInput')}
      placeholder={t('dialog.customInput')}
      value={answer.customInput ?? ''}
      disabled={disabled}
      onChange={event => onChange({ ...answer, customInput: event.target.value })}
      rows={1}
      autoFocus
      className="min-h-7 w-full resize-none overflow-y-auto rounded-md border border-border-200/60 bg-transparent px-2.5 py-1 text-[length:var(--fs-sm)] leading-5 text-text-100 placeholder:text-text-500 focus:border-text-400 focus:outline-none"
    />}
  </section>
}
