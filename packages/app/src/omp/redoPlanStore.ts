import { piBranchStore, piSessionStateStore } from './state/index.js'
import type { SessionEntry } from './domain'
import type { NativeTreeNode } from '../components/sessionTreeGraph'
import { refreshPiSessionState } from './controllers/index.js'
import { isJsonObject } from '@ompiui/protocol'

/**
 * Redo 计划共享 store。
 *
 * pi 的 undo 就是树导航，redo 是纯前端计划：撤销点 + 被裁分支上每个
 * 用户回合的落点 checkpoint。计划在聊天输入区（undo 按钮）和会话树
 * 面板（导航到早期节点）都可能产生，所以收到 store 里跨组件共享，
 * 并用 sessionStorage 持久化（页面刷新后可复活）。
 */
export interface RedoPlan {
  epoch: string
  undoLeafId: string | null
  checkpoints: string[]
  restored: number
}

const STORAGE_PREFIX = 'ompiui-redo-plan:'

function readStoredPlan(sessionId: string): RedoPlan | null {
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${sessionId}`)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<RedoPlan>
    if (typeof value.epoch !== 'string' || !value.epoch) return null
    if (!Array.isArray(value.checkpoints) || value.checkpoints.some(item => typeof item !== 'string')) return null
    const restored = value.restored
    if (typeof restored !== 'number' || !Number.isInteger(restored) || restored < 0 || restored >= value.checkpoints.length) return null
    if (value.undoLeafId !== null && typeof value.undoLeafId !== 'string') return null
    return {
      epoch: value.epoch,
      undoLeafId: value.undoLeafId ?? null,
      checkpoints: value.checkpoints,
      restored,
    }
  } catch {
    return null
  }
}

function persistPlan(sessionId: string, plan: RedoPlan | null): void {
  try {
    const key = `${STORAGE_PREFIX}${sessionId}`
    if (plan) window.sessionStorage.setItem(key, JSON.stringify(plan))
    else window.sessionStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

class RedoPlanStore {
  private plans = new Map<string, RedoPlan>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPlan(sessionId: string): RedoPlan | null {
    // 首次读取时从 sessionStorage 复活（页面刷新后内存为空）
    if (!this.plans.has(sessionId)) {
      const stored = readStoredPlan(sessionId)
      if (stored) this.plans.set(sessionId, stored)
    }
    return this.plans.get(sessionId) ?? null
  }

  setPlan(sessionId: string, plan: RedoPlan | null): void {
    const current = this.plans.get(sessionId) ?? null
    if (!plan) this.plans.delete(sessionId)
    else this.plans.set(sessionId, plan)
    persistPlan(sessionId, plan)
    if (current === plan) return
    for (const listener of this.listeners) listener()
  }
}

export const redoPlanStore = new RedoPlanStore()

/** Capture one native landing entry per user turn, on the original branch only. */
export function captureRedoCheckpoints(sessionId: string, entryId: string, tree?: NativeTreeNode[], leafId?: string | null): string[] {
  let entries = piBranchStore.getData(sessionId)?.items ?? []
  if (tree) {
    const head = piSessionStateStore.getState(sessionId)?.head
    const currentLeaf = leafId === undefined && isJsonObject(head) && typeof head.leafId === 'string' ? head.leafId : leafId
    const byId = new Map<string, SessionEntry>()
    const stack = [...tree]
    while (stack.length) {
      const node = stack.pop()!
      if (typeof node.entry.id !== 'string' || byId.has(node.entry.id)) continue
      byId.set(node.entry.id, node.entry as unknown as SessionEntry)
      stack.push(...node.children)
    }
    const path: SessionEntry[] = []
    const seen = new Set<string>()
    let cursor = currentLeaf
    while (cursor && !seen.has(cursor)) {
      const entry = byId.get(cursor)
      if (!entry) return []
      seen.add(cursor)
      path.push(entry)
      cursor = entry.parentId
    }
    entries = path.reverse()
  }
  const index = entries.findIndex(entry => entry.id === entryId)
  if (index < 0) return []
  const checkpoints: string[] = []
  let landing: string | undefined
  const target = entries[index]!
  const targetIsUser = target.type === 'message' && target.message.role === 'user'
  for (const entry of entries.slice(index + (targetIsUser ? 0 : 1))) {
    if (entry.type === 'message' && entry.message.role === 'user') {
      if (landing) checkpoints.push(landing)
      landing = undefined
    } else if (entry.type !== 'custom_message') {
      // Custom-message navigation restores a draft rather than landing at it.
      landing = entry.id
    }
  }
  if (landing) checkpoints.push(landing)
  return checkpoints
}

/**
 * 导航成功后调用：刷新运行时状态拿到撤销点的真实 leafId，写入计划。
 * checkpoints 为空（无可恢复回合）时清空计划。
 */
export async function commitRedoPlan(sessionId: string, checkpoints: string[]): Promise<void> {
  if (checkpoints.length === 0) {
    redoPlanStore.setPlan(sessionId, null)
    return
  }
  await refreshPiSessionState(sessionId).catch(() => undefined)
  const head = (piSessionStateStore.getState(sessionId)?.head ?? null) as { epoch?: string; leafId?: string } | null
  if (!head?.epoch) {
    redoPlanStore.setPlan(sessionId, null)
    return
  }
  redoPlanStore.setPlan(sessionId, { epoch: head.epoch, undoLeafId: head.leafId ?? null, checkpoints, restored: 0 })
}
