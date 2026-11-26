import { useEffect, useEffectEvent, useRef } from 'react'
import { readExcludedPathRevisions } from '../omp/files'

const POLL_INTERVAL_MS = 3000

type RevisionChange = { path: string; missing: boolean }

/** Reconcile viewed paths only; never enumerate excluded trees to find changes. */
export function useExcludedPathRevisions(
  directory: string | undefined,
  pathsKey: string,
  serverGeneration: number,
  onChange: (changes: RevisionChange[]) => void,
) {
  const previous = useRef<{ directory: string; serverGeneration: number; revisions: Map<string, string | null> } | null>(null)
  const notify = useEffectEvent(onChange)
  useEffect(() => {
    if (!directory || !pathsKey) {
      previous.current = null
      return
    }
    const paths = pathsKey.split('\0')
    const baseline = previous.current
    const revisions = new Map<string, string | null>()
    if (baseline?.directory === directory && baseline.serverGeneration === serverGeneration) {
      for (const path of paths) {
        const revision = baseline.revisions.get(path)
        if (revision !== undefined) revisions.set(path, revision)
      }
    }
    previous.current = { directory, serverGeneration, revisions }
    const controller = new AbortController()
    let inFlight = false
    let supported = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (inFlight || !supported || controller.signal.aborted || document.hidden) return
      clearTimeout(timer)
      inFlight = true
      try {
        const next = await readExcludedPathRevisions(directory, paths, controller.signal)
        if (controller.signal.aborted) return
        const changes: RevisionChange[] = []
        paths.forEach((path, index) => {
          const revision = next[index]
          // Revalidate once after taking the initial baseline: the original read
          // may already have finished before the first metadata request.
          if (revisions.get(path) !== revision) changes.push({ path, missing: revision === null })
          revisions.set(path, revision)
        })
        if (changes.length) notify(changes)
      } catch (error) {
        // Older servers still send regular watcher events; don't keep polling an unknown command.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'UNKNOWN_COMMAND') supported = false
      } finally {
        inFlight = false
        if (supported && !controller.signal.aborted) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }
    void poll()
    document.addEventListener('visibilitychange', poll)
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [directory, pathsKey, serverGeneration])
}
