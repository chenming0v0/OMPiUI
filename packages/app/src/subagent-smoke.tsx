import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import type { PiToolExecution } from './omp/domain'
import { FullscreenProvider } from './contexts'
import { SessionNavigationContext } from './contexts/SessionNavigationContext'
import { TaskRenderer } from './features/message/tools/renderers/TaskRenderer'
import { SessionListItem } from './features/sessions'
import { SessionChildrenSlot } from './features/chat/sidebar/SessionChildrenSlot'
import { useChildSessions } from './features/chat/sidebar/childSessions'
import { listAllPiSessions, previewPiSession } from './omp/transport'
import { initializePiBackend } from './omp/bootstrapMockChat'
import { piSessionStateStore } from './omp/state'
import { themeStore } from './store/themeStore'
import { initOverlayScrollbars } from './lib/overlayScrollbar'
import { trackPiSession } from './omp/ompSessionIndex'
import { piSessionInfoToUiSession } from './omp/nativeSessionListModel'

themeStore.init()
initOverlayScrollbars()
await initializePiBackend()
const records = await listAllPiSessions()
const parentRecord = records.find(item => item.id === '01a0f3c0-0eaf-7000-8efa-0052a2da3d2b')!
const parent = piSessionInfoToUiSession(parentRecord)
const preview = await previewPiSession(parent.id)
piSessionStateStore.setState(parent.id, preview.state)
const entries = preview.branch.items
const call = entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.filter(block => block.type === 'toolCall' && block.name === 'task') : [])[0]
if (!call) throw new Error('Historical task call not found')
const result = entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === call.id ? [entry.message] : [])[0]
const execution: PiToolExecution = { call, result }
const lookup = new Map([[parent.id, parent]])

function Smoke() {
  const [selected, setSelected] = useState(parent.id)
  const [childText, setChildText] = useState('')
  const { sessions: children } = useChildSessions(selected, lookup)
  const navigate = (id: string, directory?: string) => {
    trackPiSession(id, directory)
    window.location.hash = `/session/${id}`
    setSelected(id)
  }
  const navigation = useMemo(() => ({ navigateToSession: navigate, currentSessionId: parent.id, currentDirectory: parent.directory }), [])
  useEffect(() => {
    if (selected === parent.id) return
    void previewPiSession(selected).then(data => {
      piSessionStateStore.setState(selected, data.state)
      const text = data.branch.items.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.filter(block => block.type === 'text').map(block => block.text) : []).join('\n')
      setChildText(text)
    })
  }, [selected])
  return <FullscreenProvider><SessionNavigationContext.Provider value={navigation}>
    <div className="flex h-screen bg-bg-100 text-text-100">
      <aside className="w-72 shrink-0 border-r border-border-200 p-3">
        <h1 className="mb-5 font-semibold">OMPiUI</h1>
        <SessionListItem session={parent} isSelected={selected === parent.id} onSelect={() => navigate(parent.id, parent.directory)} onDelete={() => { throw new Error('Smoke is read-only') }} onRename={() => { throw new Error('Smoke is read-only') }} preferTouchUi={false} />
        <SessionChildrenSlot parentSession={parent} selectedSessionId={selected} children={children} onSelect={child => navigate(child.id, child.directory)} />
      </aside>
      <main className="min-w-0 flex-1 p-8 overflow-y-auto">
        <h2 className="mb-6">{selected === parent.id ? parent.title : children.find(child => child.id === selected)?.title || selected}</h2>
        {selected === parent.id ? <TaskRenderer execution={execution} partKey="subagent-smoke" data={{}} /> : <article data-child-session-content className="whitespace-pre-wrap">{childText}</article>}
      </main>
    </div>
  </SessionNavigationContext.Provider></FullscreenProvider>
}
createRoot(document.getElementById('root')!).render(<Smoke />)
