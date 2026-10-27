import { memo, useMemo } from 'react'
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
import { ChevronDownIcon, UsersIcon } from '../../../components/Icons'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { useDisclosureScrollLock } from '../../../hooks'
import { useNow } from '../../../hooks/useNow'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'
import { MSG_SPACING } from '../messageSpacing'
import { ToolGroup } from './ToolGroup'
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
    return (
      <div className="min-w-0">
        {jobs.map((job, index) => (
          <BackgroundJobRow key={`${job.id}:${index}`} job={job} partKey={`${item.entryId}:${job.id}:${index}`} />
        ))}
      </div>
    )
  }
  const text = customMessageText(item)
  return text.trim() ? <MarkdownRenderer content={text} /> : null
}

/** 后台任务沿用普通工具卡片的行样式（同样的图标列、title、耗时、折叠）。
 *  之前这里自己写了一套卡片 + header + 状态徽标 + 结果小字，与其余工具完全
 *  不同的视觉语言；现在把 job 合成一次工具执行，交给 ToolGroup 渲染。 */
function BackgroundJobRow({ job, partKey }: { job: BackgroundJobView; partKey: string }) {
  const { t } = useTranslation('message')
  const execution = useMemo(() => backgroundJobExecution(job), [job])
  return (
    <section className="min-w-0" aria-label={t('system.backgroundJob', { name: job.name })}>
      <ToolGroup
        groupId={partKey}
        executions={[execution]}
        isStreaming={job.status === 'running' || job.status === 'pending'}
        nameOverride={t('system.jobLabel')}
        plain
      />
    </section>
  )
}

const RUNNING_JOB_STATUSES = new Set(['running', 'pending', 'started', 'queued'])

/**
 * 把后台任务投递合成一次工具执行：type 决定沿用哪个工具的图标/渲染器
 * （bash 走终端样式、task 走子代理样式），name 作为行内 title。
 * 没有真实起止时间，用 0 → durationMs 表示耗时，只影响时长显示。
 */
function backgroundJobExecution(job: BackgroundJobView): PiToolExecution {
  // 只有 bash / task 这两类原生 job 有对应的工具渲染器；其余（含未知类型）
  // 统一走通用工具卡片，避免误用终端渲染器和它的全屏上下文依赖。
  const rawType = (job.type ?? '').trim().toLowerCase()
  const toolName = rawType === 'bash' || rawType === 'task' ? rawType : 'job'
  const callId = `job:${job.id}`
  const isBash = toolName.toLowerCase() === 'bash'
  const call: PiToolExecution['call'] = {
    type: 'toolCall',
    id: callId,
    name: toolName,
    arguments: isBash ? { command: job.name } : { description: job.name },
  }

  if (RUNNING_JOB_STATUSES.has(job.status)) return { call, isRunning: true, startedAt: 0 }

  const text = [job.body.trim(), ...job.errors].filter(Boolean).join('\n\n') || job.summary || ''
  const failed = job.status === 'failed' || job.status === 'aborted' || job.errors.length > 0
  // 头部耗时由 ToolPartView 从 startedAt/completedAt 算，原生 duration 是
  // 「5m 44s」这种字符串，先折算成毫秒才能复用同一套格式化。
  const durationMs = job.durationMs ?? parseDurationLabel(job.duration)
  return {
    call,
    startedAt: durationMs !== undefined ? 0 : undefined,
    completedAt: durationMs,
    result: {
      role: 'toolResult',
      toolCallId: callId,
      toolName,
      content: [{ type: 'text', text }],
      isError: failed,
      timestamp: durationMs,
    } as unknown as PiToolExecution['result'],
  }
}

const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi
const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** 解析原生 "1m 11s" / "332ms" 形式的耗时为毫秒；无法解析时返回 undefined。 */
function parseDurationLabel(label: string | undefined): number | undefined {
  if (!label) return undefined
  let total = 0
  let matched = false
  for (const match of label.matchAll(DURATION_PART)) {
    matched = true
    total += Number.parseFloat(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()]
  }
  return matched ? Math.round(total) : undefined
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