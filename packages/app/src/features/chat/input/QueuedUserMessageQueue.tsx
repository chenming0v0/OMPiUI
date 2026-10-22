import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, TrashIcon, MoreVerticalIcon, MessageSquareIcon, ImageIcon } from '../../../components/Icons'
import { CopyButton, DropdownMenu, MenuItem } from '../../../components/ui'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { apiErrorHandler } from '../../../utils'

export interface ComposerQueueEntry {
  entryId: string
  text: string
  images?: readonly { mimeType?: string; dataOmitted?: boolean; byteLength?: number }[]
}

export interface ComposerQueueProps {
  queuedSteering?: readonly ComposerQueueEntry[]
  queuedFollowUps?: readonly ComposerQueueEntry[]
  onQueueBackToInput?: (kind: 'steering' | 'followUp', index: number, entryId: string) => void | Promise<void>
  onQueueSendNow?: (kind: 'steering' | 'followUp', index: number, entryId: string) => void | Promise<void>
  onQueueClear?: (kind: 'steering' | 'followUp', index: number, entryId: string) => void | Promise<void>
  onQueueOpenInSideChat?: (kind: 'steering' | 'followUp', index: number, entryId: string) => void | Promise<void>
}

export const QueuedUserMessageQueue = memo(function QueuedUserMessageQueue({
  kind,
  items,
  onBackToInput,
  onSendNow,
  onClear,
  onOpenInSideChat,
}: {
  kind: 'current' | 'next'
  items: readonly ComposerQueueEntry[]
  /** Retrieve only this native item, including its images, for editing. */
  onBackToInput?: ComposerQueueProps['onQueueBackToInput']
  /** Promote this native item to steering without replaying any content. */
  onSendNow?: ComposerQueueProps['onQueueSendNow']
  onClear?: ComposerQueueProps['onQueueClear']
  onOpenInSideChat?: ComposerQueueProps['onQueueOpenInSideChat']
}) {
  const { t } = useTranslation('chat')
  const { preferTouchUi } = useInputCapabilities()
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null)
  /** Serialize mutations until the backend acknowledges this selection. */
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const menuTriggerRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => {
    if (openMenuIndex === null) return
    const handlePointerDown = (event: MouseEvent) => {
      const trigger = menuTriggerRefs.current[openMenuIndex]
      const target = event.target as Element | null
      if (trigger?.contains(event.target as Node) || target?.closest('[role="menu"]')) return
      setOpenMenuIndex(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuIndex(null)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openMenuIndex])
  if (items.length === 0) return null

  const queueKind = kind === 'current' ? 'steering' : 'followUp'
  const sendNowTitle = t('chatArea.sendQueuedNow')
  const label = t(kind === 'current' ? 'chatArea.currentTurnQueue' : 'chatArea.nextTurnQueue', {
    count: items.length,
  })
  // 对齐用户消息 action bar：PC 悬浮显示、触控恒显示
  const actionBarClass = preferTouchUi
    ? 'flex items-center gap-0.5 transition-opacity'
    : 'flex items-center gap-0.5 opacity-70 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 transition-opacity'
  const actionBtnClass =
    'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200/60 hover:text-text-100 transition-colors'
  const submitAction = (action: ComposerQueueProps['onQueueSendNow'], index: number) => {
    if (!action || submittingRef.current) return
    const selected = items[index]
    if (!selected) return
    submittingRef.current = true
    setIsSubmitting(true)
    void Promise.resolve().then(() => action(queueKind, index, selected.entryId)).catch(error => {
      apiErrorHandler('queued message', error)
    }).finally(() => {
      submittingRef.current = false
      setIsSubmitting(false)
    })
  }
  return (
    <section
      data-message-queue={kind}
      aria-label={label}
      className="w-full"
    >
      <div className="sr-only" role="status">{label}</div>
      <div>
        {items.map(({ text, entryId, images }, index) => (
          <div key={entryId} data-queue-entry-id={entryId} className="group/msg flex items-center gap-2 px-3 py-1.5 min-h-10 border-b border-border-200/60">
            <span className="shrink-0 text-text-400" aria-hidden="true">
              {kind === 'current' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
            </span>
            <div className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] leading-5 text-text-200" title={text}>
              {text}
            </div>
            {!!images?.length && (
              <span className="inline-flex shrink-0 items-center gap-1 text-text-400 text-[length:var(--fs-xs)]" aria-label={t('chatArea.queuedImages', { count: images.length })}>
                <ImageIcon size={14} />
                {images.length}
              </span>
            )}
            {(onBackToInput || onSendNow || onClear || onOpenInSideChat) && (
              <div className={`relative shrink-0 ${actionBarClass}`}>
                <CopyButton text={text} position="static" />
                {onSendNow && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => submitAction(onSendNow, index)}
                    title={sendNowTitle}
                    aria-label={sendNowTitle}
                    className={`${actionBtnClass} disabled:opacity-40 disabled:cursor-default`}
                  >
                    <ArrowUpIcon size={14} />
                  </button>
                )}
                {onClear && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => submitAction(onClear, index)}
                    title={t('chatArea.clearQueueItem')}
                    aria-label={t('chatArea.clearQueueItem')}
                    className={actionBtnClass}
                  >
                    <TrashIcon size={14} />
                  </button>
                )}
                <button
                  ref={element => { menuTriggerRefs.current[index] = element }}
                  type="button"
                  disabled={isSubmitting}
                  aria-label={t('chatArea.openQueueMenu')}
                  aria-expanded={openMenuIndex === index}
                  onClick={() => setOpenMenuIndex(current => current === index ? null : index)}
                  className={actionBtnClass}
                >
                  <MoreVerticalIcon size={14} />
                </button>
                <DropdownMenu
                  triggerRef={{ current: menuTriggerRefs.current[index] }}
                  isOpen={openMenuIndex === index}
                  position="top"
                  align="right"
                  minWidth="190px"
                  zIndex={300}
                >
                  <div role="menu" aria-label={t('chatArea.queueOptions')} className="p-1">
                    {onBackToInput && (
                      <MenuItem
                        label={t('chatArea.editQueueItem')}
                        disabled={isSubmitting}
                        icon={<PencilIcon size={15} />}
                        onClick={() => {
                          setOpenMenuIndex(null)
                          submitAction(onBackToInput, index)
                        }}
                      />
                    )}
                    {onSendNow && (
                      <MenuItem
                        label={sendNowTitle}
                        icon={<ArrowUpIcon size={15} />}
                        disabled={isSubmitting}
                        onClick={() => {
                          setOpenMenuIndex(null)
                          submitAction(onSendNow, index)
                        }}
                      />
                    )}
                    {onOpenInSideChat && (
                      <MenuItem
                        label={t('chatArea.openQueueInSideChat')}
                        icon={<MessageSquareIcon size={15} />}
                        disabled={isSubmitting}
                        onClick={() => {
                          setOpenMenuIndex(null)
                          submitAction(onOpenInSideChat, index)
                        }}
                      />
                    )}
                    {onClear && (
                      <MenuItem
                        label={t('chatArea.clearQueueItem')}
                        disabled={isSubmitting}
                        icon={<TrashIcon size={15} />}
                        onClick={() => {
                          setOpenMenuIndex(null)
                          submitAction(onClear, index)
                        }}
                      />
                    )}
                  </div>
                </DropdownMenu>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
})
