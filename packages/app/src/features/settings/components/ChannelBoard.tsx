import type React from 'react'
import './channelBoard.css'

export type LampTone = 'on' | 'warn' | 'busy' | 'off'

export function Lamp({ tone }: { tone: LampTone }) {
  return <span aria-hidden className="cb-lamp" data-tone={tone} />
}

/** 页头：标题和右侧操作同一行，说明另起一行。subject 在窄屏会落到说明下面。 */
export function PageHead({ title, description, aside, subject }: {
  title: string
  description?: React.ReactNode
  aside?: React.ReactNode
  subject?: React.ReactNode
}) {
  return (
    <header className="cb-head" data-setting-label={title}>
      <h2>{title}</h2>
      {aside && <div className="cb-head-aside">{aside}</div>}
      {subject && <div className="cb-head-aside cb-subject">{subject}</div>}
      {description && <p>{description}</p>}
    </header>
  )
}

export interface ChannelTile<T extends string> {
  id: T
  icon: React.ReactNode
  name: string
  state: string
  tone?: LampTone
}

/** 通道条 + 面板。通道名下面那一行永远是这条通道的实时状态。 */
export function ChannelBoard<T extends string>({ tiles, selected, onSelect, testId, children }: {
  tiles: ChannelTile<T>[]
  selected: T
  onSelect: (id: T) => void
  testId?: string
  children: React.ReactNode
}) {
  return (
    <section className="cb-board" data-testid={testId}>
      <div className="cb-channels" data-dense={tiles.length >= 3 ? '' : undefined}
        style={{ '--cb-n': tiles.length } as React.CSSProperties}>
        {tiles.map(tile => (
          <button key={tile.id} type="button" className="cb-channel touch-target-sm" aria-pressed={tile.id === selected}
            aria-label={tile.name} aria-description={tile.state} onClick={() => onSelect(tile.id)}>
            <span className="cb-channel-name">{tile.icon}<span>{tile.name}</span></span>
            <span className="cb-channel-state">{tile.tone && <Lamp tone={tile.tone} />}<span>{tile.state}</span></span>
          </button>
        ))}
      </div>
      <div className="cb-panel">{children}</div>
    </section>
  )
}

/** 面板里的下半区：凭证或列表下面的几行设置。 */
export function PanelSplit({ children }: { children: React.ReactNode }) {
  return <div className="cb-split">{children}</div>
}

export function PanelRow({ title, hint, children, label }: {
  title: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
  label?: string
}) {
  return (
    <div className="cb-row" data-setting-label={label}>
      <div className="min-w-0">
        <div className="cb-row-title">{title}</div>
        {hint && <div className="cb-row-hint">{hint}</div>}
      </div>
      {children && <div className="cb-row-control">{children}</div>}
    </div>
  )
}

/** 这条通道现在该做的一件事：图标、一句标题、一段说明、动作。 */
export function NextAction({ tone = 'idle', icon, title, children, actions, testId }: {
  tone?: 'idle' | 'warn' | 'ok'
  icon: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  testId?: string
}) {
  return (
    <div className="cb-next" data-tone={tone} data-testid={testId}>
      <div className="cb-next-ic">{icon}</div>
      <div className="min-w-0">
        <h3>{title}</h3>
        {children && <div className="cb-next-body">{children}</div>}
        {actions && <div className="cb-actions">{actions}</div>}
      </div>
    </div>
  )
}

export function Steps({ children }: { children: React.ReactNode }) {
  return <div className="cb-steps">{children}</div>
}

export function Step({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div className="cb-step">
      <span aria-hidden className="cb-step-n">{index}</span>
      <div className="grid min-w-0 gap-2">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}
