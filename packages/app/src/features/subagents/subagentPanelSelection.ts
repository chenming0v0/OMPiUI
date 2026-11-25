import { layoutStore } from '../../store/layoutStore'
import { serverStore } from '../../store/serverStore'
import { paneLayoutStore } from '../../store/paneLayoutStore'

type Selection = { sessionId: string; generation: number; toolCallId?: string; index?: number; id?: string }
let selection: Selection | null = null
const listeners = new Set<() => void>()

export const subagentPanelSelection = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSnapshot: () => selection,
}

export function openSubagentPanel(sessionId: string, target: Pick<Selection, 'toolCallId' | 'index' | 'id'> = {}) {
  const pane = paneLayoutStore.allLeaves().find(leaf => leaf.sessionId === sessionId)
  if (pane) paneLayoutStore.focusPane(pane.id)
  selection = { ...target, sessionId, generation: serverStore.getActiveServerGeneration() }
  for (const listener of listeners) listener()
  layoutStore.addSubagentsTab('right')
}
