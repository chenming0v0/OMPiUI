import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, QuestionIcon } from '../../components/Icons'
import { NativeAskSlot } from './InlineAskRequests'
import { InlineAskRequestsContext } from './nativeAskContext'
import { NativeAskDialogCard } from './NativeAskDialogCard'
import type { NativeAskRequest } from './nativeAskMatching'

export function NativeAskDialogDock({ request, compact, onCollapse, queueLength = 1, queueIndex = 0, onQueueNav }: {
  request: NativeAskRequest
  compact?: boolean
  onCollapse?: () => void
  queueLength?: number
  queueIndex?: number
  onQueueNav?: (delta: -1 | 1) => void
}) {
  const { t } = useTranslation('components')
  const context = useContext(InlineAskRequestsContext)
  return <div className={`flex flex-col overflow-hidden rounded-xl border border-border-200/60 bg-bg-100 shadow-float ${compact ? 'max-h-[55vh]' : 'max-h-[62vh]'}`}>
    <div className="flex shrink-0 items-center gap-2 px-4 py-2.5 text-text-400">
      <QuestionIcon size={16} />
      <span className="text-[length:var(--fs-sm)] font-medium text-text-100">{t('dialog.ask')}</span>
      <div className="ml-auto flex items-center gap-1">
        {onQueueNav && queueLength > 1 && <>
          <button type="button" disabled={queueIndex === 0} onClick={() => onQueueNav(-1)} title={t('dialog.previous')} className="rounded p-1 hover:bg-bg-200 disabled:opacity-40"><ChevronLeftIcon size={14} /></button>
          <span className="text-[length:var(--fs-xs)] tabular-nums">{queueIndex + 1}/{queueLength}</span>
          <button type="button" disabled={queueIndex >= queueLength - 1} onClick={() => onQueueNav(1)} title={t('dialog.next')} className="rounded p-1 hover:bg-bg-200 disabled:opacity-40"><ChevronRightIcon size={14} /></button>
        </>}
        {onCollapse && <button type="button" onClick={onCollapse} title={t('dialog.minimize')} className="rounded p-1 hover:bg-bg-200 hover:text-text-200"><ChevronDownIcon size={14} /></button>}
      </div>
    </div>
    <div className="custom-scrollbar min-h-0 overflow-y-auto px-4 pb-3">
      {context ? <NativeAskSlot request={request} /> : <NativeAskDialogCard request={request} />}
    </div>
  </div>
}
