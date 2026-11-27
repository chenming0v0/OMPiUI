import type React from 'react'

export type AuthTone = 'success' | 'warning' | 'progress' | 'idle' | 'danger'

const toneDot: Record<AuthTone, string> = {
  success: 'bg-success-100',
  warning: 'bg-warning-100',
  progress: 'bg-accent-main-100 animate-pulse',
  idle: 'bg-text-500',
  danger: 'bg-danger-100',
}

const toneText: Record<AuthTone, string> = {
  success: 'text-success-100',
  warning: 'text-warning-100',
  progress: 'text-text-200',
  idle: 'text-text-400',
  danger: 'text-danger-100',
}

/** 状态胶囊：圆点 + 文案。role 由调用方决定，避免一页出现多个 status。 */
export function AuthStatusPill({ tone, icon, children, role }: {
  tone: AuthTone
  icon?: React.ReactNode
  children: React.ReactNode
  role?: 'status'
}) {
  return (
    <div role={role} className={`inline-flex w-fit max-w-full items-center gap-2 rounded-full border border-border-200/60 bg-bg-200/50 px-2.5 py-1 text-[length:var(--fs-xs)] ${toneText[tone]}`}>
      {icon ?? <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[tone]}`} />}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

/** 卡片内的错误提示条。 */
export function AuthAlert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="break-words rounded-lg border border-danger-100/25 bg-danger-100/10 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-danger-100">
      {children}
    </p>
  )
}

export const authPrimaryButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-accent-main-000 px-4 font-medium text-oncolor-100 transition-colors hover:bg-accent-main-200 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-main-100'

export const authSecondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-200 bg-bg-100 px-3 font-medium text-text-300 transition-colors hover:border-border-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-main-100'
