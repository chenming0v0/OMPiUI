import { memo } from 'react'
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
import { ChevronDownIcon } from '../../../components/Icons'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { useDisclosureScrollLock } from '../../../hooks'
import { useNow } from '../../../hooks/useNow'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'
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
      startedAt={item.timestamp}
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
  // 乐观条目（执行中，无 exitCode）：result 缺失 → isActive，BashRenderer
  // 通过 useLiveToolOutput(call.id) 显示流式输出（pi TUI 的 onChunk 对应物）
  if (item.message.exitCode === undefined) {
    return { call }
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
      <section className="min-w-0 rounded-md border border-border-200 bg-bg-100/50 px-3 py-2" aria-label={t('system.agentMessage', { name: agent.sender })}>
        <div className="mb-1 text-[length:var(--fs-xs)] font-medium text-text-400">{t('system.agentMessage', { name: agent.sender })}</div>
        <MarkdownRenderer content={agent.body} />
      </section>
    )
  }
  const jobs = readBackgroundJobs(item)
  if (jobs) {
    return <div className="min-w-0 space-y-2">{jobs.map((job, index) => <BackgroundJobCard key={`${job.id}:${index}`} job={job} partKey={`${item.entryId}:${job.id}:${index}`} />)}</div>
  }
  const text = customMessageText(item)
  return text.trim() ? <MarkdownRenderer content={text} /> : null
}

function BackgroundJobCard({ job, partKey }: { job: BackgroundJobView; partKey: string }) {
  const { t } = useTranslation('message')
  const [expanded, setExpanded] = useUiDisclosureState(`pi:${partKey}:job-result`, false)
  const shouldRenderBody = useMessageExpandRender(expanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const duration = job.durationMs !== undefined ? formatDuration(job.durationMs) : job.duration
  const status = job.status === 'completed' ? t('system.jobCompleted') : job.status
  const body = job.body.trim()
  const structured = body.startsWith('[') || body.startsWith('{')

  return (
    <section ref={rootRef} className="min-w-0 rounded-md border border-border-200 bg-bg-100/50 px-3 py-2" aria-label={t('system.backgroundJob', { name: job.name })}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-xs)] text-text-400">
        <span className="font-medium text-text-200 break-all">{job.name}</span>
        <span>{status}</span>
        {duration && <span className="tabular-nums">{duration}</span>}
      </div>
      {job.summary && !job.errors.length && <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[length:var(--fs-sm)] text-text-300">{job.summary}</p>}
      {job.errors.map((error, index) => <p key={index} className="mt-1 whitespace-pre-wrap break-words text-[length:var(--fs-sm)] text-danger-100">{error}</p>)}
      {(job.body || job.metadata && Object.keys(job.metadata).length > 0) && (
        <>
          <button ref={headerRef} type="button" aria-expanded={expanded} onClick={() => withScrollLock(() => setExpanded(!expanded))} className="mt-2 inline-flex items-center gap-1 text-[length:var(--fs-xs)] text-text-400 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-primary-100">
            <ChevronDownIcon size={12} className={chevronClass(expanded)} />
            {t('system.jobResult')}
          </button>
          <MessageExpandPanel open={expanded} innerClassName="overflow-hidden">
            {shouldRenderBody && (
              <div className="mt-2 min-w-0">
                {structured
                  ? <pre className="whitespace-pre-wrap break-words text-[length:var(--fs-sm)] font-mono">{job.body}</pre>
                  : <MarkdownRenderer content={job.body} />}
                {job.metadata && Object.keys(job.metadata).length > 0 && (
                  <pre className="mt-2 whitespace-pre-wrap break-words text-[length:var(--fs-xs)] font-mono text-text-400">{JSON.stringify(job.metadata, null, 2)}</pre>
                )}
              </div>
            )}
          </MessageExpandPanel>
        </>
      )}
      {job.fullOutput && <p className="mt-1 break-all text-[length:var(--fs-xs)] text-text-400">{t('system.jobFullOutput', { path: job.fullOutput })}</p>}
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
