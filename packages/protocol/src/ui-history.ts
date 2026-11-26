export type NotificationType = 'permission' | 'question' | 'completed' | 'error' | 'warning' | 'info'
export type NotificationTarget = 'session' | 'extensions'

export interface NotificationEntry {
  id: string
  type: NotificationType
  title: string
  body: string
  sessionId: string
  directory?: string
  timestamp: number
  read: boolean
  target?: NotificationTarget
}

export type NotificationChange =
  | { action: 'markRead' | 'dismiss'; id: string }
  | { action: 'markSessionRead'; sessionId: string; type?: NotificationType }
  | { action: 'markAllRead' | 'clear' }

export type CommandFeedbackStatus = 'ok' | 'error' | 'warning' | 'info'

export interface CommandFeedbackEntry {
  id: string
  sessionId: string
  command: string
  args?: string
  source?: string
  originalType?: string
  context?: string
  status: CommandFeedbackStatus
  message: string
  kind?: 'command' | 'notify'
  at: number
}

export interface ExtensionDiagnosticEntry extends Omit<CommandFeedbackEntry, 'sessionId'> {
  workerGeneration: string
  runtimeId: string
}

export type UiHistoryScope =
  | { kind: 'notifications' }
  | { kind: 'diagnostics' }
  | { kind: 'feedback'; sessionId: string }

export const UI_HISTORY_PATH = '/api/v1/host/ui-history'
