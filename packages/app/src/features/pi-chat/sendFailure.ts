// ============================================
// 发送失败的用户可见文案
// ============================================
//
// 发送链路的错误过去只进 uiErrorHandler，而它是静默的（errorHandling.ts 的
// toast 仍是 TODO），用户看不到任何提示。这里统一把传输层错误翻译成
// 可见文案，供 toast / 输入区错误横幅复用。

import i18n from '../../i18n'

export type SendFailureKind = 'rejected' | 'timeout' | 'not-synced'

export interface SendFailureText {
  kind: SendFailureKind
  title: string
  message: string
}

function message(key: string, options?: Record<string, unknown>): string {
  const value = i18n.t(key, options as never)
  return typeof value === 'string' ? value : String(value)
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError') return true
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /timed? ?out|timeout/i.test(raw)
}

/** 从传输层错误里取出最有用的一句：优先错误码，其次去掉 URL 前缀的响应体。 */
export function sendFailureDetail(error: unknown): string {
  const record = error as { code?: unknown; message?: unknown } | null
  const code = typeof record?.code === 'string' ? record.code : undefined
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : typeof record?.message === 'string' ? record.message : ''
  const withoutUrl = raw.replace(/^https?:\/\/\S+\s+/, '').replace(/\s+/g, ' ').trim()
  const detail = [code, withoutUrl].filter(Boolean).join(' · ')
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
}

export function describeSendFailure(error: unknown): SendFailureText {
  if (isTimeoutError(error)) {
    return {
      kind: 'timeout',
      title: message('chat:chatArea.sendFailedTitle'),
      message: message('chat:chatArea.sendTimedOutBody'),
    }
  }
  const detail = sendFailureDetail(error)
  return {
    kind: 'rejected',
    title: message('chat:chatArea.sendFailedTitle'),
    message: detail
      ? message('chat:chatArea.sendFailedBody', { detail })
      : message('chat:chatArea.sendFailedBodyNoDetail'),
  }
}

export function describeSendNotSynced(seconds: number): SendFailureText {
  return {
    kind: 'not-synced',
    title: message('chat:chatArea.sendNotSyncedTitle'),
    message: message('chat:chatArea.sendNotSyncedBody', { seconds }),
  }
}
