import type { CommandRecord } from '@ompiui/protocol'

class PiCommandStore {
  private byId = new Map<string, CommandRecord>()
  private snapshot: readonly CommandRecord[] = []
  private listeners = new Set<() => void>()
  private bytesById = new Map<string, number>()
  private bytes = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  upsert(command: CommandRecord): void {
    this.bytes -= this.bytesById.get(command.id) ?? 0
    this.byId.delete(command.id)
    const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength
    this.byId.set(command.id, command)
    this.bytesById.set(command.id, bytes)
    this.bytes += bytes
    for (const [id, item] of this.byId) {
      if (this.byId.size <= 256 && this.bytes <= 16 * 1024 * 1024) break
      if (id === command.id || item.status === 'accepted' || item.status === 'running') continue
      this.bytes -= this.bytesById.get(id) ?? 0
      this.bytesById.delete(id)
      this.byId.delete(id)
    }
    this.snapshot = [...this.byId.values()]
    this.notify()
  }

  get(commandId: string): CommandRecord | null {
    return this.byId.get(commandId) ?? null
  }

  getForSession(sessionId: string): readonly CommandRecord[] {
    return this.snapshot.filter(command => command.sessionId === sessionId)
  }

  getSnapshot(): readonly CommandRecord[] {
    return this.snapshot
  }

  clearSession(sessionId: string): void {
    let changed = false
    for (const [commandId, command] of this.byId) {
      if (command.sessionId !== sessionId) continue
      this.byId.delete(commandId)
      this.bytes -= this.bytesById.get(commandId) ?? 0
      this.bytesById.delete(commandId)
      changed = true
    }
    if (!changed) return
    this.snapshot = [...this.byId.values()]
    this.notify()
  }

  clearAll(): void {
    if (this.byId.size === 0) return
    this.byId.clear()
    this.bytesById.clear()
    this.bytes = 0
    this.snapshot = []
    this.notify()
  }
}

export const piCommandStore = new PiCommandStore()
