import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PiBashExecutionGroupItem,
  PiBashExecutionItem,
  PiBranchSummaryItem,
  PiCompactionItem,
  PiCustomMessageItem,
  PiModeChangeItem,
  PiTimelineItem,
  PiToolExecution,
  PiUnknownItem,
} from '../../../omp/domain/index.js'
import { MarkdownRenderer } from '../../../components/MarkdownRenderer'
import { ChevronDownIcon, ChevronRightIcon, LayersIcon, UsersIcon } from '../../../components/Icons'
import { ContentBlock } from '../../../components/ContentBlock'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { useDisclosureScrollLock } from '../../../hooks'
import { useNow } from '../../../hooks/useNow'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'
import { MSG_SPACING } from '../messageSpacing'
import { ToolGroup } from './ToolGroup'
import { formatDuration } from '../../../utils/formatUtils'
import { customMessageText, readAgentMessage, readBackgroundJobs, type BackgroundJobView } from './customMessagePresentation'

// ============================================
// Pi system timeline item views
// Visual language follows CompactionPartView (divider + small label).
// ============================================

/**
 * Renders non-conversation timeline items (bash executions, compaction,
 * branch summaries, model/thinking changes, labels, custom messages,
 * unknown entries). Nothing is silently dropped — unknown kinds get a
 * visible divider with their entry type.
 */
export const PiSystemItemView = memo(function PiSystemItemView({ item }: { item: PiTimelineItem }) {
  switch (item.kind) {
    case 'bash_execution':
    case 'bash_execution_group':
      return <BashExecutionGroupView item={item} />
    case 'compaction':
      return <CompactionItemView item={item} />
    case 'branch_summary':
      return <BranchSummaryItemView item={item} />
    case 'custom_message':
      return item.display ? <CustomMessageItemView item={item} /> : null
    case 'mode_change':
      return <ModeChangeItemView item={item} />
    case 'unknown':
      return <UnknownItemView item={item} />
    default:
      return null
  }
})

// ============================================
// Divider row (CompactionPartView visual language)
// ============================================

interface DividerRowProps {
  partKey: string
  label: string
  detail?: string
}

const DividerRow = memo(function DividerRow({ partKey, label, detail }: DividerRowProps) {
  const hasDetail = Boolean(detail && detail.trim())
  const [expanded, setExpanded] = useUiDisclosureState(`pi:${partKey}:divider`, false)
  const shouldRenderBody = useMessageExpandRender(expanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()

  if (!hasDetail) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-500">
        <span className="flex-1 h-px bg-border-200/70" />
        <span className="shrink-0 text-[length:var(--fs-xs)] leading-none text-text-400">{label}</span>
        <span className="flex-1 h-px bg-border-200/70" />
      </div>
    )
  }

  return (
    <div ref={rootRef}>
      <button
        type="button"
        ref={headerRef}
        onClick={() => withScrollLock(() => setExpanded(!expanded))}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-500 hover:text-text-400 transition-colors"
      >
        <span className="flex-1 h-px bg-border-200/70" />
        <span className="shrink-0 inline-flex items-center gap-1 text-[length:var(--fs-xs)] leading-none text-text-400">
          {label}
          <ChevronDownIcon size={10} className={chevronClass(expanded)} />
        </span>
        <span className="flex-1 h-px bg-border-200/70" />
      </button>
      <MessageExpandPanel open={expanded} variant="fade" innerClassName="overflow-hidden">
        {shouldRenderBody && detail && (
          <div className="px-3 pb-2">
            <MarkdownRenderer content={detail} variant="reasoning" />
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
})

// ============================================
// Item views
// ============================================

/**
 * 用户发起的 bash 执行（`!cmd` / `/bash cmd`）渲染。
 * 相邻执行由 selector 合并为 bash_execution_group；单个 bash 也走同一
 * 组件。复用 ToolGroup：与 AI 自己调用工具（连续工具组）的渲染完全一致
 * —— 单条 compact、多条 steps header + timeline。
 *
 * 展开策略：参考助手工具"进行中展开"——bash 刚执行完（最近
 * FRESH_BASH_WINDOW_MS 内落盘）视为活跃，默认展开（发命令就是为了看
 * 输出）；窗口过后 / 刷新回到 session 的历史条目恢复默认折叠。初始展开
 * 后由 useUiDisclosureState 保持，用户手动折叠会尊重。
 */
const FRESH_BASH_WINDOW_MS = 5 * 60_000

function BashExecutionGroupView({ item }: { item: PiBashExecutionItem | PiBashExecutionGroupItem }) {
  const items = 'items' in item ? item.items : [item]
  const executions: PiToolExecution[] = items.map(bashItemToExecution)
  // 组内最新一条的执行时间：组增长（连续发新命令并入）时按最新命令判定。
  // useNow 提供渲染安全的时间源（渲染期不得直接调 Date.now）。
  const latestTimestamp = items.reduce((max, bashItem) => Math.max(max, bashItem.timestamp), 0)
  const now = useNow(60_000)
  const fresh = latestTimestamp > 0 && now - latestTimestamp < FRESH_BASH_WINDOW_MS
  return (
    <ToolGroup
      groupId={item.entryId}
      executions={executions}
      defaultExpanded={fresh}
    />
  )
}

function bashItemToExecution(item: PiBashExecutionItem): PiToolExecution {
  const call: PiToolExecution['call'] = {
    type: 'toolCall',
    id: item.entryId,
    name: 'bash',
    arguments: { command: item.message.command },
  }
  // User-issued bash entries are optimistic executions, not assistant call proposals.
  if (item.message.exitCode === undefined) {
    return { call, startedAt: item.timestamp, isRunning: true }
  }
  return {
    call,
    result: {
      role: 'toolResult',
      toolCallId: item.entryId,
      toolName: 'bash',
      content: [{ type: 'text', text: item.message.output }],
      isError: item.message.exitCode !== 0,
      timestamp: item.message.timestamp,
    },
  }
}

function CompactionItemView({ item }: { item: PiCompactionItem }) {
  const { t } = useTranslation('message')
  return <DividerRow partKey={item.entryId} label={t('system.contextCompacted')} detail={item.summary} />
}

function BranchSummaryItemView({ item }: { item: PiBranchSummaryItem }) {
  const { t } = useTranslation('message')
  return <DividerRow partKey={item.entryId} label={t('system.branchSummary')} detail={item.summary} />
}

function CustomMessageItemView({ item }: { item: PiCustomMessageItem }) {
  const { t } = useTranslation('message')
  const agent = readAgentMessage(item)
  if (agent) {
    return (
      <section className={`min-w-0 ${MSG_SPACING.item}`} aria-label={t('system.agentMessage', { name: agent.sender })}>
        <div className="min-w-0 border-l-2 border-accent-main-100/40 pl-3">
          <div className="flex items-center gap-1.5 pb-1 text-[length:var(--fs-xs)] text-text-400">
            <UsersIcon size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{t('system.agentMessageFrom', { name: agent.sender })}</span>
          </div>
          <MarkdownRenderer content={agent.body} />
        </div>
      </section>
    )
  }
  const jobs = readBackgroundJobs(item)
  if (jobs) {
    return <div className="min-w-0">{jobs.map((job, index) => <BackgroundJobCard key={`${job.id}:${index}`} job={job} partKey={`${item.entryId}:${job.id}:${index}`} />)}</div>
  }
  const text = customMessageText(item)
  return text.trim() ? <MarkdownRenderer content={text} /> : null
}

const JOB_STATUS: Record<string, { key: string; tone: string }> = {
  completed: { key: 'system.jobCompleted', tone: 'bg-success-100/10 text-success-100' },
  failed: { key: 'system.jobFailed', tone: 'bg-danger-100/10 text-danger-100' },
  cancelled: { key: 'system.jobCancelled', tone: 'bg-bg-200/60 text-text-400' },
  aborted: { key: 'system.jobAborted', tone: 'bg-danger-100/10 text-danger-100' },
}

const MARKDOWN_TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m

function isMarkdownDocument(text: string): boolean {
  if (/^\s*```/m.test(text) || MARKDOWN_TABLE_DIVIDER.test(text)) return true
  const lines = text.split('\n').filter(line => line.trim())
  const headings = lines.filter(line => /^#{1,6}\s+\S/.test(line))
  return headings.length > 0 && lines.length > headings.length
}

function BackgroundJobCard({ job, partKey }: { job: BackgroundJobView; partKey: string }) {
  const { t } = useTranslation('message')
  const [expanded, setExpanded] = useUiDisclosureState(`pi:${partKey}:job-result`, false)
  const [isChildFullscreen, setIsChildFullscreen] = useState(false)
  const effectiveExpanded = expanded || isChildFullscreen
  const shouldRenderBody = useMessageExpandRender(effectiveExpanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const duration = job.durationMs !== undefined ? formatDuration(job.durationMs) : job.duration
  const status = JOB_STATUS[job.status]
  const failed = job.status === 'failed' || job.status === 'aborted' || job.errors.length > 0
  const body = job.body.trim()
  const structured = body.startsWith('[') || body.startsWith('{')
  const markdown = !structured && isMarkdownDocument(body)
  const metadata = job.metadata && Object.keys(job.metadata).length > 0 ? JSON.stringify(job.metadata, null, 2) : undefined
  const summaryOnly = !body && !job.errors.length ? job.summary : undefined
  const expandable = Boolean(body || metadata || job.fullOutput || job.errors.length || summaryOnly)
  const preview = job.errors[0] ?? job.summary

  const headerContent = (
    <>
      <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className={`shrink-0 font-medium text-[length:var(--fs-md)] leading-tight ${failed ? 'text-danger-100' : 'text-text-200 group-hover/header:text-text-100'}`}>
          {t('system.jobLabel')}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-sm)] text-text-400 opacity-70" title={job.name}>{job.name}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className={`rounded px-1.5 py-px text-[length:var(--fs-xxs)] font-medium ${status?.tone ?? 'bg-bg-200/60 text-text-400'}`}>
          {status ? t(status.key) : job.status}
        </span>
        {duration && <span className="font-mono text-[length:var(--fs-xxs)] tabular-nums text-text-500">{duration}</span>}
        {expandable && (
          <span className="text-text-500">
            {effectiveExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
        )}
      </div>
    </>
  )
  const headerClass = 'flex h-9 w-full items-center gap-2 rounded-sm pl-2 pr-0 text-left'

  return (
    <section
      ref={rootRef}
      className={`group relative grid min-w-0 grid-cols-[14px_minmax(0,1fr)] items-start gap-x-1.5 ${MSG_SPACING.item}`}
      aria-label={t('system.backgroundJob', { name: job.name })}
    >
      <span className={`inline-flex h-9 w-[14px] shrink-0 items-center justify-center ${failed ? 'text-danger-100' : 'text-text-400 group-hover:text-text-300'}`}>
        <LayersIcon size={14} />
      </span>
      <div className="min-w-0">
        {expandable
          ? (
              <button
                type="button"
                ref={headerRef}
                aria-expanded={effectiveExpanded}
                onClick={() => withScrollLock(() => setExpanded(!expanded))}
                className={`${headerClass} group/header transition-colors hover:bg-bg-200/40`}
              >
                {headerContent}
              </button>
            )
          : <div className={headerClass}>{headerContent}</div>}
        {preview && !effectiveExpanded && (
          <p
            className={`-mt-1 truncate pl-2 pr-2.5 text-[length:var(--fs-xs)] ${job.errors.length ? 'text-danger-100' : 'text-text-500'}`}
            title={preview}
          >
            {preview}
          </p>
        )}
        <MessageExpandPanel open={effectiveExpanded} innerClassName="overflow-hidden min-h-0" contentClassName={MSG_SPACING.toolBodyInset}>
          {shouldRenderBody && (
            <div className="flex min-w-0 flex-col gap-2">
              {job.errors.length > 0 && (
                <ContentBlock
                  label={t('system.jobError')}
                  variant="error"
                  content={job.errors.join('\n\n')}
                  stateKey={`pi:${partKey}:job-error`}
                  fullscreenId={`pi:${partKey}:job-error`}
                  onFullscreenChange={setIsChildFullscreen}
                />
              )}
              {body && (markdown
                ? <div className="min-w-0"><MarkdownRenderer content={body} /></div>
                : (
                    <ContentBlock
                      label={t('system.jobResult')}
                      language={structured ? 'json' : undefined}
                      content={job.body}
                      stateKey={`pi:${partKey}:job-body`}
                      fullscreenId={`pi:${partKey}:job-body`}
                      onFullscreenChange={setIsChildFullscreen}
                    />
                  ))}
              {summaryOnly && <MarkdownRenderer content={summaryOnly} />}
              {metadata && (
                <ContentBlock
                  label={t('system.jobDetails')}
                  language="json"
                  content={metadata}
                  defaultCollapsed
                  stateKey={`pi:${partKey}:job-metadata`}
                  fullscreenId={`pi:${partKey}:job-metadata`}
                  onFullscreenChange={setIsChildFullscreen}
                />
              )}
              {job.fullOutput && (
                <p className="break-all text-[length:var(--fs-xs)] text-text-500">
                  {t('system.jobFullOutput', { path: job.fullOutput })}
                </p>
              )}
            </div>
          )}
        </MessageExpandPanel>
      </div>
    </section>
  )
}

function UnknownItemView({ item }: { item: PiUnknownItem }) {
  const { t } = useTranslation('message')
  return <DividerRow partKey={item.entryId} label={t('system.unsupportedEntry', { type: item.entryType })} />
}

// ============================================
// Mode change (OMP mode_change entry)
// ============================================

/** 已知模式的展示名；未收录的模式回退到 generic 词条（原样显示 mode 值） */
const MODE_CHANGE_LABEL_KEYS: Record<string, string> = {
  goal: 'system.modeChange.goal',
  plan: 'system.modeChange.plan',
}

/**
 * OMP 的 agent 模式切换标记（如 goal / plan），mode "none" 表示退出模式。
 * 渲染为普通分隔条：切换动作本身没有详情可展开，数据里的模式状态
 * （如 goal 快照）已由目标栏等专属 UI 呈现。
 */
function ModeChangeItemView({ item }: { item: PiModeChangeItem }) {
  const { t } = useTranslation('message')
  const label = item.mode === 'none'
    ? t('system.modeChange.exit')
    : t(MODE_CHANGE_LABEL_KEYS[item.mode] ?? 'system.modeChange.generic', { mode: item.mode })
  return <DividerRow partKey={item.entryId} label={label} />
}
