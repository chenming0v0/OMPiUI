import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { isTauri } from '../utils/tauri'
import { copyTextToClipboard, readTextFromClipboard } from '../utils/clipboard'
import { keybindingStore } from '../store/keybindingStore'
import { layoutStore } from '../store/layoutStore'

const FONT_FALLBACK = "'Fira Code', 'Noto Sans Mono CJK SC', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', ui-monospace, monospace"
function cssColor(name: string, fallback: string) {
  const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(parseFloat)
  if (parts.length < 3 || !parts.every(Number.isFinite)) return fallback
  const [h, saturation, lightness] = parts
  const s = saturation / 100, l = lightness / 100, a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

export function terminalViewportTheme() {
  const mode = document.documentElement.getAttribute('data-mode')
  const dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const background = cssColor('--bg-100', dark ? '#1a1a1a' : '#f5f3ef')
  const foreground = cssColor('--text-100', dark ? '#e8e0d5' : '#2d2a26')
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: dark ? '#4a4540' : '#d5d0c8',
    selectionForeground: foreground, selectionInactiveBackground: dark ? '#3a3530' : '#e5e0d8',
    black: background, red: dark ? '#e55561' : '#c9514a', green: dark ? '#8cc265' : '#4a9f4a',
    yellow: dark ? '#d4a656' : '#b58900', blue: dark ? '#6cb6ff' : '#3a7fc9',
    magenta: dark ? '#c678dd' : '#a04a9f', cyan: dark ? '#56b6c2' : '#3a9f9f', white: dark ? '#abb2bf' : '#655f58',
    brightBlack: dark ? '#5c6370' : '#6b6560', brightRed: dark ? '#ff6b7a' : '#e55561',
    brightGreen: dark ? '#a8e075' : '#6ab56a', brightYellow: dark ? '#e5b567' : '#d4a020',
    brightBlue: dark ? '#82cfff' : '#5a9fe0', brightMagenta: dark ? '#de8ef0' : '#c06abf',
    brightCyan: dark ? '#70d0dc' : '#5abfbf', brightWhite: dark ? '#ffffff' : '#2d2a26',
  }
}

/** Tab/shell-free viewport setup. Input is xterm onData (including its textarea IME), never DOM key text. */
export function createTerminalViewport(container: HTMLElement, touch: boolean, onInput: (text: string) => void, onFit: (cols: number, rows: number) => void) {
  const root = document.documentElement
  const terminal = new XTerm({
    theme: terminalViewportTheme(), fontFamily: FONT_FALLBACK, fontSize: 13, lineHeight: 1.2,
    cursorBlink: true, allowTransparency: true, scrollback: 10000, convertEol: false, disableStdin: true,
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon((_event, uri) => {
    if (isTauri()) void import('@tauri-apps/plugin-opener').then(mod => mod.openUrl(uri)).catch(() => window.open(uri))
    else window.open(uri, '_blank', 'noopener,noreferrer')
  }))
  terminal.open(container)
  const fit = () => {
    if (!container.isConnected || !container.clientWidth || !container.clientHeight) return
    fitAddon.fit()
    onFit(terminal.cols, terminal.rows)
  }
  const restyle = () => {
    const style = getComputedStyle(root)
    terminal.options.theme = terminalViewportTheme()
    terminal.options.fontFamily = style.getPropertyValue('--font-mono').trim() || FONT_FALLBACK
    terminal.options.fontSize = Math.max(parseInt(style.getPropertyValue('--fs-terminal'), 10) || 13, touch ? 14 : 1)
    terminal.options.lineHeight = Math.max(parseFloat(style.getPropertyValue('--fs-terminal-line-height')) || 1.2, touch ? 1.3 : 1)
    fit()
  }
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true
    const action = keybindingStore.findMatchingAction(event, 'terminal')
    if (action === 'terminal.copySelection' && terminal.hasSelection()) {
      event.preventDefault()
      void copyTextToClipboard(terminal.getSelection()).catch(() => {})
      terminal.clearSelection()
      return false
    }
    if (action === 'terminal.paste') {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'v') return false
      event.preventDefault()
      void readTextFromClipboard().then(onInput).catch(() => {})
      return false
    }
    return true
  })
  const data = terminal.onData(onInput)
  const selectionCopy = (event: MouseEvent) => {
    if (event.button === 0 && layoutStore.getState().terminalCopyOnSelect && terminal.hasSelection())
      void copyTextToClipboard(terminal.getSelection()).catch(() => {})
  }
  const contextPaste = (event: MouseEvent) => {
    if (!layoutStore.getState().terminalRightClickPaste) return
    if (terminal.hasSelection()) {
      event.preventDefault()
      void copyTextToClipboard(terminal.getSelection()).catch(() => {})
    } else if (window.isSecureContext || isTauri()) {
      event.preventDefault()
      void readTextFromClipboard().then(onInput).catch(() => {})
    }
  }
  terminal.element?.addEventListener('mouseup', selectionCopy)
  terminal.element?.addEventListener('contextmenu', contextPaste)
  terminal.textarea?.setAttribute('autocapitalize', 'none')
  terminal.textarea?.setAttribute('autocorrect', 'off')
  terminal.textarea?.setAttribute('autocomplete', 'off')
  terminal.textarea?.setAttribute('enterkeyhint', 'send')
  const resize = new ResizeObserver(fit)
  resize.observe(container)
  const theme = new MutationObserver(restyle)
  theme.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-mode', 'data-theme'] })
  restyle()
  let disposed = false
  void document.fonts?.ready.then(() => { if (!disposed) fit() })
  return { terminal, fit, dispose() {
    disposed = true
    resize.disconnect(); theme.disconnect(); data.dispose()
    terminal.element?.removeEventListener('mouseup', selectionCopy)
    terminal.element?.removeEventListener('contextmenu', contextPaste)
    terminal.dispose()
  } }
}
