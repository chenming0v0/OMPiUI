// ============================================
// NotificationStore - Toast + 通知历史
// ============================================
//
// 统一管理所有通知：
// 1. Toast 弹窗（右上角，8 秒自动消失，悬停暂停）
// 2. 后端共享通知历史；本机错误与旧版本历史仍留在本端。

import { useSyncExternalStore } from 'react'
import type { NotificationChange, NotificationEntry, NotificationTarget, NotificationType } from '@ompiui/protocol'
import { serverStore } from './serverStore'
import i18n from '../i18n'
import { paneLayoutStore } from './paneLayoutStore'
import { activeSessionStore } from './activeSessionStore'
import { serverStorage } from '../utils/perServerStorage'

// ============================================
// Types
// ============================================

export type { NotificationEntry, NotificationTarget, NotificationType } from '@ompiui/protocol'

/** Local presentation callback, also used by sound and system notifications. */
export type NotificationPushListener = (type: NotificationType, entry: NotificationEntry) => void

export interface ToastItem {
  notification: NotificationEntry
  exiting: boolean
}

export interface NotificationPreferencesBackup {
  toastEnabled: boolean
}

interface NotificationState {
  toasts: ToastItem[]
  notifications: NotificationEntry[]
}

type Subscriber = () => void

// ============================================
// Constants
// ============================================

const TOAST_DURATION = 8000
const MAX_TOASTS = 3
const EXIT_ANIMATION_MS = 200
const STORAGE_KEY = 'ompiui:notifications'
const TOAST_ENABLED_KEY = 'ompiui:toast-enabled'
const MAX_NOTIFICATIONS = 50

// ============================================
// localStorage helpers
// ============================================

function loadNotifications(): NotificationEntry[] {
  try {
    const raw = serverStorage.get(STORAGE_KEY)
    if (!raw) return []
    const entries = (JSON.parse(raw) as NotificationEntry[]).slice(0, MAX_NOTIFICATIONS)
    for (const entry of entries) if ((entry.type as string) === 'link') entry.type = 'info'
    return entries
  } catch {
    return []
  }
}

function saveNotifications(entries: NotificationEntry[]) {
  try {
    serverStorage.set(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // quota exceeded
  }
}

// ============================================
// Store
// ============================================

class NotificationStore {
  private state: NotificationState = {
    toasts: [],
    notifications: loadNotifications(),
  }
  private local = this.state.notifications
  private shared: NotificationEntry[] = []
  private readonly announced = new Set<string>()
  private sharedChange?: (change: NotificationChange) => Promise<void>
  private subscribers = new Set<Subscriber>()
  private toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pushListeners = new Set<NotificationPushListener>()

  /** toast 弹窗总开关 */
  toastEnabled: boolean = (() => {
    try {
      return localStorage.getItem(TOAST_ENABLED_KEY) !== 'false'
    } catch {
      return true
    }
  })()
  constructor() {
    serverStore.onServerChange(() => {
      this.toastTimers.forEach(timer => clearTimeout(timer))
      this.toastTimers.clear()
      this.local = loadNotifications()
      this.shared = []
      this.announced.clear()
      this.state = { toasts: [], notifications: this.local }
      this.notify()
    })
  }


  subscribe = (callback: Subscriber): (() => void) => {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  private notify() {
    this.subscribers.forEach(cb => cb())
  }

  private persist() {
    saveNotifications(this.local)
  }

  getSnapshot = (): NotificationState => this.state

  setToastEnabled(enabled: boolean) {
    this.toastEnabled = enabled
    try {
      localStorage.setItem(TOAST_ENABLED_KEY, String(enabled))
    } catch {
      // Ignore storage write failures.
    }
    // 关闭时清掉当前所有 toast
    if (!enabled) this.dismissAllToasts()
  }

  /** 注册 push 后回调（声音播放等） */
  onPush(listener: NotificationPushListener): () => void {
    this.pushListeners.add(listener)
    return () => this.pushListeners.delete(listener)
  }

  // ============================================
  // 推送通知（加历史 + 弹 toast）
  // ============================================

  push(type: NotificationType, title: string, body: string, sessionId: string, directory?: string, options?: { target?: NotificationTarget }) {
    const entry: NotificationEntry = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      title,
      body,
      sessionId,
      directory,
      timestamp: Date.now(),
      read: false,
      target: options?.target,
    }

    this.updateLocal([entry, ...this.local].slice(0, MAX_NOTIFICATIONS))
    this.announce(entry)
  }

  onSharedChange(handler: (change: NotificationChange) => Promise<void>) {
    this.sharedChange = handler
  }

  replaceShared(entries: NotificationEntry[], added: ReadonlySet<string>) {
    const previous = new Set(this.shared.map(row => row.id))
    this.shared = entries
    const unread = new Set(this.shared.filter(row => !row.read).map(row => row.id))
    const toasts = this.state.toasts.filter(item => {
      const id = item.notification.id
      if (!previous.has(id) || unread.has(id)) return true
      this.clearToastTimer(id)
      return false
    })
    this.state = { ...this.state, toasts, notifications: this.history() }
    this.notify()
    for (const entry of [...entries].reverse()) {
      if (entry.read || this.announced.has(entry.id) || !added.has(entry.id)) continue
      this.announced.add(entry.id)
      if (this.announced.size > MAX_NOTIFICATIONS * 2) this.announced.delete(this.announced.values().next().value!)
      const completion = entry.type === 'completed' && entry.target !== 'extensions'
      if (completion && entry.sessionId === paneLayoutStore.getFocusedSessionId()) continue
      this.announce(completion ? {
        ...entry,
        title: activeSessionStore.getSessionMeta(entry.sessionId)?.title || entry.title,
        body: i18n.t('chat:notification.completed'),
      } : entry)
    }
  }

  private history(): NotificationEntry[] {
    return [...this.shared, ...this.local].sort((a, b) => b.timestamp - a.timestamp)
  }

  private updateLocal(entries: NotificationEntry[]) {
    this.local = entries
    this.state = { ...this.state, notifications: this.history() }
    this.persist()
    this.notify()
  }

  private announce(entry: NotificationEntry) {
    if (this.toastEnabled) {
      const toasts = [...this.state.toasts]
      if (toasts.length >= MAX_TOASTS) {
        const oldest = toasts.pop()
        if (oldest) this.clearToastTimer(oldest.notification.id)
      }
      toasts.unshift({ notification: entry, exiting: false })
      this.state = { ...this.state, toasts }
      this.notify()
      this.scheduleToastDismiss(entry.id)
    }
    for (const listener of this.pushListeners) {
      try { listener(entry.type, entry) } catch { /* Local presentation must not affect history. */ }
    }
  }

  markRead(id: string) {
    if (this.shared.some(row => row.id === id)) void this.sharedChange?.({ action: 'markRead', id })
    else this.markLocalRead(row => row.id === id)
  }

  markAllRead() {
    this.markLocalRead(() => true)
    if (this.shared.length) void this.sharedChange?.({ action: 'markAllRead' })
  }

  markSessionNotificationsRead(sessionId: string, type?: NotificationType) {
    const matches = (row: NotificationEntry) => row.sessionId === sessionId && (!type || row.type === type)
    this.markLocalRead(matches)
    if (this.shared.some(row => !row.read && matches(row))) void this.sharedChange?.({ action: 'markSessionRead', sessionId, type })
  }

  private markLocalRead(matches: (row: NotificationEntry) => boolean) {
    if (!this.local.some(row => !row.read && matches(row))) return
    this.updateLocal(this.local.map(row => !row.read && matches(row) ? { ...row, read: true } : row))
  }

  dismiss(id: string) {
    if (this.shared.some(row => row.id === id)) void this.sharedChange?.({ action: 'dismiss', id })
    else this.updateLocal(this.local.filter(row => row.id !== id))
  }

  clearAll() {
    this.updateLocal([])
    if (this.shared.length) void this.sharedChange?.({ action: 'clear' })
  }

  // ============================================
  // Toast 管理
  // ============================================

  private scheduleToastDismiss(id: string) {
    this.clearToastTimer(id)
    const timer = setTimeout(() => this.dismissToast(id), TOAST_DURATION)
    this.toastTimers.set(id, timer)
  }

  private clearToastTimer(id: string) {
    const timer = this.toastTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.toastTimers.delete(id)
    }
  }

  pauseToast(id: string) {
    this.clearToastTimer(id)
  }

  resumeToast(id: string) {
    const exists = this.state.toasts.some(t => t.notification.id === id && !t.exiting)
    if (exists) {
      this.scheduleToastDismiss(id)
    }
  }

  dismissToast(id: string) {
    this.clearToastTimer(id)
    const toasts = this.state.toasts.map(t => (t.notification.id === id ? { ...t, exiting: true } : t))
    this.state = { ...this.state, toasts }
    this.notify()

    setTimeout(() => {
      this.state = {
        ...this.state,
        toasts: this.state.toasts.filter(t => t.notification.id !== id),
      }
      this.notify()
    }, EXIT_ANIMATION_MS)
  }

  dismissAllToasts() {
    this.toastTimers.forEach(timer => clearTimeout(timer))
    this.toastTimers.clear()
    this.state = { ...this.state, toasts: [] }
    this.notify()
  }
}

// ============================================
// 单例 & React Hooks
// ============================================

export const notificationStore = new NotificationStore()

export function exportNotificationPreferencesBackup(): NotificationPreferencesBackup {
  return {
    toastEnabled: notificationStore.toastEnabled,
  }
}

export function importNotificationPreferencesBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const toastEnabled = typeof parsed?.toastEnabled === 'boolean' ? parsed.toastEnabled : true
  notificationStore.setToastEnabled(toastEnabled)
}

export function useNotificationStore() {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.getSnapshot)
}

/** 通知历史列表 */
export function useNotifications(): NotificationEntry[] {
  const state = useNotificationStore()
  return state.notifications
}

/** 未读通知数 */
export function useUnreadNotificationCount(): number {
  const state = useNotificationStore()
  return state.notifications.filter(n => !n.read).length
}

/** 未读 completed 通知对应的 sessionId 集合 */
export function useUnreadCompletedSessionIds(): Set<string> {
  const state = useNotificationStore()
  return new Set(state.notifications.filter(n => n.type === 'completed' && !n.read).map(n => n.sessionId))
}

/** 某个 session 是否有未读 completed 通知 */
export function useHasUnreadCompletedNotification(sessionId: string): boolean {
  const unreadCompletedSessionIds = useUnreadCompletedSessionIds()
  return unreadCompletedSessionIds.has(sessionId)
}
