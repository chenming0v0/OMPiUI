import { useState } from 'react'
import type React from 'react'
import { ChevronDown } from 'lucide-react'
import './channelBoard.css'

export type LampTone = 'on' | 'warn' | 'busy' | 'off'

export function Lamp({ tone }: { tone: LampTone }) {
  return <span aria-hidden className="cb-lamp" data-tone={tone} />
}

/** 一句状态：小灯加文字，永远单行。 */
export function State({ tone, children }: { tone?: LampTone; children: React.ReactNode }) {
  return <span className="cb-st">{tone && <Lamp tone={tone} />}<span>{children}</span></span>
}

/** 一页一张卡：卡头是标题和安静的操作，卡里是圆角行。 */
export function Card({ children }: { children: React.ReactNode }) {
  return <section className="cb-card">{children}</section>
}

/** 卡头。subject 在窄屏会落到标题下面。 */
export function PageHead({ title, aside, subject }: {
  title: string
  aside?: React.ReactNode
  subject?: React.ReactNode
}) {
  return (
    <header className="cb-head" data-setting-label={title}>
      <h2>{title}</h2>
      {aside && <div className="cb-head-aside">{aside}</div>}
      {subject && <p className="cb-subject">{subject}</p>}
    </header>
  )
}

/**
 * 控制端的一组：组名那一行带实时状态，点它展开或收起。
 * mount 决定收起时内容留不留：stay 一直挂着（登录中途收起不会断），open 只在展开时挂载。
 */
export function Section({ id, icon, name, status, action, children, defaultOpen = false, open, onToggle, mount = 'open' }: {
  id: string
  icon: React.ReactNode
  name: string
  status?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
  mount?: 'open' | 'stay'
}) {
  const [own, setOwn] = useState(defaultOpen)
  const expanded = open ?? own
  const bodyId = `cb-sec-${id}`
  return (
    <div className="cb-sec" data-folded={expanded ? undefined : ''} data-testid={`section-${id}`}>
      <div className="cb-sec-head">
        <button type="button" className="cb-sec-tog touch-target-sm" aria-expanded={expanded} aria-controls={bodyId}
          onClick={() => { setOwn(!expanded); onToggle?.(!expanded) }}>
          <ChevronDown size={15} />{icon}<b>{name}</b>{status}
        </button>
        {expanded && action && <span className="cb-sec-act">{action}</span>}
      </div>
      {(expanded || mount === 'stay') && <div id={bodyId} className="cb-sec-body" hidden={!expanded}>{children}</div>}
    </div>
  )
}

export interface ChannelTile<T extends string> {
  id: T
  icon: React.ReactNode
  name: string
  state: string
  tone?: LampTone
}

/** 通道栏 + 面板：左边选哪一条，右边就是那一条。通道名下面那一行永远是这条通道的实时状态。 */
export function ChannelBoard<T extends string>({ tiles, selected, onSelect, testId, children }: {
  tiles: ChannelTile<T>[]
  selected: T
  onSelect: (id: T) => void
  testId?: string
  children: React.ReactNode
}) {
  return (
    <div className="cb-split-layout" data-testid={testId}>
      <div className="cb-rail">
        {tiles.map(tile => (
          <div key={tile.id} className="cb-srv" data-current={tile.id === selected ? '' : undefined}>
            <div className="cb-srv-line">
              <button type="button" className="cb-srv-main touch-target-sm" data-icon="" aria-pressed={tile.id === selected}
                aria-label={tile.name} aria-description={tile.state} onClick={() => onSelect(tile.id)}>
                {tile.icon}
                <span className="cb-srv-name">{tile.name}</span>
                <span className="cb-srv-meta"><State tone={tile.tone}>{tile.state}</State></span>
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="cb-stage">{children}</div>
    </div>
  )
}

/** 票据下面的几行设置。 */
export function PanelSplit({ children }: { children: React.ReactNode }) {
  return <div className="cb-rows">{children}</div>
}

export function PanelRow({ title, children, label }: {
  title: React.ReactNode
  children?: React.ReactNode
  label?: string
}) {
  return (
    <div className="cb-row" data-setting-label={label}>
      <div className="cb-row-title">{title}</div>
      {children && <div className="cb-row-control">{children}</div>}
    </div>
  )
}

/** 这条通道现在出不了码：二维码的位置放占位框，下面是一句标题和该做的那件事。 */
export function NextAction({ tone = 'idle', icon, title, children, actions, testId }: {
  tone?: 'idle' | 'warn' | 'ok' | 'busy'
  icon: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  testId?: string
}) {
  return (
    <div className="cb-ticket" data-tone={tone} data-testid={testId}>
      <div className="cb-ph">{icon}</div>
      <h3 className="cb-tk-title">{title}</h3>
      {children && <div className="cb-tk-text">{children}</div>}
      {actions}
    </div>
  )
}
