import type { ReactNode } from 'react'
import { toolResultBlocks, toolResultText } from './toolResultContent'
import i18n from '../../../i18n'
import type { PiToolExecution } from '../../../omp/domain/index.js'
import { getToolExecutionStatus } from '../../../omp/domain/index.js'
import type { ToolConfig, ToolRegistry, ExtractedToolData, DiagnosticInfo, YieldResultData } from './types'
import { BashRenderer, QuestionRenderer, YieldRenderer } from './renderers'
import {
  FileReadIcon,
  FileWriteIcon,
  TerminalIcon,
  SearchIcon,
  GlobeIcon,
  BrainIcon,
  ChecklistIcon,
  QuestionIcon,
  TaskIcon,
  CheckCircleIcon,
  WrenchIcon,
} from './icons'
import { detectLanguage } from '../../../utils/languageUtils'

// ============================================
// Tool Matchers (复用的匹配函数)
// ============================================

const includes =
  (...keywords: string[]) =>
  (name: string) => {
    const lower = name.toLowerCase()
    return keywords.some(k => lower.includes(k))
  }

const exact =
  (...names: string[]) =>
  (name: string) => {
    const lower = name.toLowerCase()
    return names.some(n => lower === n)
  }

interface MetadataFileEntry {
  filePath?: string
  file?: string
  diff?: string
  patch?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
}

interface MetadataDiagnosticEntry {
  severity?: number
  message?: string
  range?: {
    start?: {
      line?: number
      character?: number
    }
  }
}

// ============================================
// Default Data Extractor
// ============================================

export function defaultExtractData(execution: PiToolExecution): ExtractedToolData {
  const { call, result: toolResult } = execution
  const inputObj = call.arguments as Record<string, unknown> | undefined
  const metadata =
    toolResult?.details && typeof toolResult.details === 'object' && !Array.isArray(toolResult.details)
      ? (toolResult.details as Record<string, unknown>)
      : undefined
  const nativeDetails =
    metadata?.nativeDetails && typeof metadata.nativeDetails === 'object'
      ? (metadata.nativeDetails as Record<string, unknown>)
      : undefined
  const normalized =
    metadata?.normalized && typeof metadata.normalized === 'object'
      ? (metadata.normalized as Record<string, unknown>)
      : undefined
  const output = toolResult ? toolResultText(toolResult) : undefined

  const result: ExtractedToolData = {}

  // Native inline image blocks (pi tool results carry ImageContent inline)
  if (toolResult) {
    const images = toolResultBlocks(toolResult).flatMap(block =>
      block.type === 'image'
        ? [
            {
              url: block.data.startsWith('blob:sha256:') ? '' : `data:${block.mimeType};base64,${block.data}`,
              mimeType: block.mimeType,
              block,
            },
          ]
        : [],
    )
    if (images.length > 0) result.images = images
  }

  // Input
  if (inputObj && Object.keys(inputObj).length > 0) {
    result.input = JSON.stringify(inputObj, null, 2)
    result.inputLang = 'json'
  }

  // Error
  if (getToolExecutionStatus(execution) === 'error') {
    const detailErrors = [metadata?.error, metadata?.mergeError, nativeDetails?.error, nativeDetails?.mergeError].filter(value => typeof value === 'string' && value.trim())
    result.error = [...new Set([output, ...detailErrors, execution.error].filter(Boolean))].join('\n') || 'Tool execution failed'
  }

  // FilePath
  if (metadata && typeof metadata.filepath === 'string') {
    result.filePath = metadata.filepath
  }
  if (!result.filePath && metadata && typeof metadata.resolvedPath === 'string') {
    // OMP read/glob 工具 details 里的解析路径
    result.filePath = metadata.resolvedPath
  }

  // Pi 原生截断字段：输出超限时 truncated=true 且给出完整日志路径（bash/read 等通用）
  result.truncated = metadata?.truncated === true
  result.fullOutputPath =
    typeof metadata?.fullOutputPath === 'string' && metadata.fullOutputPath ? metadata.fullOutputPath : undefined
  if (!result.filePath && inputObj?.filePath) {
    result.filePath = String(inputObj.filePath)
  }
  if (!result.filePath && typeof inputObj?.path === 'string') result.filePath = inputObj.path

  // Exit code
  if (metadata && typeof metadata.exit === 'number') {
    result.exitCode = metadata.exit
  }
  if (result.exitCode === undefined && typeof normalized?.exitCode === 'number') result.exitCode = normalized.exitCode
  const cwd = normalized?.cwd ?? metadata?.cwd ?? nativeDetails?.cwd
  if (typeof cwd === 'string') result.cwd = cwd

  // Diff / Files (from metadata)
  if (metadata) {
    if (Array.isArray(metadata.files) && metadata.files.length > 0) {
      // 仅对象条目（edit 系列，带 diff/before/after）走多文件卡片渲染。
      // OMP glob/grep/ast_edit 的 details.files 是 string[]（cwd 相对路径、无 diff），
      // 保持 files 为空，让分组路径列表走普通文本输出（与上游 PiUI 一致）；
      // 否则每个匹配会变成一张空卡片，目录路径还会因尾部斜杠丢失文件名。
      const fileEntries = metadata.files as unknown[]
      if (fileEntries.every(entry => typeof entry === 'object' && entry !== null)) {
        result.files = (fileEntries as MetadataFileEntry[]).map(file => ({
          filePath: file.filePath || file.file || 'unknown',
          diff: file.diff,
          patch: file.patch,
          before: file.before,
          after: file.after,
          additions: file.additions,
          deletions: file.deletions,
        }))
      }
    } else if (typeof metadata.patch === 'string') {
      // 标准 unified diff（edit 工具 details.patch），extractContentFromUnifiedDiff 可正确解析
      result.diff = metadata.patch
      // 从 filediff 获取统计
      if (metadata.filediff && typeof metadata.filediff === 'object') {
        const fd = metadata.filediff as { additions?: number; deletions?: number }
        if (fd.additions !== undefined || fd.deletions !== undefined) {
          result.diffStats = {
            additions: fd.additions || 0,
            deletions: fd.deletions || 0,
          }
        }
      }
    } else if (typeof metadata.diff === 'string') {
      // 兜底：display-oriented diff（带行号显示格式，SDK generateDiffString 产物），
      // 仅在没有标准 patch 时使用
      result.diff = metadata.diff
      // 从 filediff 获取统计
      if (metadata.filediff && typeof metadata.filediff === 'object') {
        const fd = metadata.filediff as { additions?: number; deletions?: number }
        if (fd.additions !== undefined || fd.deletions !== undefined) {
          result.diffStats = {
            additions: fd.additions || 0,
            deletions: fd.deletions || 0,
          }
        }
      }
    } else if (metadata.filediff && typeof metadata.filediff === 'object') {
      const fd = metadata.filediff as {
        patch?: string
        before?: string
        after?: string
        additions?: number
        deletions?: number
      }
      // 上游 v1.4.0+ metadata.filediff 用 patch 格式
      if (fd.patch) {
        result.diff = fd.patch
      } else if (fd.before !== undefined && fd.after !== undefined) {
        result.diff = { before: fd.before, after: fd.after }
      }
      if (fd.additions !== undefined || fd.deletions !== undefined) {
        result.diffStats = {
          additions: fd.additions || 0,
          deletions: fd.deletions || 0,
        }
      }
    }

    // 提取 diagnostics
    if (metadata.diagnostics && typeof metadata.diagnostics === 'object') {
      const diagMap = metadata.diagnostics as Record<string, MetadataDiagnosticEntry[]>
      const diagnostics: DiagnosticInfo[] = []

      for (const [file, items] of Object.entries(diagMap)) {
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          // severity: 1=error, 2=warning, 3=info, 4=hint
          const severityMap: Record<number, DiagnosticInfo['severity']> = {
            1: 'error',
            2: 'warning',
            3: 'info',
            4: 'hint',
          }
          diagnostics.push({
            file: file.split(/[/\\]/).pop() || file,
            severity: typeof item.severity === 'number' ? (severityMap[item.severity] ?? 'info') : 'info',
            message: item.message || '',
            line: item.range?.start?.line ?? 0,
            column: item.range?.start?.character ?? 0,
          })
        }
      }

      // 只保留 error 和 warning
      const filtered = diagnostics.filter(d => d.severity === 'error' || d.severity === 'warning')
      if (filtered.length > 0) {
        result.diagnostics = filtered
      }
    }
  }

  const patch = normalized?.patch ?? nativeDetails?.patch ?? nativeDetails?.diff
  if (!result.diff && typeof patch === 'string') result.diff = patch
  const outputMeta = (nativeDetails?.meta ?? metadata?.meta) as Record<string, unknown> | undefined
  const truncation = (outputMeta?.truncation ?? nativeDetails?.truncation ?? metadata?.truncation) as Record<string, unknown> | undefined
  const limits = [nativeDetails?.matchLimitReached, nativeDetails?.resultLimitReached, nativeDetails?.entryLimitReached,
    metadata?.matchLimitReached, metadata?.resultLimitReached, metadata?.entryLimitReached].filter(value => typeof value === 'number')
  const notices = [metadata?.notice, nativeDetails?.notice].filter((value): value is string => typeof value === 'string' && !!value.trim())
  // Public OMP results carry truncation/limits under details.meta; older results
  // and the normalized envelope may still use top-level nativeDetails fields.
  if (truncation && (truncation.truncated === true || typeof truncation.truncatedBy === 'string')) result.truncated = true
  if (!result.fullOutputPath && typeof nativeDetails?.fullOutputPath === 'string') result.fullOutputPath = nativeDetails.fullOutputPath
  if (!result.fullOutputPath && typeof truncation?.artifactId === 'string') result.fullOutputPath = `artifact://${truncation.artifactId}`
  if (result.truncated || limits.length > 0) {
    const shown = typeof truncation?.outputLines === 'number'
      ? i18n.t('message:truncation.linesShown', { count: truncation.outputLines })
      : i18n.t('message:truncation.outputTruncated')
    notices.push(`${shown}${result.fullOutputPath ? ` · ${i18n.t('message:truncation.fullOutput', { path: result.fullOutputPath })}` : ''}`)
    // Retain exact bounds, direction, partial-line/artifact limits and suggestions.
    if (truncation) notices.push(JSON.stringify(truncation))
    if (limits.length) notices.push(`Limits: ${limits.join(', ')}`)
  }
  if (outputMeta?.limits) notices.push(`Limits: ${JSON.stringify(outputMeta.limits)}`)
  if (outputMeta?.artifactError) notices.push(JSON.stringify(outputMeta.artifactError))
  if (notices.length) result.notice = [...new Set(notices)].join('\n')
  const detailImages: NonNullable<ExtractedToolData['images']> = []
  const collectImages = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectImages)
      return
    }
    if (!value || typeof value !== 'object') return
    const image = value as Record<string, unknown>
    if (typeof image.mimeType === 'string' && image.mimeType.startsWith('image/') && typeof image.data === 'string') {
      const block = { type: 'image' as const, data: image.data, mimeType: image.mimeType, ...('attachment' in image ? { attachment: image.attachment } : {}) }
      detailImages.push({ url: image.data.startsWith('blob:sha256:') ? '' : `data:${image.mimeType};base64,${image.data}`, mimeType: image.mimeType, block })
      return
    }
    if (typeof image.mimeType === 'string' && image.mimeType.startsWith('image/') && typeof image.url === 'string') {
      detailImages.push({ url: image.url, mimeType: image.mimeType, requiresAuth: image.requiresAuth === true })
      return
    }
    Object.values(image).forEach(collectImages)
  }
  collectImages(toolResult?.details)
  if (detailImages.length) result.images = [...(result.images ?? []), ...detailImages]

  // Output language from filePath
  if (result.filePath) {
    result.outputLang = detectLanguage(result.filePath)
  }

  // Output: 分运行状态取不同的字段
  if (output && !result.error) {
    result.output = output

    // 推断语言
    if (!result.outputLang && result.output) {
      const trimmed = result.output.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        result.outputLang = 'json'
      }
    }
  }

  return result
}

// ============================================
// Tool-Specific Data Extractors
// ============================================

/**
 * Yield（子代理完成工具）：入参是提交的结果（{data} / {error} / {type:'result'}
 * 用最近一轮助手文本作结果），结果 details 带最终状态 {status, data | error}。
 * 通用 Input/Output 块对它没意义，提取出结构化结果交给 YieldRenderer。
 */
export function yieldExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const args = execution.call.arguments as Record<string, unknown> | undefined
  const metadata =
    execution.result?.details &&
    typeof execution.result.details === 'object' &&
    !Array.isArray(execution.result.details)
      ? (execution.result.details as Record<string, unknown>)
      : undefined

  const nativeDetails = metadata?.nativeDetails && typeof metadata.nativeDetails === 'object' && !Array.isArray(metadata.nativeDetails)
    ? metadata.nativeDetails as Record<string, unknown> : undefined
  const details = nativeDetails ?? metadata
  const isError = getToolExecutionStatus(execution) === 'error' || details?.status === 'error' || details?.status === 'aborted'
  const data = details?.data ?? args?.data
  const error = isError ? base.error || toolResultText(execution.result) || String(details?.error ?? args?.error ?? 'Tool execution failed') : undefined
  const yieldResult: YieldResultData = { status: isError ? 'error' : 'success' }
  // A rejected submission must not present its success-shaped input as accepted.
  if (!isError && data !== undefined) yieldResult.data = data
  if (error) {
    yieldResult.error = error
    base.error = error
  }
  base.yieldResult = yieldResult

  // Keep the complete result available for reading/copying even when a structured
  // payload is presented. ACK deduplication must never swallow extra explanations.
  const rawOutput = toolResultText(execution.result)
  if (!isError && rawOutput) yieldResult.rawOutput = rawOutput
  delete base.input
  delete base.output
  if (!isError) delete base.error
  delete base.inputLang
  delete base.outputLang

  return base
}

function bashExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined
  const metadata =
    execution.result?.details &&
    typeof execution.result.details === 'object' &&
    !Array.isArray(execution.result.details)
      ? (execution.result.details as Record<string, unknown>)
      : undefined

  if (inputObj?.command) {
    base.input = String(inputObj.command)
    base.inputLang = 'bash'
  }

  const cwd = inputObj?.workdir ?? inputObj?.cwd ?? metadata?.workdir ?? metadata?.cwd
  if (typeof cwd === 'string' && cwd.trim()) {
    base.cwd = cwd.trim()
  }

  return base
}

function readExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)

  if (base.output) {
    const match = base.output.match(/<file[^>]*>([\s\S]*?)<\/file>/i)
    base.output = match ? match[1] : base.output
  }

  return base
}

function writeExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined
  const destination =
    typeof inputObj?.path === 'string'
      ? inputObj.path
      : typeof inputObj?.filePath === 'string'
        ? inputObj.filePath
        : base.filePath
  const scheme = destination?.match(/^([a-z][a-z\d+.-]*):\/\//i)?.[1].toLowerCase()

  // Only filesystem destinations imply file contents. Other URI schemes invoke
  // devices or send messages; their input is not a newly created file.
  if (scheme && scheme !== 'file' && scheme !== 'local' && scheme !== 'ssh') {
    if (base.filePath === destination) {
      delete base.filePath
      delete base.outputLang
    }
    return base
  }

  // 从 input.content 构造 diff（和 editExtractData 一致）
  // 状态控制由渲染层（OutputBlock）统一处理，extractData 只做数据转换
  if (!base.files && !base.diff && inputObj?.content && typeof inputObj.content === 'string') {
    base.diff = {
      before: '',
      after: inputObj.content,
    }
  }

  return base
}

function editExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined

  // 如果 metadata 没有 diff，从 input 构造
  if (!base.files && !base.diff && inputObj?.oldString && inputObj?.newString) {
    base.diff = {
      before: String(inputObj.oldString),
      after: String(inputObj.newString),
    }
  }
  if (!base.files && !base.diff && Array.isArray(inputObj?.edits) && inputObj.edits.length === 1) {
    const edit = inputObj.edits[0] as Record<string, unknown>
    if (typeof edit.oldText === 'string' && typeof edit.newText === 'string') {
      base.diff = { before: edit.oldText, after: edit.newText }
    }
  }

  return base
}

// ============================================
// Tool Registry
// 按优先级排列，第一个匹配的配置生效
// ============================================

export const toolRegistry: ToolRegistry = [
  // Bash 工具专用渲染器（终端风格：$ 命令、ANSI 输出、退出码、全屏）。
  // 外壳（ToolPartView compact/timeline、工具组 steps）与助手工具完全一致。
  { match: exact('bash'), icon: <TerminalIcon />, extractData: bashExtractData, renderer: BashRenderer },
  // Yield（子代理提交最终结果）：完成态专用样式
  { match: exact('yield'), icon: <CheckCircleIcon />, extractData: yieldExtractData, renderer: YieldRenderer },
  { match: exact('read'), icon: <FileReadIcon />, extractData: readExtractData },
  { match: exact('write'), icon: <FileWriteIcon />, extractData: writeExtractData },
  { match: exact('edit'), icon: <FileWriteIcon />, extractData: editExtractData },
  { match: exact('grep', 'find', 'ls'), icon: <SearchIcon /> },
  // Bash / Terminal
  {
    match: (name: string) => includes('bash', 'cmd', 'terminal', 'shell')(name) || exact('sh')(name),
    icon: <TerminalIcon />,
    extractData: bashExtractData,
    renderer: BashRenderer,
  },

  // Todo (must be before write/read to avoid TodoWrite matching "write")
  {
    match: includes('todo'),
    icon: <ChecklistIcon />,
  },

  // Task (子 agent)
  {
    match: exact('task'),
    icon: <TaskIcon />,
  },

  // Read file
  {
    match: includes('read', 'cat'),
    icon: <FileReadIcon />,
    extractData: readExtractData,
  },

  // Write file
  {
    match: includes('write', 'save'),
    icon: <FileWriteIcon />,
    extractData: writeExtractData,
  },

  // Edit file
  {
    match: includes('edit', 'replace', 'patch'),
    icon: <FileWriteIcon />,
    extractData: editExtractData,
  },

  // Search
  {
    match: includes('search', 'find', 'grep', 'glob'),
    icon: <SearchIcon />,
  },

  // Web / Network
  {
    match: includes('web', 'fetch', 'http', 'browse', 'network', 'exa'),
    icon: <GlobeIcon />,
  },

  // Think / Reasoning
  {
    match: includes('think', 'reason', 'plan'),
    icon: <BrainIcon />,
  },

  // Question
  {
    match: includes('question', 'ask'),
    icon: <QuestionIcon />,
    renderer: QuestionRenderer,
  },
]

// ============================================
// Registry Helpers
// ============================================

/**
 * 获取工具配置
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return toolRegistry.find(config => config.match(toolName))
}

/** Yield 是子代理提交最终结果的完成工具，行内展示走完成态专用样式 */
export function isYieldTool(toolName: string): boolean {
  return toolName.toLowerCase() === 'yield'
}

/**
 * 获取工具图标
 */
export function getToolIcon(toolName: string): ReactNode {
  const config = getToolConfig(toolName)
  return config?.icon ?? <WrenchIcon />
}

/**
 * 提取工具数据
 */
export function extractToolData(execution: PiToolExecution): ExtractedToolData {
  const config = getToolConfig(execution.call.name)
  if (config?.extractData) {
    return config.extractData(execution)
  }
  return defaultExtractData(execution)
}
