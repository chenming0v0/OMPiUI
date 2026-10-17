import { useState, useCallback, useRef, useEffect, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { CloseIcon, ChevronDownIcon, CopyIcon, CheckIcon, DownloadIcon, ExpandIcon } from '../../components/Icons'
import { getAttachmentIcon, hasExpandableContent } from './utils'
import { getMaterialIconUrl } from '../../utils/materialIcons'
import { useDelayedRender } from '../../hooks/useDelayedRender'
import { AttachmentDetailModal } from './AttachmentDetailModal'
import { clipboardErrorHandler, copyTextToClipboard } from '../../utils'
import { saveData } from '../../utils/downloadUtils'
import type { Attachment } from './types'
import { useAuthenticatedObjectUrl } from './AuthenticatedImage'

interface AttachmentItemProps {
  attachment: Attachment
  onRemove?: (id: string) => void
  size?: 'sm' | 'md'
  expandable?: boolean
  className?: string
  onFullscreenChange?: (isOpen: boolean) => void
}

function AttachmentItemComponent({
  attachment,
  onRemove,
  size = 'md',
  expandable = false,
  className,
  onFullscreenChange,
}: AttachmentItemProps) {
  const { t } = useTranslation(['commands', 'common'])
  const [isExpanded, setIsExpanded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const isImagePreview = expandable && !!attachment.url && !!attachment.mime?.startsWith('image/')
  const shouldRenderBody = useDelayedRender(isExpanded)
  const resolvedUrl = useAuthenticatedObjectUrl(
    attachment.url,
    attachment.requiresAuth,
    isImagePreview || shouldRenderBody || isModalOpen,
  )
  const renderedAttachment = attachment.requiresAuth ? { ...attachment, url: resolvedUrl } : attachment

  useEffect(() => {
    if (!isModalOpen) return
    onFullscreenChange?.(true)
    return () => onFullscreenChange?.(false)
  }, [isModalOpen, onFullscreenChange])

  const { Icon, colorClass } = getAttachmentIcon(attachment)
  const canExpand = expandable && hasExpandableContent(attachment)

  // file/folder 使用 material icon，其他类型用通用 SVG 图标
  const useMaterialIcon = attachment.type === 'file' || attachment.type === 'folder'
  const materialIconUrl = useMaterialIcon
    ? getMaterialIconUrl(
        attachment.relativePath || attachment.displayName,
        attachment.type === 'folder' ? 'directory' : 'file',
      )
    : null

  // 宽度模型：学习 ReasoningPartView 的做法
  // 收起时固定宽度，展开时用百分比+max限制（可被 CSS 过渡）
  // 不用 w-auto（无法过渡），用 w-full（百分比 → 计算像素 → 可过渡）
  const collapsedWidth = className ? '' : 'w-[140px]'
  const expandedWidth = 'w-full min-w-[140px] max-w-[440px]'

  if (isImagePreview) {
    return (
      <div className={`relative min-w-0 max-w-full ${className || 'w-40'}`}>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          aria-label={t('attachment.openImage', { name: attachment.displayName })}
          aria-haspopup="dialog"
          title={t('attachment.openImage', { name: attachment.displayName })}
          className="group flex w-full min-w-0 cursor-zoom-in flex-col overflow-hidden rounded-lg border border-border-300/60 bg-bg-100/50 text-left transition-colors hover:border-text-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-main-100"
        >
          <span className="relative flex h-28 w-full items-center justify-center overflow-hidden bg-bg-200/50 p-1.5">
            {resolvedUrl && !imageError ? (
              <img
                key={resolvedUrl}
                src={resolvedUrl}
                alt={attachment.displayName}
                loading="lazy"
                decoding="async"
                onLoad={() => setImageError(false)}
                onError={() => setImageError(true)}
                className="h-full w-full object-contain"
              />
            ) : (
              <span className="px-2 text-[length:var(--fs-xs)] text-text-400">
                {imageError ? t('attachment.failedToLoadImage') : t('common:loading')}
              </span>
            )}
            <span aria-hidden="true" className="absolute bottom-1.5 right-1.5 rounded bg-bg-100/90 p-1 text-text-200 opacity-70 transition-opacity group-hover:opacity-100">
              <ExpandIcon size={12} />
            </span>
          </span>
          <span className="w-full truncate px-2 py-1 text-[length:var(--fs-xs)] text-text-300">
            {attachment.displayName}
          </span>
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="absolute right-1 top-1 rounded bg-bg-100/90 p-1 text-text-300 hover:text-text-100"
            aria-label={t('attachment.removeAttachment')}
          >
            <CloseIcon />
          </button>
        )}
        <AttachmentDetailModal
          attachment={renderedAttachment}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
        />
      </div>
    )
  }

  return (
    <div
      className={`relative group flex min-w-0 max-w-full flex-col overflow-hidden transition-all duration-300 ease-out ${
        className || ''
      } ${isExpanded ? expandedWidth : collapsedWidth}`}
    >
      {/* 标签头部 */}
      <div
        className={`
          flex items-center gap-1.5 w-full
          px-2.5 py-1.5 rounded-lg border
          bg-bg-100/50 border-border-300/50
          ${size === 'sm' ? 'text-[length:var(--fs-sm)]' : 'text-[length:var(--fs-base)]'}
          ${canExpand ? 'cursor-pointer hover:bg-bg-200 transition-colors' : ''}
        `}
        onClick={canExpand ? () => setIsExpanded(!isExpanded) : undefined}
      >
        {materialIconUrl ? (
          <img
            src={materialIconUrl}
            alt=""
            width={14}
            height={14}
            className="shrink-0"
            loading="lazy"
            decoding="async"
            onError={e => {
              e.currentTarget.style.visibility = 'hidden'
            }}
          />
        ) : (
          <span
            className={`${colorClass} flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5`}
          >
            <Icon />
          </span>
        )}
        <span className="text-text-200 flex-1 min-w-0 truncate text-left" title={attachment.displayName}>
          {attachment.displayName}
        </span>
        {canExpand && (
          <span className={`text-text-400 transition-transform duration-300 ${isExpanded ? '' : '-rotate-90'}`}>
            <ChevronDownIcon size={10} />
          </span>
        )}
        {onRemove && (
          <button
            onClick={e => {
              e.stopPropagation()
              onRemove(attachment.id)
            }}
            className="ml-1 text-text-400 hover:text-text-100 transition-colors"
            aria-label={t('attachment.removeAttachment')}
          >
            <CloseIcon />
          </button>
        )}
      </div>

      {/* 展开的详情面板 - grid-rows 动画（和 think tag 同源） */}
      {canExpand && (
        <div
          className={`grid transition-[grid-template-rows] duration-300 ease-out ${
            isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          }`}
        >
          <div className="min-w-0 overflow-hidden">
            {shouldRenderBody && (
              <ExpandedContent
                attachment={renderedAttachment}
                onOpenDetail={() => setIsModalOpen(true)}
              />
            )}
          </div>
        </div>
      )}

      {/* 附件详情弹窗 */}
      <AttachmentDetailModal
        attachment={renderedAttachment}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  )
}

interface ExpandedContentProps {
  attachment: Attachment
  onOpenDetail: () => void
}

function MetaRow({
  label,
  value,
  copyable,
  className = '',
}: {
  label: string
  value?: string
  copyable?: boolean
  className?: string
}) {
  if (!value) return null
  return (
    <div className="flex min-w-0 gap-2">
      <span className="text-text-400 shrink-0 select-none">{label}:</span>
      <span className={`min-w-0 font-mono break-all text-text-200 ${copyable ? 'select-all' : ''} ${className}`}>
        {value}
      </span>
    </div>
  )
}

function ExpandedContent({ attachment, onOpenDetail }: ExpandedContentProps) {
  const { t } = useTranslation(['commands', 'common'])
  const { type, url, content, relativePath, mime, agentName, agentDescription } = attachment
  const hasContent = !!content

  // Content Area
  let contentNode = null

  if (content) {
    contentNode = (
      <div className="max-h-64 overflow-auto custom-scrollbar">
        <pre className="p-2 text-[length:var(--fs-sm)] font-mono text-text-300 whitespace-pre-wrap break-all">
          {content.length > 5000 ? content.slice(0, 5000) + '\n\n' + t('common:truncated') : content}
        </pre>
      </div>
    )
  }

  return (
    <div className="mt-1 min-w-0 max-w-full rounded-md bg-bg-200 border border-border-300 overflow-hidden w-full">
      {contentNode}

      {/* 操作按钮栏 */}
      <ActionBar
        attachment={attachment}
        hasContent={hasContent}
        onOpenDetail={onOpenDetail}
        showBorderTop={!!contentNode}
      />

      {/* 元信息 */}
      <div
        className={`p-2 text-[length:var(--fs-sm)] space-y-1 text-text-300 bg-bg-100/50 ${hasContent ? 'border-t border-border-300' : ''}`}
      >
        {type === 'text' && <MetaRow label={t('attachment.category')} value={t('attachment.context')} />}

        {/* Full Path / URL */}
        <MetaRow
          label={t('attachment.source')}
          value={
            url
              ? url.startsWith('file:///')
                ? decodeURIComponent(url.replace(/^file:\/\/\/?/, ''))
                : url
              : undefined
          }
          copyable
          className={url?.startsWith('data:') ? 'line-clamp-4' : ''}
        />

        <MetaRow label={t('attachment.refPath')} value={relativePath} />
        <MetaRow label={t('attachment.type')} value={type === 'folder' ? t('attachment.directory') : mime} />

        {attachment.originalSource && typeof attachment.originalSource === 'object' && (
          <>
            {attachment.originalSource.type === 'symbol' && (
              <>
                <MetaRow label={t('attachment.symbol')} value={attachment.originalSource.name} />
                <MetaRow label={t('attachment.kind')} value={String(attachment.originalSource.kind)} />
                <MetaRow
                  label={t('attachment.range')}
                  value={
                    attachment.originalSource.range
                      ? `L${attachment.originalSource.range.start.line}:${attachment.originalSource.range.start.character}`
                      : undefined
                  }
                />
              </>
            )}
            {attachment.originalSource.type === 'resource' && (
              <>
                <MetaRow label={t('attachment.resource')} value={attachment.originalSource.uri} copyable />
                <MetaRow label={t('attachment.client')} value={attachment.originalSource.clientName} />
              </>
            )}
            {(attachment.originalSource.value ||
              (attachment.originalSource.text && attachment.originalSource.text?.value)) && (
              <MetaRow
                label={t('attachment.mentionLabel')}
                value={attachment.originalSource.value || attachment.originalSource.text?.value}
              />
            )}
          </>
        )}

        <MetaRow label={t('attachment.agentLabel')} value={agentName} />
        <MetaRow label={t('attachment.desc')} value={agentDescription} className="line-clamp-2" />
      </div>
    </div>
  )
}

// ============================================
// ActionBar - 操作按钮栏（查看详情、复制、下载）
// ============================================

interface ActionBarProps {
  attachment: Attachment
  hasContent: boolean
  onOpenDetail: () => void
  showBorderTop: boolean
}

function ActionBar({ attachment, hasContent, onOpenDetail, showBorderTop }: ActionBarProps) {
  const { t } = useTranslation(['commands', 'common'])
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!attachment.content) return
      try {
        await copyTextToClipboard(attachment.content)
        setCopied(true)
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setCopied(false), 2000)
      } catch (err) {
        clipboardErrorHandler('copy', err)
      }
    },
    [attachment.content],
  )

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const fileName = attachment.displayName || 'attachment.txt'
      if (attachment.content) {
        saveData(new TextEncoder().encode(attachment.content), fileName, 'text/plain;charset=utf-8')
      }
    },
    [attachment],
  )

  const handleOpenDetail = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onOpenDetail()
    },
    [onOpenDetail],
  )

  if (!hasContent) return null

  const btnBase =
    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[length:var(--fs-xxs)] transition-colors duration-150'

  return (
    <div
      className={`flex flex-wrap items-center gap-1 px-2 py-1 bg-bg-100/30 ${showBorderTop ? 'border-t border-border-300/50' : ''}`}
    >
      <button
        onClick={handleOpenDetail}
        className={`${btnBase} text-text-400 hover:text-text-200 hover:bg-bg-300/50`}
        title={t('attachment.viewDetail')}
      >
        <ExpandIcon size={11} />
        <span>{t('common:detail')}</span>
      </button>

      {hasContent && (
        <button
          onClick={handleCopy}
          className={`${btnBase} ${copied ? 'text-success-100' : 'text-text-400 hover:text-text-200 hover:bg-bg-300/50'}`}
          title={copied ? t('common:copied') : t('attachment.copyContent')}
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          <span>{copied ? t('common:copied') : t('common:copy')}</span>
        </button>
      )}

      {hasContent && (
        <button
          onClick={handleDownload}
          className={`${btnBase} text-text-400 hover:text-text-200 hover:bg-bg-300/50`}
          title={t('attachment.saveToFile')}
        >
          <DownloadIcon size={11} />
          <span>{t('common:save')}</span>
        </button>
      )}
    </div>
  )
}

// ============================================
// Export with memo for performance optimization
// ============================================

export const AttachmentItem = memo(AttachmentItemComponent)
