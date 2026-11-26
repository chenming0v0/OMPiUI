import type { SessionInfo } from './vendor/pi-coding-agent'

class PiSessionInfoStore {
  private all: SessionInfo[] = []
  private byCwd = new Map<string, SessionInfo[]>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  replaceAll(sessions: SessionInfo[]): SessionInfo[] {
    this.all = sessions
    this.notify()
    return this.all
  }

  replaceForCwd(cwd: string, sessions: SessionInfo[]): SessionInfo[] {
    this.byCwd.set(pathKey(cwd), sessions)
    this.notify()
    return sessions
  }

  remove(sessionId: string): void {
    this.all = this.all.filter(item => item.id !== sessionId)
    for (const [cwd, sessions] of this.byCwd) {
      if (sessions.some(item => item.id === sessionId)) this.byCwd.set(cwd, sessions.filter(item => item.id !== sessionId))
    }
    this.notify()
  }

  getAll(): readonly SessionInfo[] {
    return this.all
  }

  getForCwd(cwd: string): readonly SessionInfo[] {
    return this.byCwd.get(pathKey(cwd)) ?? []
  }

  clear(): void {
    this.all = []
    this.byCwd.clear()
    this.notify()
  }
}

export const piSessionInfoStore = new PiSessionInfoStore()

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
