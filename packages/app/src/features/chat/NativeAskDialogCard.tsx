import { useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionUiDialogRequest, ExtensionUiDialogResponse, NativeAskAnswer } from '@ompiui/protocol'
import { extensionUiStore } from '../../omp/extensionUiStore'
import { respondPiExtensionUi } from '../../omp/controllers/index.js'

type Request = Extract<ExtensionUiDialogRequest, { kind: 'ask' }>

/** Consumes the official opt-in ask wire format, never a custom TUI component. */
export function NativeAskDialogCard({ request, compact, onCollapse }: {
  request: Request
  compact?: boolean
  onCollapse?: () => void
}) {
  const { t } = useTranslation(['common', 'components'])
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<NativeAskAnswer[]>(() => request.questions.map(question => ({ id: question.id, selectedOptions: [] })))
  const [custom, setCustom] = useState(() => request.questions.map(() => false))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const composing = useRef(false)
  const [responseId] = useState(() => crypto.randomUUID())
  const review = index === request.questions.length
  const question = request.questions[index]
  const answer = answers[index]
  const isValid = (position: number) => request.questions[position].multi || answers[position].selectedOptions.length === 1 || Boolean(answers[position].customInput?.trim())
  const updateAnswer = (patch: Partial<NativeAskAnswer>) => setAnswers(previous => previous.map((value, position) => position === index ? { ...value, ...patch } : value))
  const select = (label: string) => {
    if (question.multi) {
      updateAnswer({ selectedOptions: answer.selectedOptions.includes(label) ? answer.selectedOptions.filter(value => value !== label) : [...answer.selectedOptions, label] })
    } else {
      updateAnswer({ selectedOptions: [label], customInput: undefined })
      setCustom(previous => previous.map((value, position) => position === index ? false : value))
    }
  }
  const send = async (response: ExtensionUiDialogResponse) => {
    if (submittingRef.current || !extensionUiStore.getSnapshot().sessions[request.sessionId]?.pending.some(item => item.requestId === request.requestId && item.workerGeneration === request.workerGeneration)) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await respondPiExtensionUi(request.sessionId, request.requestId, { ...response, responseId })
      extensionUiStore.requestSettled(request.sessionId, request.requestId, request.workerGeneration)
    } catch (cause) {
      submittingRef.current = false
      setSubmitting(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || submitting) return
    if (event.key === 'Escape') {
      event.preventDefault()
      void send({ cancelled: true })
    }
  }
  return <div role="dialog" aria-label={t('components:dialog.ask')} onKeyDown={onKeyDown} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} className={`rounded-xl border border-border-200 bg-bg-100 shadow-float flex flex-col ${compact ? 'max-h-[55vh]' : 'max-h-[62vh]'}`}>
    <div className="flex items-center justify-between gap-2 px-4 py-2.5 shrink-0">
      <h3 className="font-medium text-text-100">{review ? t('components:dialog.reviewAnswers') : t('components:dialog.questionProgress', { current: index + 1, total: request.questions.length })}</h3>
      {onCollapse && <button type="button" onClick={onCollapse} title={t('components:dialog.minimize')}>−</button>}
    </div>
    <div className="px-4 py-3 flex flex-col gap-3 min-h-0 overflow-y-auto custom-scrollbar">
      {review ? answers.map((value, position) => <section key={value.id} className="whitespace-pre-wrap break-words">
        <button type="button" disabled={submitting} onClick={() => setIndex(position)} className="font-medium text-text-100 underline">{request.questions[position].question}</button>
        <p className="text-text-200">{value.selectedOptions.join(', ')}{value.customInput ? `\n${value.customInput}` : ''}</p>
      </section>) : <>
        {question.header && <span className="text-text-400">{question.header}</span>}
        <p className="whitespace-pre-wrap break-words text-text-100">{question.question}</p>
        <div role="group" aria-label={question.question} className="flex flex-col gap-2">
          {question.options.map((option, position) => <label key={position} className="flex items-start gap-2 cursor-pointer rounded-md border border-border-200 p-2">
            <input type={question.multi ? 'checkbox' : 'radio'} name={request.requestId + question.id} checked={answer.selectedOptions.includes(option.label)} disabled={submitting} onChange={() => select(option.label)} />
            <span className="min-w-0 whitespace-pre-wrap break-words text-text-200">{option.label}{question.recommended === position && <span className="ml-2 text-accent-main-100">({t('components:dialog.recommended')})</span>}
              {option.description && <span className="block text-text-400">{option.description}</span>}
              {option.preview && <span className="block font-mono text-text-400">{option.preview}</span>}
            </span>
          </label>)}
          <label className="flex items-center gap-2 text-text-200"><input type={question.multi ? 'checkbox' : 'radio'} name={request.requestId + question.id} checked={custom[index]} disabled={submitting} onChange={() => {
            const enabled = !custom[index]
            setCustom(previous => previous.map((value, position) => position === index ? enabled : value))
            updateAnswer({ ...(enabled && !question.multi ? { selectedOptions: [] } : {}), customInput: enabled ? '' : undefined })
          }} />{t('components:dialog.other')}</label>
        </div>
        {custom[index] && <label className="text-text-300">{t('components:dialog.customInput')}<textarea aria-label={t('components:dialog.customInput')} value={answer.customInput ?? ''} disabled={submitting} onChange={event => updateAnswer({ customInput: event.target.value })} rows={4} autoFocus className="mt-1 w-full rounded-md border border-border-200 bg-bg-100 p-2 text-text-100" /></label>}
      </>}
      <p className="text-[length:var(--fs-xs)] text-text-400">{t('components:dialog.questionnaireNotApproval')}</p>
      {error && <p role="alert" className="text-danger-100">{error}</p>}
    </div>
    <div className="flex items-center gap-2 px-4 py-2.5 shrink-0">
      <button type="button" disabled={submitting || index === 0} onClick={() => setIndex(index - 1)} className="text-text-300 disabled:opacity-40">{t('components:dialog.previous')}</button>
      <button type="button" disabled={submitting} onClick={() => void send({ cancelled: true })} className="ml-auto text-text-400">{t('common:cancel')}</button>
      {review ? <button type="button" disabled={submitting || !answers.every((_, position) => isValid(position))} onClick={() => void send({ answers })} className="rounded-md bg-text-100 px-3 py-1 text-bg-000 disabled:opacity-40">{submitting ? '…' : t('common:submit')}</button>
        : <button type="button" disabled={submitting || !isValid(index)} onClick={() => setIndex(index + 1)} className="rounded-md bg-text-100 px-3 py-1 text-bg-000 disabled:opacity-40">{t('components:dialog.next')}</button>}
    </div>
  </div>
}
