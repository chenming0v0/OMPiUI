import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ContentBlock } from '../../../../components'
import { MarkdownRenderer } from '../../../../components/MarkdownRenderer'
import { CheckCircleIcon } from '../icons'
import type { ToolRendererProps } from '../types'

// ============================================
// Yield Tool Renderer（子代理提交最终结果）
//
// 子代理 yield 的 data 是结构化负载（summary / files / report 等字段），
// 渲染成带标签的结果卡片，而不是原始 JSON 块；字符串字段按 Markdown
// 呈现（与助手消息一致），未知字段兜底成"标签 + 内容"段落。
// ============================================

export const YieldRenderer = memo(function YieldRenderer({ execution, partKey, data, onFullscreenChange }: ToolRendererProps) {
  const { t } = useTranslation('message')
  const yieldResult = data.yieldResult
  const isActive = !execution.result

  if (isActive) {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <div className="w-3 h-3 border-2 border-accent-main-100/30 border-t-accent-main-100 rounded-full animate-spin" />
        <span className="text-[length:var(--fs-sm)] reasoning-shimmer-text">{t('yield.submitting')}</span>
      </div>
    )
  }

  if (yieldResult?.status === 'error' || execution.result?.isError) {
    return (
      <ContentBlock
        stateKey={`message:${partKey}:yield-error`}
        label={t('yield.failed')}
        content={yieldResult?.error || t('yield.failed')}
        variant="error"
        defaultCollapsed={true}
        onFullscreenChange={onFullscreenChange}
        fullscreenId={`yield:${partKey}:error`}
      />
    )
  }

  const payload = yieldResult?.data
  if (!hasResultContent(payload)) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 text-[length:var(--fs-sm)] text-success-100">
        <CheckCircleIcon size={13} />
        <span>{t('yield.completed')}</span>
      </div>
    )
  }

  return <ResultCard payload={payload} />
})

// ============================================
// Result Card —— 结构化结果卡片
// ============================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasResultContent(payload: unknown): boolean {
  if (payload === undefined || payload === null) return false
  if (typeof payload === 'string') return payload.trim().length > 0
  if (isPlainObject(payload)) {
    return Object.values(payload).some(value => value !== undefined && value !== null && value !== '')
  }
  return true
}

/** 字段标签：已知字段走 i18n，未知字段美化后兜底 */
function fieldLabel(key: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const lookup = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  const pretty = key.replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase())
  if (!lookup) return pretty
  const translated = t(`yield.fields.${lookup}`, { defaultValue: '' })
  return translated || pretty
}

function ResultCard({ payload }: { payload: unknown }) {
  const { t } = useTranslation('message')

  if (typeof payload === 'string') {
    return (
      <CardShell>
        <div className="px-3 py-2">
          <MarkdownRenderer content={payload} />
        </div>
      </CardShell>
    )
  }
  if (!isPlainObject(payload)) {
    return (
      <CardShell>
        <div className="px-3 py-2 font-mono text-text-200 break-all">{String(payload)}</div>
      </CardShell>
    )
  }

  const entries = Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
  if (entries.length === 0) return null

  return (
    <CardShell>
      {entries.map(([key, value]) => (
        <ResultSection key={key} label={fieldLabel(key, t)} value={value} />
      ))}
    </CardShell>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border-200/40 bg-bg-100 overflow-hidden text-[length:var(--fs-sm)]">
      <div className="max-h-[420px] overflow-y-auto custom-scrollbar divide-y divide-border-200/30">{children}</div>
    </div>
  )
}

function SectionShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 min-w-0">
      <div className="text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function ResultSection({ label, value }: { label: string; value: unknown }) {
  if (typeof value === 'string') {
    return (
      <SectionShell label={label}>
        <MarkdownRenderer content={value} />
      </SectionShell>
    )
  }

  if (Array.isArray(value)) {
    return (
      <SectionShell label={label}>
        <div className="space-y-1.5">
          {value.map((item, index) => (
            <ValueRow key={index} value={item} />
          ))}
        </div>
      </SectionShell>
    )
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== '')
    return (
      <SectionShell label={label}>
        <div className="space-y-1">
          {entries.map(([key, v]) => (
            <KeyValueRow key={key} label={key} value={v} />
          ))}
        </div>
      </SectionShell>
    )
  }

  return (
    <SectionShell label={label}>
      <div className="font-mono text-text-200 break-all">{String(value)}</div>
    </SectionShell>
  )
}

/** 数组元素行：带 path/file 的对象渲染成文件行，字符串成段，其他兜底 JSON */
function ValueRow({ value }: { value: unknown }) {
  if (isPlainObject(value)) {
    const pathKey = ['path', 'filePath', 'file', 'file_path'].find(key => typeof value[key] === 'string' && value[key])
    if (pathKey) {
      const filePath = value[pathKey] as string
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const description = Object.entries(value)
        .filter(([key, v]) => key !== pathKey && typeof v === 'string' && v.trim())
        .map(([, v]) => v as string)
        .join(' · ')
      return (
        <div className="flex items-baseline gap-2 min-w-0" title={description || undefined}>
          <span className="shrink-0 font-mono text-text-300 break-all">{fileName}</span>
          {description && <span className="min-w-0 text-text-400 break-words">{description}</span>}
        </div>
      )
    }
    const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== '')
    if (entries.length > 0) {
      return (
        <div className="space-y-1">
          {entries.map(([key, v]) => (
            <KeyValueRow key={key} label={key} value={v} />
          ))}
        </div>
      )
    }
    return <div className="font-mono text-text-400 break-all">{JSON.stringify(value)}</div>
  }

  if (typeof value === 'string') {
    return (
      <div className="min-w-0">
        <MarkdownRenderer content={value} />
      </div>
    )
  }

  return <div className="font-mono text-text-400 break-all">{JSON.stringify(value)}</div>
}

function KeyValueRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="shrink-0 font-mono text-text-400">{label}</span>
      <span className="min-w-0 text-text-200 break-words">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
    </div>
  )
}
