// ============================================
// PendingSendStore - 在途发送的唯一来源
// ============================================
//
// 过去 pending 发送是 PiChatPane 的组件 state：
// - 切换会话/界面重挂载后状态丢失，气泡“凭空消失”，用户以为消息被吃掉；
// - 请求悬挂时没有任何兜底，气泡可能永久停在“正在提交消息”。
// 这里把在途发送提升为模块级 store，由真实请求的生命周期驱动：
//   创建 -> submitting，受理 -> accepted，失败/超时 -> 立即移除并给出可见错误。
// 组件只订阅，不拥有；挂载时机不再影响 pending 的存亡。

import { notificationStore } from '../../store/notificationStore'
import type { PendingSend } from './pendingSend'
import { describeSendFailure, describeSendNotSynced, type SendFailureText } from './sendFailure'

/** 已受理但历史迟迟不落盘时，最多再显示这么久，之后不再假装“正在提交”。 */
export const ACCEPTED_SYNC_TIMEOUT_MS = 45_000

export interface PendingSendAlert {
  sessionId: string | null
  serverGeneration: number
  kind: SendFailureText['kind']
  title: string
  message: string
}

type Unsubscribe = () => void

class PendingSendStore {
  private sends: readonly PendingSend[] = []
  private listeners = new Set<() => void>()
  private alertListeners = new Set<(alert: PendingSendAlert) => void>()
  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>()

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): readonly PendingSend[] => this.sends

  /** 发送失败/超时的可见提示：错误横幅在页面内，toast 在通知中心。 */
  onAlert = (listener: (alert: PendingSendAlert) => void): Unsubscribe => {
    this.alertListeners.add(listener)
    return () => {
      this.alertListeners.delete(listener)
    }
  }

  begin(send: PendingSend): void {
    this.commit([...this.sends, send])
  }

  /** 按 id 打补丁；不存在则忽略。 */
  patch(id: string, updater: (send: PendingSend) => PendingSend): void {
    const current = this.find(id)
    if (!current) return
    const next = updater(current)
    if (next === current) return
    this.commit(this.sends.map(send => (send.id === id ? next : send)))
  }

  update(updater: (current: readonly PendingSend[]) => readonly PendingSend[]): void {
    const next = updater(this.sends)
    if (next === this.sends) return
    this.commit(next)
  }

  /** 服务端已受理：仍保留合成行，直到原生历史出现同一条消息。 */
  accept(id: string): void {
    const current = this.find(id)
    if (!current || current.phase !== 'submitting') return
    this.patch(id, send => ({ ...send, phase: 'accepted' }))
    this.armSyncTimeout(current)
  }

  /** 成功落入历史或被显式清理。 */
  settle(id: string): void {
    this.clearTimer(id)
    if (!this.find(id)) return
    this.commit(this.sends.filter(send => send.id !== id))
  }

  /** 发送失败：立刻结束 pending，并把错误交给 UI 显示。 */
  fail(id: string, error: unknown): void {
    const send = this.find(id)
    this.settle(id)
    const text = describeSendFailure(error)
    this.emitAlert({
      sessionId: send?.sessionId ?? null,
      serverGeneration: send?.serverGeneration ?? 0,
      kind: text.kind,
      title: text.title,
      message: text.message,
    })
  }

  /** 测试与服务器切换用：清空在途状态，不产生提示。 */
  reset(): void {
    for (const timer of this.syncTimers.values()) clearTimeout(timer)
    this.syncTimers.clear()
    this.commit([])
  }

  private find(id: string): PendingSend | undefined {
    return this.sends.find(send => send.id === id)
  }

  private commit(next: readonly PendingSend[]): void {
    const live = new Set(next.map(send => send.id))
    for (const [id, timer] of [...this.syncTimers]) {
      if (!live.has(id)) {
        clearTimeout(timer)
        this.syncTimers.delete(id)
      }
    }
    this.sends = next
    this.listeners.forEach(listener => listener())
  }

  private clearTimer(id: string): void {
    const timer = this.syncTimers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.syncTimers.delete(id)
  }

  private armSyncTimeout(send: PendingSend): void {
    this.clearTimer(send.id)
    const timer = setTimeout(() => {
      this.syncTimers.delete(send.id)
      const current = this.find(send.id)
      if (!current || current.phase !== 'accepted') return
      this.settle(send.id)
      const text = describeSendNotSynced(Math.round(ACCEPTED_SYNC_TIMEOUT_MS / 1000))
      this.emitAlert({
        sessionId: send.sessionId,
        serverGeneration: send.serverGeneration,
        kind: text.kind,
        title: text.title,
        message: text.message,
      })
    }, ACCEPTED_SYNC_TIMEOUT_MS)
    this.syncTimers.set(send.id, timer)
  }

  private emitAlert(alert: PendingSendAlert): void {
    notificationStore.push('error', alert.title, alert.message, alert.sessionId ?? '')
    this.alertListeners.forEach(listener => listener(alert))
  }
}

export const pendingSendStore = new PendingSendStore()
