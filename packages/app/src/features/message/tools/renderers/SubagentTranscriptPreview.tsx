import { memo, useMemo } from 'react'
import type { OmpSubagentTranscriptItem } from '../../../../omp/ompSubagentStore'
import { formatToolName } from '../../../../utils/formatUtils'

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
        previous &&
        previous.items[0].kind !== 'user' &&
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
            {text}
          </div>
        </div>
      )
    }
    const tools = row.items.filter(part => part.kind === 'tool')
    return (
      <div key={row.key} className="space-y-1.5">
        {text && (
          <div className="text-[length:var(--fs-xs)] text-text-200 leading-relaxed whitespace-pre-wrap break-words">
            {text.length > 500 && index !== rows.length - 1 ? `${text.slice(0, 500)}...` : text}
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
