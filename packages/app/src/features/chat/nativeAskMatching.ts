import { isJsonObject, type ExtensionUiDialogRequest } from '@ompiui/protocol'
import type { PiTimelineItem, PiToolExecution } from '../../omp/domain'

export type NativeAskRequest = Extract<ExtensionUiDialogRequest, { kind: 'ask' }>

export function askRequestKey(request: ExtensionUiDialogRequest): string {
  return JSON.stringify([request.sessionId, request.workerGeneration, request.requestId])
}

// 官方 ask 会清理回车并省略空的可选字段；只比较稳定的问题身份与选项。
function questionSignature(questions: unknown): string | undefined {
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const text = (value: string) => value.replaceAll('\r\n', '\n').replace(/\r+/g, ' ')
  const normalized = []
  for (const question of questions) {
    if (!isJsonObject(question) || typeof question.id !== 'string' || typeof question.question !== 'string' || !Array.isArray(question.options)) return undefined
    const labels: string[] = []
    for (const option of question.options) {
      if (!isJsonObject(option) || typeof option.label !== 'string') return undefined
      labels.push(text(option.label))
    }
    normalized.push([text(question.id), text(question.question), question.multi === true, labels])
  }
  return JSON.stringify(normalized)
}

/** 官方 RPC 没有来源调用 ID；仅在未完成工具与问卷一一对应时认领。 */
export function matchNativeAskRequests(items: PiTimelineItem[], pending: ExtensionUiDialogRequest[]): Map<string, NativeAskRequest> {
  const asks = pending.filter((request): request is NativeAskRequest => request.kind === 'ask')
  const matches = new Map<string, NativeAskRequest>()
  if (asks.length === 0) return matches
  const calls = new Map<string, PiToolExecution>()
  for (const item of items) {
    if (item.kind === 'tool_result') calls.set(item.execution.call.id, item.execution)
    if (item.kind !== 'assistant_message') continue
    for (const call of item.blocks) {
      if (call.type !== 'toolCall' || call.name !== 'ask') continue
      const execution = item.toolExecutions?.[call.id]
      calls.set(call.id, { ...execution, call, result: item.toolResults[call.id] ?? execution?.result })
    }
  }
  const candidates = [...calls.values()].filter(execution => execution.call.name === 'ask' && !execution.result && !execution.error && !execution.interruption && execution.completedAt === undefined)
  const requestsBySignature = new Map<string, NativeAskRequest[]>()
  for (const request of asks) {
    const signature = questionSignature(request.questions)
    if (signature) requestsBySignature.set(signature, [...(requestsBySignature.get(signature) ?? []), request])
  }
  for (const [signature, requests] of requestsBySignature) {
    const owners = candidates.filter(execution => questionSignature(execution.call.arguments.questions) === signature)
    if (requests.length === 1 && owners.length === 1) matches.set(owners[0].call.id, requests[0])
  }
  return matches
}
