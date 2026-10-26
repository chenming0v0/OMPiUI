/**
 * QuestionRenderer - 提问工具专用渲染器
 *
 * 从 input 获取问题结构，从 output 解析用户答案，
 * 渲染已回答状态（只读），与内嵌提问交互视觉一致。
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ContentBlock } from '../../../../components'
import { DefaultRenderer } from './DefaultRenderer'
import { CheckIcon } from '../../../../components/Icons'
import type { ToolRendererProps } from '../types'

// ============================================
// Types
// ============================================

interface QuestionOption {
  label: string
  description: string
}

interface QuestionInfo {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
}

interface QAPair {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
  timedOut?: boolean
  answers: string[] // 用户选择的答案
}

// ============================================
// Main
// ============================================

export function QuestionRenderer({ execution, partKey, data, onFullscreenChange }: ToolRendererProps) {
  const { t } = useTranslation('message')
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined
  const output = data.output
  const outer = execution.result?.details && typeof execution.result.details === 'object' && !Array.isArray(execution.result.details)
    ? execution.result.details as Record<string, unknown> : undefined
  const metadata = outer?.nativeDetails && typeof outer.nativeDetails === 'object' && !Array.isArray(outer.nativeDetails)
    ? outer.nativeDetails as Record<string, unknown> : outer

  // 从 input 拿问题结构，从 metadata/output 解析答案
  const qaList = useMemo(() => {
    return buildQAList(inputObj, output, metadata)
  }, [inputObj, output, metadata])

  // Queued or running questions are owned by the interactive layer; only show answers after a result.
  if (!execution.result) {
    return null
  }

  if (data.error || execution.result.isError || qaList.length === 0) {
    return <DefaultRenderer execution={execution} partKey={partKey} data={data} supplementary={false} onFullscreenChange={onFullscreenChange} />
  }

  return (
    <div className="space-y-2">
      {qaList.map((qa, i) => (
        <AnsweredQuestion key={i} qa={qa} />
      ))}
      {output ? <ContentBlock stateKey={`message:${partKey}:question-raw`} label={t('defaultRenderer.output')} content={output} defaultCollapsed onFullscreenChange={onFullscreenChange} fullscreenId={`question:${partKey}:raw`} /> : null}
    </div>
  )
}

// ============================================
// AnsweredQuestion — 只读的已回答问题
// ============================================

function AnsweredQuestion({ qa }: { qa: QAPair }) {
  const { t } = useTranslation('components')
  return (
    <div className="space-y-2">
      {/* 问题文字 */}
      <div>
        {qa.header && <div className="text-[length:var(--fs-xs)] text-text-400 font-medium mb-0.5">{qa.header}</div>}
        <div className="text-[length:var(--fs-md)] text-text-100">{qa.question}</div>
        {qa.timedOut && <p className="text-[length:var(--fs-xs)] text-warning-100">{t('dialog.timedOut')}</p>}
      </div>

      {/* 选项 — 一致的按钮组，已选中的高亮 */}
      <div className="flex flex-wrap gap-1.5">
        {qa.options.map((option, idx) => {
          const isSelected = qa.answers.includes(option.label)
          return (
            <span
              key={idx}
              title={option.description}
              className={`inline-flex min-h-7 items-start gap-1.5 px-2.5 py-1 text-[length:var(--fs-sm)] leading-5 rounded-md border ${
                isSelected ? 'border-text-100 text-text-100 bg-bg-300/40' : 'border-border-200/60 text-text-500'
              }`}
            >
              {qa.multiple && (
                <span className="inline-flex h-5 w-3.5 shrink-0 items-center justify-center">
                  <span
                    className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                      isSelected ? 'border-text-100 bg-text-100 text-bg-000' : 'border-border-300'
                    }`}
                  >
                    {isSelected && <CheckIcon size={10} className="shrink-0" />}
                  </span>
                </span>
              )}
              <span className="min-w-0 whitespace-normal break-words text-left">{option.label}</span>
            </span>
          )
        })}

        {/* 自定义答案（不在选项列表中的答案） */}
        {qa.answers
          .filter(a => !qa.options.some(o => o.label === a))
          .map((customAnswer, idx) => (
            <span
              key={`custom-${idx}`}
              className="inline-flex min-h-7 items-start gap-1.5 px-2.5 py-1 text-[length:var(--fs-sm)] leading-5 rounded-md border border-text-100 text-text-100 bg-bg-300/40"
            >
              {qa.multiple && (
                <span className="inline-flex h-5 w-3.5 shrink-0 items-center justify-center">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-text-100 bg-text-100 text-bg-000">
                    <CheckIcon size={10} className="shrink-0" />
                  </span>
                </span>
              )}
              <span className="min-w-0 whitespace-normal break-words text-left">{customAnswer}</span>
            </span>
          ))}
      </div>
    </div>
  )
}

// ============================================
// Parser
// ============================================

function buildQAList(
  inputObj: Record<string, unknown> | undefined,
  output: string | undefined,
  metadata: Record<string, unknown> | undefined,
): QAPair[] {
  // 从 input 获取问题结构
  const questions = extractQuestions(inputObj)
  // Native ask results use selectedOptions/customInput (single question), or
  // details.results keyed by question id. Notes, timeout and cancellation text
  // remain in the raw result rather than being guessed from the selected labels.
  const nativeResults = Array.isArray(metadata?.results) ? metadata.results : metadata && Array.isArray(metadata.selectedOptions) ? [metadata] : []
  if (nativeResults.length > 0) {
    return nativeResults.flatMap((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const result = value as Record<string, unknown>
      if (!Array.isArray(result.selectedOptions) || !result.selectedOptions.every(answer => typeof answer === 'string')) return []
      const rawQuestions = Array.isArray(inputObj?.questions) ? inputObj.questions : []
      const matchedIndex = typeof result.id === 'string' ? rawQuestions.findIndex(q => q && typeof q === 'object' && q.id === result.id) : index
      const question = questions[matchedIndex >= 0 ? matchedIndex : index]
      if (!question && typeof result.question !== 'string') return []
      return [{
        question: question?.question ?? String(result.question),
        header: question?.header,
        options: question?.options ?? (Array.isArray(result.options) ? result.options.filter((option): option is string => typeof option === 'string').map(label => ({ label, description: '' })) : []),
        multiple: question?.multiple ?? result.multi === true,
        answers: [...result.selectedOptions as string[], ...(typeof result.customInput === 'string' ? [result.customInput] : [])],
        timedOut: result.timedOut === true,
      }]
    })
  }

  // 优先从 metadata.answers 获取结构化答案（后端原始数组）
  const metadataAnswers = extractMetadataAnswers(metadata)

  if (metadataAnswers && questions.length > 0) {
    return questions.map((q, idx) => ({
      ...q,
      answers: metadataAnswers[idx] || [],
    }))
  }

  // fallback: 从 output 文本解析答案
  const answerMap = parseAnswersFromOutput(output)

  if (answerMap.size === 0) {
    return []
  }

  // 有问题结构：匹配答案
  if (questions.length > 0) {
    return questions.map((q, idx) => ({
      ...q,
      answers: answerMap.get(q.question) || answerMap.get(String(idx)) || [],
    }))
  }

  // 没有问题结构，只有 output：构造简单的 QA 对
  const pairs: QAPair[] = []
  for (const [question, answers] of answerMap) {
    pairs.push({
      question,
      options: answers.map(a => ({ label: a, description: '' })),
      answers,
    })
  }
  return pairs
}

function extractQuestions(inputObj: Record<string, unknown> | undefined): QuestionInfo[] {
  if (!inputObj) return []

  // questions 数组
  const raw = inputObj.questions
  if (Array.isArray(raw)) {
    return raw.flatMap(q => {
      if (!q || typeof q !== 'object' || typeof q.question !== 'string') return []
      return [{
        question: q.question,
        header: typeof q.header === 'string' ? q.header : undefined,
        options: Array.isArray(q.options)
          ? q.options.flatMap((o: unknown) => o && typeof o === 'object' && 'label' in o && typeof o.label === 'string'
            ? [{ label: o.label, description: 'description' in o && typeof o.description === 'string' ? o.description : '' }] : [])
          : [],
        multiple: q.multi === true || q.multiple === true,
      }]
    })
  }

  return []
}

/**
 * 从 metadata.answers 提取结构化答案（后端原始 string[][] 格式）
 */
function extractMetadataAnswers(metadata: Record<string, unknown> | undefined): string[][] | undefined {
  if (!metadata?.answers || !Array.isArray(metadata.answers)) return undefined
  const answers = metadata.answers as unknown[][]
  // 验证结构：应该是 string[][] 格式
  if (answers.every(a => Array.isArray(a) && a.every(v => typeof v === 'string'))) {
    return answers as string[][]
  }
  return undefined
}

/**
 * 从 output 文本解析 "question"="answer" 对
 *
 * 后端格式：多选答案用 ", " 拼接（如 "question"="A, B"）
 * 需要拆分逗号分隔的答案
 */
function parseAnswersFromOutput(output: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!output) return map

  const regex = /"([^"]*)"="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(output)) !== null) {
    const question = match[1]
    const rawAnswer = match[2]
    // 后端用 answer.join(", ") 拼接多选答案，这里拆回来
    const answers = rawAnswer
      .split(', ')
      .map(s => s.trim())
      .filter(Boolean)
    map.set(question, answers)
  }

  return map
}
