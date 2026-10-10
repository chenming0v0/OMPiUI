import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type React from 'react'
import { DropdownMenu } from '../../../components/ui/DropdownMenu'
import { MenuItem } from '../../../components/ui/MenuItem'
import { ChevronDownIcon } from '../../../components/Icons'

const SettingLabelContext = createContext<string | undefined>(undefined)

export const settingsFieldClass =
  'min-w-0 w-full h-8 px-2.5 text-[length:var(--fs-sm)] rounded-md bg-bg-200 text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30'

export const settingsFieldAreaClass =
  'min-w-0 w-full px-2.5 py-2 text-[length:var(--fs-sm)] rounded-md bg-bg-200 text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30 resize-y leading-relaxed custom-scrollbar'

/**
 * Settings select — 设计系统下拉框（非原生 <select>）。
 * trigger 与 settingsFieldClass 同款外观，弹出层走 DropdownMenu + MenuItem，
 * 支持 ↑↓ 键盘导航、Esc 关闭、点击外部关闭。
 */
export interface SettingsSelectOption<T extends string = string> {
  value: T
  label: string
}

export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className,
  placeholder,
  matchTriggerWidth = true,
  menuMinWidth,
  zIndex = 400,
}: {
  value: T | undefined
  options: SettingsSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  disabled?: boolean
  className?: string
  /** 空值时 trigger 文案；不传则回落到空选项 label */
  placeholder?: string
  /** 弹出层是否与 trigger 同宽，默认 true */
  matchTriggerWidth?: boolean
  menuMinWidth?: number | string
  zIndex?: number
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const selected = options.find(option => option.value === value)
  const empty = value === undefined || value === ''
  const displayLabel = empty
    ? (placeholder ?? selected?.label ?? '')
    : (selected?.label ?? value ?? '')

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [isOpen])

  const open = () => {
    if (disabled) return
    setMenuWidth(triggerRef.current?.offsetWidth)
    setIsOpen(true)
  }

  const select = (next: T) => {
    onChange(next)
    setIsOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={ariaLabel}
        onClick={() => (isOpen ? setIsOpen(false) : open())}
        onKeyDown={event => {
          if (event.key === 'Escape' && isOpen) {
            event.preventDefault()
            event.stopPropagation()
            setIsOpen(false)
          }
        }}
        className={`${settingsFieldClass} flex items-center justify-between gap-2 text-left ${disabled ? 'opacity-55 cursor-not-allowed' : ''} ${className ?? ''}`}
      >
        <span className={`truncate ${empty || !selected ? 'text-text-400' : ''}`}>{displayLabel}</span>
        <ChevronDownIcon size={14} className={`shrink-0 text-text-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <DropdownMenu
        triggerRef={triggerRef}
        isOpen={isOpen}
        position="bottom"
        align="left"
        width={matchTriggerWidth ? menuWidth : undefined}
        {...(menuMinWidth !== undefined ? { minWidth: menuMinWidth } : {})}
        zIndex={zIndex}
      >
        <div
          id={listboxId}
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          className="p-1 max-h-64 overflow-y-auto custom-scrollbar"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setIsOpen(false)
              triggerRef.current?.focus()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
            const index = items.indexOf(document.activeElement as HTMLElement)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            items[(index + direction + items.length) % items.length]?.focus()
          }}
        >
          {options.map(option => (
            <MenuItem
              key={option.value}
              label={option.label}
              selected={option.value === value}
              selectionRole="option"
              onClick={() => select(option.value)}
            />
          ))}
        </div>
      </DropdownMenu>
    </>
  )
}

/**
 * Settings disclosure — 折叠块，替代原生 <details>。
 * chevron 旋转 + 网格行高动画。
 * 内容懒挂载：首次展开前不渲染子树（大块 JSON 高亮不会在页面加载时白跑），
 * 展开过一次后保持挂载，折叠不丢内部状态。
 */
export function SettingsDisclosure({
  title,
  count,
  defaultOpen = false,
  className,
  children,
}: {
  title: React.ReactNode
  count?: number
  defaultOpen?: boolean
  className?: string
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  // 展开过一次就保持挂载
  const [hasOpened, setHasOpened] = useState(defaultOpen)
  const panelId = useId()

  const toggle = () => {
    setIsOpen(value => {
      if (!value) setHasOpened(true)
      return !value
    })
  }

  return (
    <div className={className ?? ''}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
        className="group flex items-center gap-1.5 text-[length:var(--fs-xs)] text-text-300 transition-colors hover:text-text-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 rounded"
      >
        <ChevronDownIcon size={13} className={`shrink-0 text-text-400 transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`} />
        <span>{title}</span>
        {count !== undefined && <span className="text-text-500">({count})</span>}
      </button>
      <div
        id={panelId}
        inert={!isOpen}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden">
          {hasOpened ? <div className="settings-disclosure-body pt-2">{children}</div> : null}
        </div>
      </div>
    </div>
  )
}

// ============================================
// Shared Settings UI Primitives
//
// 设计原则：
// - SettingsSection 是唯一的面板容器（标题 + 描述 + 内容），可选折叠
// - 面板内的普通设置行不再重复画卡片
// - SettingsSubgroup 用于内部子分组
// ============================================

/**
 * Toggle switch — 36×20，即时生效。
 * 圆角 full，hover 有 ring 反馈，checked 时 accent 色。
 */
export function Toggle({
  enabled,
  onChange,
  ariaLabel,
  disabled,
}: {
  enabled: boolean
  onChange: () => void
  ariaLabel?: string
  disabled?: boolean
}) {
  const rowLabel = useContext(SettingLabelContext)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel ?? rowLabel}
      disabled={disabled}
      onClick={e => {
        e.stopPropagation()
        if (disabled) return
        onChange()
      }}
      className={`group/switch relative select-none rounded-full transition-colors touch-manipulation
        ring-[0.5px] ring-border-200 hover:ring-[1px]
        focus-visible:outline focus-visible:outline-[1px] focus-visible:outline-accent-main-100 focus-visible:outline-offset-2
        ${disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'}
        ${enabled ? 'bg-accent-main-100 !ring-[0px] hover:!ring-[1px] hover:ring-accent-main-100/60' : 'bg-bg-300'}`}
      style={{ width: 36, height: 20 }}
    >
      <div
        className={`absolute flex items-center justify-center top-[2px] left-[2px] rounded-full transition-transform
          bg-white ring-[0.5px] ring-inset ring-border-200
          ${enabled ? '!ring-[0px]' : ''}`}
        style={{
          height: 16,
          width: 16,
          transform: enabled ? 'translateX(16px)' : 'translateX(0px)',
        }}
      />
    </button>
  )
}

/**
 * Segmented control — 多选一切换器，保留滑块动画。
 */
export interface SegmentedControlProps<T extends string> {
  value: T
  options: { value: T; label: string; icon?: React.ReactNode }[]
  onChange: (value: T, event?: React.MouseEvent) => boolean | void
}

export function SegmentedControl<T extends string>({ value, options, onChange }: SegmentedControlProps<T>) {
  const activeIndex = Math.max(0, options.findIndex(o => o.value === value))

  return (
    <div
      className="bg-bg-200/60 p-1 rounded-lg flex border border-border-200/40 relative isolate"
      role="tablist"
      onKeyDown={e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
          const next = (activeIndex + dir + options.length) % options.length
          const accepted = onChange(options[next].value)
          e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[accepted === false ? activeIndex : next]?.focus()
        }
      }}
    >
      <div
        className="absolute top-1 bottom-1 left-1 bg-bg-000 rounded-md shadow-sm transition-transform duration-300 ease-out -z-10"
        style={{
          width: `calc((100% - 8px) / ${options.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          aria-label={opt.label}
          tabIndex={opt.value === value ? 0 : -1}
          onClick={e => {
            const accepted = onChange(opt.value, e)
            if (accepted === false) {
              e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[activeIndex]?.focus()
            }
          }}
          className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[length:var(--fs-md)] font-medium transition-colors duration-200
            ${opt.value === value ? 'text-text-100' : 'text-text-400 hover:text-text-200'}`}
        >
          {opt.icon}
          <span className="truncate">{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Setting row — 标题+描述左侧，控件右侧。
 * 无边框无圆角无背景色，纯行。有 icon 时标题与描述同一列对齐。
 */
export interface SettingRowProps {
  label: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  className?: string
  disabled?: boolean
  searchContext?: string
}

export function SettingRow({
  label,
  description,
  icon,
  children,
  onClick,
  className,
  disabled,
  searchContext,
}: SettingRowProps) {
  return (
    <div
      data-setting-label={typeof label === 'string' ? label : undefined}
      data-setting-context={searchContext}
      className={`w-full
        ${onClick && !disabled ? 'cursor-pointer' : ''}
        ${disabled ? 'opacity-55' : ''}
        ${className || ''}`}
      onClick={disabled ? undefined : onClick}
    >
      {/* 标题与开关同一行垂直居中；描述单独下一行 */}
      <div className="flex items-center justify-between gap-x-6 min-h-[20px]">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {icon && <span className="text-text-400 shrink-0">{icon}</span>}
          <div className="min-w-0 text-[length:var(--fs-md)] font-medium text-text-100 leading-snug">{label}</div>
        </div>
        <SettingLabelContext.Provider value={typeof label === 'string' ? label : undefined}>
          <div className="shrink-0 flex items-center">{children}</div>
        </SettingLabelContext.Provider>
      </div>
      {description && (
        <div className={`text-[length:var(--fs-xs)] text-text-300 leading-relaxed mt-0.5 ${icon ? 'pl-7' : ''}`}>
          {description}
        </div>
      )}
    </div>
  )
}

/**
 * Setting field — 标题/描述在上，控件在下（分段器、滑块等）。
 * 有 actions 时与标题同一行居中，描述单独下一行。
 */
export function SettingField({
  label,
  description,
  actions,
  children,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div data-setting-label={typeof label === 'string' ? label : undefined} className={className || ''}>
      <div className="flex items-center justify-between gap-3 min-h-[20px]">
        <div className="min-w-0 text-[length:var(--fs-md)] font-medium text-text-100 leading-snug">{label}</div>
        {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
      </div>
      {description && (
        <div className="text-[length:var(--fs-xs)] text-text-300 leading-relaxed mt-0.5">{description}</div>
      )}
      <div className="mt-2.5">{children}</div>
    </div>
  )
}

/**
 * Settings section — 有边界的设置面板，可选折叠，折叠不丢字段状态。
 */
export interface SettingsSectionProps {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  collapsible?: boolean
  status?: React.ReactNode
}

export function SettingsSection({ title, description, actions, children, className, collapsible = false, status }: SettingsSectionProps) {
  const heading = (
    <div className="min-w-0 flex-1 text-left">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-[length:var(--fs-base)] font-semibold text-text-100 leading-snug">{title}</h2>
        {status}
      </div>
      {description && (
        <p className="mt-1.5 text-[length:var(--fs-xs)] font-normal text-text-300 leading-relaxed">
          {description}
        </p>
      )}
    </div>
  )
  const content = <div className="settings-section-content flex flex-col gap-3">{children}</div>

  return (
    <section data-setting-label={title} className={`settings-section mb-4 last:mb-0 ${className || ''}`}>
      {collapsible ? (
        <SettingsDisclosure title={heading} defaultOpen className="settings-section-disclosure">
          {actions && <div className="flex justify-end gap-1.5 px-4 pt-3">{actions}</div>}
          {content}
        </SettingsDisclosure>
      ) : (
        <>
          <div className="settings-section-header flex items-start justify-between gap-3">
            {heading}
            {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
          </div>
          {content}
        </>
      )}
    </section>
  )
}

/**
 * Settings subgroup — section 内的子分组，用于聚合相关设置项。
 * 淡背景圆角，无边框，不与外层 section 形成嵌套视觉。
 */
export function SettingsSubgroup({
  title,
  description,
  children,
  className,
}: {
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div data-setting-label={title} className={className || ''}>
      {title && (
        <div className="mb-2.5 px-0.5">
          <div className="text-[length:var(--fs-sm)] font-medium text-text-100">{title}</div>
          {description && <div className="text-[length:var(--fs-xs)] text-text-400 mt-0.5 leading-relaxed">{description}</div>}
        </div>
      )}
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}
