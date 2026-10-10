import { useCallback, useEffect, useState, useSyncExternalStore, type SetStateAction } from 'react'
import type { Attachment } from '../../attachment'
import {
  getComposerDraft,
  hydrateComposerDraft,
  subscribeComposerDraft,
  updateComposerDraft,
  type ComposerDraft,
} from './composerDraftStore'

export function useComposerDraft(key?: string) {
  const [localDraft, setLocalDraft] = useState<ComposerDraft>({ text: '', attachments: [], ready: true })
  const draft = useSyncExternalStore(
    subscribeComposerDraft,
    () => key ? getComposerDraft(key) : localDraft,
    () => localDraft,
  )
  useEffect(() => {
    if (key) void hydrateComposerDraft(key)
  }, [key])

  const updateDraft = useCallback((update: (current: ComposerDraft) => ComposerDraft) => {
    if (key) updateComposerDraft(key, update)
    else setLocalDraft(update)
  }, [key])
  const setText = useCallback((next: SetStateAction<string>) => {
    updateDraft(current => ({ ...current, text: typeof next === 'function' ? next(current.text) : next }))
  }, [updateDraft])
  const setAttachments = useCallback((next: SetStateAction<Attachment[]>) => {
    updateDraft(current => ({
      ...current,
      attachments: typeof next === 'function' ? next(current.attachments) : next,
    }))
  }, [updateDraft])

  return { ...draft, setText, setAttachments }
}
