import { useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ExtensionUiDialogResponse, NativeAskAnswer } from '@ompiui/protocol'
import { extensionUiStore } from '../../omp/extensionUiStore'
import { respondPiExtensionUi } from '../../omp/controllers/index.js'
import { keybindingStore, matchesKeybinding } from '../../store/keybindingStore'
import { NativeAskQuestion } from './NativeAskQuestion'
import type { NativeAskRequest } from './nativeAskMatching'

/** 状态位于 Portal 之上，工具折叠、虚拟列表卸载和队列切换不会重置答案。 */
export function NativeAskDialogCard({ request, target }: { request: NativeAskRequest; target?: HTMLElement | null }) {
  const { t } = useTranslation(['common', 'components'])
  const [answers, setAnswers] = useState<NativeAskAnswer[]>(() => request.questions.map(question => ({ id: question.id, selectedOptions: [] })))
  const [custom, setCustom] = useState(() => request.questions.map(() => false))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const composing = useRef(false)
  const [responseId] = useState(() => crypto.randomUUID())
  const canSubmit = request.questions.every((question, index) => question.multi || answers[index].selectedOptions.length === 1 || Boolean(answers[index].customInput?.trim()))
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
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!submitting) void send({ cancelled: true })
      return
    }
    const sendKey = keybindingStore.getKey('sendMessage')
    if (!sendKey || !matchesKeybinding(event.nativeEvent, sendKey)) return
    // 普通 Enter 保留按钮自身的选择、提交或跳过动作。
    if ((event.target as HTMLElement).closest('button') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    if (canSubmit && !submitting) void send({ answers })
  }
  const form = <div role="dialog" aria-label={t('components:dialog.ask')} onKeyDown={onKeyDown} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} className="space-y-3">
    {request.questions.map((question, index) => <NativeAskQuestion
      key={question.id}
      question={question}
      answer={answers[index]}
      custom={custom[index]}
      disabled={submitting}
      onChange={answer => setAnswers(previous => previous.map((value, position) => position === index ? answer : value))}
      onCustomChange={enabled => setCustom(previous => previous.map((value, position) => position === index ? enabled : value))}
    />)}
    {error && <p role="alert" className="text-[length:var(--fs-sm)] text-danger-100">{error}</p>}
    <div className="flex items-center gap-2">
      <button type="button" disabled={submitting || !canSubmit} onClick={() => void send({ answers })} className="rounded bg-text-100 px-2.5 py-0.5 text-[length:var(--fs-sm)] font-medium text-bg-000 transition-colors hover:bg-text-200 disabled:opacity-50">{submitting ? '…' : t('common:submit')}</button>
      <button type="button" disabled={submitting} onClick={() => void send({ cancelled: true })} className="rounded px-2.5 py-0.5 text-[length:var(--fs-sm)] text-text-400 transition-colors hover:text-text-200 disabled:opacity-50">{t('common:skip')}</button>
    </div>
  </div>
  if (target === null) return null
  return target ? createPortal(form, target) : form
}
