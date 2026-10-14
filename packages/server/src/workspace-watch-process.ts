import { EventHub } from "./event-hub.ts"
import { WorkspaceWatcher } from "./host/workspace-watcher.ts"
import type { WorkspaceRecord } from "./host/workspace-store.ts"
import { WorkspaceWatchSender } from "./workspace-watch-sender.ts"

type Message =
  | { type: "configure"; maxWatchDirectories: number; startupDelayMs: number }
  | { type: "watch"; workspace: WorkspaceRecord }
  | { type: "unwatch"; root: string }
  | { type: "dispose" }

if (!process.send) throw new Error("Workspace watch entry requires an IPC parent")
const hub = new EventHub(0)
let watcher: WorkspaceWatcher | undefined
let closing = false
const sender = new WorkspaceWatchSender((event, done) => {
  if (!process.connected || !process.send) {
    done(new Error("workspace watcher IPC parent disconnected"))
    return
  }
  process.send(event, error => done(error ?? undefined))
}, error => {
  console.error(`[ompiui-server] workspace watcher IPC failed: ${error.message}`)
  shutdown(1)
})
const unsubscribe = hub.subscribe(event => sender.send(event))

function shutdown(code: number): void {
  if (closing) return
  closing = true
  unsubscribe()
  sender.dispose()
  const force = setTimeout(() => process.exit(code), 2_000)
  force.unref()
  void watcher?.dispose().finally(() => process.exit(code))
  if (!watcher) process.exit(code)
}
process.on("message", (message: Message) => {
  if (closing) return
  if (message.type === "configure") {
    // 显式关闭嵌套隔离；此进程不加载 Agent，也不打开任何会话。
    watcher = new WorkspaceWatcher(hub, message.maxWatchDirectories, message.startupDelayMs, false)
  } else if (message.type === "watch") {
    if (sender.watch(message.workspace.canonicalRoot)) watcher?.watch(message.workspace)
  } else if (message.type === "unwatch") {
    sender.unwatch(message.root)
    watcher?.unwatch({ canonicalRoot: message.root } as WorkspaceRecord)
  } else {
    shutdown(0)
  }
})
// HTTP 父进程异常退出时，不留下占用目录句柄的孤儿监听进程。
process.on("disconnect", () => shutdown(0))
