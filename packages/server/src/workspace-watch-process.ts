import { EventHub } from "./event-hub.ts"
import { WorkspaceWatcher } from "./host/workspace-watcher.ts"
import type { WorkspaceRecord } from "./host/workspace-store.ts"

type Message =
  | { type: "configure"; maxWatchDirectories: number; startupDelayMs: number }
  | { type: "watch"; workspace: WorkspaceRecord }
  | { type: "unwatch"; root: string }
  | { type: "dispose" }

if (!process.send) throw new Error("Workspace watch entry requires an IPC parent")
const hub = new EventHub(0)
let watcher: WorkspaceWatcher
hub.subscribe(event => process.send?.(event, () => undefined))
process.on("message", (message: Message) => {
  if (message.type === "configure") {
    // 显式关闭嵌套隔离；此进程不加载 Agent，也不打开任何会话。
    watcher = new WorkspaceWatcher(hub, message.maxWatchDirectories, message.startupDelayMs, false)
  } else if (message.type === "watch") {
    watcher.watch(message.workspace)
  } else if (message.type === "unwatch") {
    watcher.unwatch({ canonicalRoot: message.root } as WorkspaceRecord)
  } else {
    void watcher.dispose().then(() => process.exit(0))
  }
})
// HTTP 父进程异常退出时，不留下占用目录句柄的孤儿监听进程。
process.on("disconnect", () => process.exit(0))
