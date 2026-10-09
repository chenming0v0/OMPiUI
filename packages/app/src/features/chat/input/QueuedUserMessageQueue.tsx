import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, TrashIcon, MoreVerticalIcon, MessageSquareIcon } from '../../../components/Icons'
import { CopyButton, DropdownMenu, MenuItem } from '../../../components/ui'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'

export interface ComposerQueueProps {
  queuedSteering?: readonly string[]
  queuedFollowUps?: readonly string[]
  onQueueBackToInput?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
  onQueueSendNow?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
  onQueueClear?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
  onQueueOpenInSideChat?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
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
  items: readonly string[]
  /** 修改该条（pi 不支持队列内修改：清除后回填输入框，编辑后重发） */
  onBackToInput?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  /** 立即提交该条（本轮 steer / 下一轮 prompt），不做队列重排 */
  onSendNow?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  /** 直接清除该条 */
  onClear?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  onOpenInSideChat?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
}) {
  const { t } = useTranslation('chat')
  const { preferTouchUi } = useInputCapabilities()
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null)
  /** 正在提交的条目：命令未落地前禁用该行，避免连点重复提交同一条 */
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
  // 行内按钮和菜单项共用：命令未落地前禁用该行，连点不会重复提交同一条。
  const submitSendNow = (index: number) => {
    if (!onSendNow || submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    void Promise.resolve().then(() => onSendNow(queueKind, index)).finally(() => {
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
        {items.map((text, index) => (
          <div key={`${kind}:${index}:${text}`} className="group/msg flex items-center gap-2 px-3 py-1.5 min-h-10 border-b border-border-200/60">
            <span className="shrink-0 text-text-400" aria-hidden="true">
              {kind === 'current' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
            </span>
            <div className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] leading-5 text-text-200" title={text}>
              {text}
            </div>
            {(onBackToInput || onSendNow || onClear || onOpenInSideChat) && (
              <div className={`relative shrink-0 ${actionBarClass}`}>
                <CopyButton text={text} position="static" />
                {onSendNow && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => submitSendNow(index)}
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
                    onClick={() => void onClear(queueKind, index)}
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
                          void onBackToInput(queueKind, index)
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
                          submitSendNow(index)
                        }}
                      />
                    )}
                    {onOpenInSideChat && (
                      <MenuItem
                        label={t('chatArea.openQueueInSideChat')}
                        icon={<MessageSquareIcon size={15} />}
                        onClick={() => {
                          setOpenMenuIndex(null)
                          void onOpenInSideChat(queueKind, index)
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
                          void onClear(queueKind, index)
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
