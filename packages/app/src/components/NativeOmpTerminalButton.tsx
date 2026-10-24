import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { createHostTerminal, listHostTerminals } from '../omp/transport/index.js'
import { resolveWorkspacePath } from '../omp/workspaces'
import { layoutStore } from '../store/layoutStore'
import { notificationStore } from '../store/notificationStore'
import { TerminalIcon } from './Icons'

const opening = new Map<string, Promise<void>>()

/** Only a user action calls this; mounting or browsing never creates a writer. */
export function openNativeOmpTerminal(sessionId: string, directory?: string): Promise<void> {
  if (!directory) return Promise.reject(new Error(i18n.t('components:terminal.nativeWorkspaceRequired')))
  const key = `${directory}:${sessionId}`
  const existing = opening.get(key)
  if (existing) return existing
  const operation = (async () => {
    const workspacePath = await resolveWorkspacePath(directory)
    if (!workspacePath) throw new Error(i18n.t('components:terminal.nativeWorkspaceRequired'))
    const { terminals } = await listHostTerminals(workspacePath)
    let terminal = terminals.find(item => item.nativeSessionId === sessionId && item.status === 'running')
    if (!terminal) {
      if (!window.confirm(i18n.t('components:terminal.nativeConfirm', { directory: workspacePath, sessionId }))) return
      terminal = await createHostTerminal(workspacePath, { nativeSessionId: sessionId })
    }
    layoutStore.addTerminalTab({
      id: terminal.id,
      title: terminal.title,
      shell: terminal.shell,
      cwd: terminal.cwd,
      status: 'connecting',
    })
  })().finally(() => opening.delete(key))
  opening.set(key, operation)
  return operation
}

export function openNativeOmpUtility(command: 'play' | 'stream', directory: string): Promise<void> {
  const key = `${directory}:utility:${command}`
  const existing = opening.get(key)
  if (existing) return existing
  const operation = (async () => {
    const workspacePath = await resolveWorkspacePath(directory)
    if (!workspacePath) throw new Error(i18n.t('components:terminal.nativeWorkspaceRequired'))
    const { terminals } = await listHostTerminals(workspacePath)
    let terminal = terminals.find(item => item.ompCommand === command && item.status === 'running')
    if (!terminal) {
      if (command === 'stream' && !window.confirm(i18n.t('components:terminal.nativeStreamConfirm', { directory: workspacePath }))) return
      terminal = await createHostTerminal(workspacePath, { ompCommand: command })
    }
    layoutStore.addTerminalTab({ id: terminal.id, title: terminal.title, shell: terminal.shell, cwd: terminal.cwd, status: 'connecting' })
  })().finally(() => opening.delete(key))
  opening.set(key, operation)
  return operation
}

export function NativeOmpTerminalButton({ sessionId, directory, className }: {
  sessionId?: string
  directory?: string
  className?: string
}) {
  const { t } = useTranslation('components')
  const [pending, setPending] = useState(false)
  return (
    <div className="flex items-center gap-1">
    <button
      type="button"
      disabled={!sessionId || !directory || pending}
      title={t('terminal.nativeHint')}
      aria-label={t('terminal.nativeOpen')}
      className={className ?? 'flex items-center gap-1 rounded px-2 py-1 text-text-300 hover:bg-bg-200 disabled:opacity-40'}
      onClick={() => {
        if (!sessionId || pending) return
        setPending(true)
        void openNativeOmpTerminal(sessionId, directory)
          .catch(error => notificationStore.push('error', t('terminal.nativeOpenFailed'), error instanceof Error ? error.message : String(error), sessionId))
          .finally(() => setPending(false))
      }}
    >
      <TerminalIcon size={16} />
      <span>{t('terminal.nativeOpen')}</span>
    </button>
      <details className="relative">
        <summary className="cursor-pointer rounded px-2 py-1 text-text-300 hover:bg-bg-200" aria-label={t('terminal.nativeUtilities')}>▾</summary>
        <div className="absolute bottom-full right-0 z-50 mb-1 min-w-48 rounded border border-border-200 bg-bg-100 p-1 shadow-lg">
          {(['play', 'stream'] as const).map(command => (
            <button
              key={command}
              type="button"
              disabled={!directory || pending}
              className="block w-full rounded px-3 py-2 text-left text-sm text-text-200 hover:bg-bg-200 disabled:opacity-40"
              onClick={event => {
                event.currentTarget.closest('details')?.removeAttribute('open')
                if (!directory || pending) return
                setPending(true)
                void openNativeOmpUtility(command, directory)
                  .catch(error => notificationStore.push('error', t('terminal.nativeOpenFailed'), error instanceof Error ? error.message : String(error), sessionId ?? ''))
                  .finally(() => setPending(false))
              }}
            >
              {t(`terminal.native${command === 'play' ? 'Play' : 'Stream'}`)}
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}
