import { layoutStore } from '../store/layoutStore'
import { serverStore } from '../store/serverStore'
import { TerminalInputQueue } from './terminalInput'

const queues = new Map<string, TerminalInputQueue>()

/** 输入与终端身份绑定，切页、移动面板只释放视图，不持久化输入正文。 */
export function getTerminalInputQueue(terminalId: string): TerminalInputQueue {
  let queue = queues.get(terminalId)
  if (!queue) {
    queue = new TerminalInputQueue()
    queues.set(terminalId, queue)
  }
  return queue
}

layoutStore.subscribe(() => {
  const terminals = new Set(layoutStore.getState().panelTabs
    .filter(tab => tab.type === 'terminal').map(tab => tab.terminalId ?? tab.id))
  for (const [id, queue] of queues) {
    if (terminals.has(id)) continue
    queue.dispose()
    queues.delete(id)
  }
})

serverStore.onServerChange(() => {
  for (const queue of queues.values()) queue.dispose()
  queues.clear()
})
