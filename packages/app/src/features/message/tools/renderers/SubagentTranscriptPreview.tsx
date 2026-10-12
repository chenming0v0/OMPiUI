import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon } from '../../../../components/Icons'
import type { OmpSubagentTranscriptItem } from '../../../../omp/ompSubagentStore'
import { formatToolName } from '../../../../utils/formatUtils'

const PreviewText = memo(function PreviewText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const { t } = useTranslation('message')
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 8000
  return (
    <>
      <div className="whitespace-pre-wrap break-words">
        {long && !expanded ? streaming ? `...${text.slice(-8000)}` : `${text.slice(0, 8000)}...` : text}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'showLess' : 'showMore')}
          title={t(expanded ? 'showLess' : 'showMore')}
          onClick={() => setExpanded(value => !value)}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-text-400 hover:bg-bg-200 bg-transparent border-none p-0"
        >
          <ChevronDownIcon size={12} className={expanded ? 'rotate-180' : ''} />
        </button>
      )}
    </>
  )
})

export const SubagentTranscriptPreview = memo(function SubagentTranscriptPreview({
  items,
  isRunning,
}: {
  items: OmpSubagentTranscriptItem[]
  isRunning: boolean
}) {
  const rows = useMemo(() => {
    const grouped: { key: string; items: OmpSubagentTranscriptItem[]; messageId?: string }[] = []
    // 消息身份用于正文更新；连续的纯工具轮次仍共用一条徽标流。
    for (const item of items) {
      const previous = grouped.at(-1)
      const sameMessage = item.messageId ? previous?.messageId === item.messageId : item.kind === 'tool'
      if (
        item.kind !== 'user' &&
        item.kind !== 'agent' &&
        previous &&
        previous.items[0].kind !== 'user' &&
        previous.items[0].kind !== 'agent' &&
        (sameMessage || item.kind === 'tool')
      ) {
        previous.items.push(item)
      } else {
        grouped.push({
          key: item.messageId ?? `${item.timestamp}-${grouped.length}`,
          items: [item],
          messageId: item.messageId,
        })
      }
    }
    return grouped
  }, [items])

  return rows.map((row, index) => {
    const item = row.items[0]
    const text = row.items
      .filter(part => part.kind !== 'tool')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (item.kind === 'user') {
      return (
        <div key={row.key} className="flex justify-end">
          <div className="max-w-[85%] px-2.5 py-1.5 rounded-md bg-bg-300 text-text-100 text-[length:var(--fs-xs)] whitespace-pre-wrap break-words">
            <PreviewText text={text} />
          </div>
        </div>
      )
    }
    const tools = row.items.filter(part => part.kind === 'tool')
    const thinking = row.items.filter(part => part.streaming && part.thinking).at(-1)?.thinking
    return (
      <div key={row.key} className="space-y-1.5">
        {isRunning && !text && thinking && (
          <div role="status" className="text-[length:var(--fs-xs)] text-text-400 italic whitespace-pre-wrap break-words">
            {thinking.slice(-500)}
          </div>
        )}
        {text && (
          <div className="text-[length:var(--fs-xs)] text-text-200 leading-relaxed whitespace-pre-wrap break-words">
            <PreviewText
              text={text.length > 500 && index !== rows.length - 1 ? `${text.slice(0, 500)}...` : text}
              streaming={isRunning && row.items.some(part => part.streaming)}
            />
          </div>
        )}
        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tools.map((tool, toolIndex) => {
              const active = isRunning && (tool.toolStatus === 'running' || tool.toolStatus === 'pending')
              const title = tool.toolTitle || formatToolName(tool.toolName ?? 'tool')
              return (
                <span
                  key={tool.toolCallId ?? `${tool.timestamp}-${toolIndex}`}
                  title={tool.toolTitle || tool.toolName || 'tool'}
                  className={`inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 rounded-xs text-[length:var(--fs-xxs)] font-mono ${
                    active
                      ? 'bg-accent-main-100/10 text-accent-main-100'
                      : tool.isError || tool.toolStatus === 'error'
                        ? 'bg-danger-100/10 text-danger-100'
                        : 'bg-bg-200 text-text-400'
                  }`}
                >
                  {active && <span className="w-1 h-1 shrink-0 rounded-full bg-current animate-pulse" />}
                  <span className="truncate">{title.length > 30 ? `${title.slice(0, 30)}...` : title}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>
    )
  })
})
