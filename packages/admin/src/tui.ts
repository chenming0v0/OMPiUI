import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { ServiceManager, type ServiceStatus } from "./manager.ts"

function healthLabel(status: ServiceStatus): string {
  if (status.health) return "online"
  // 只有确认在跑的后端才把探测失败当错误展示；stopped 后端连不上是常态。
  if (status.lifecycle === "running" && status.healthError) return `error: ${status.healthError}`
  return "offline"
}

function printStatus(status: ServiceStatus): void {
  const share = status.share && typeof status.share === "object" ? status.share as Record<string, unknown> : undefined
  const tunnel = status.tunnel && typeof status.tunnel === "object" ? status.tunnel as Record<string, unknown> : undefined
  console.log(`\nBackend: ${status.lifecycle} (${healthLabel(status)})${status.pid ? ` pid=${status.pid}` : ""}`)
  console.log(`URL: ${status.backendUrl}`)
  if (typeof share?.url === "string") console.log(`Share: ${share.url}`)
  if (typeof share?.link === "string") console.log(`Deep link: ${share.link}`)
  if (tunnel) console.log(`Tunnel: ${String(tunnel.state ?? "unknown")}${tunnel.publicUrl ? ` ${String(tunnel.publicUrl)}` : ""}`)
  if (status.error) console.log(`Error: ${status.error}`)
}

export async function runTui(manager = new ServiceManager()): Promise<void> {
  const readline = createInterface({ input, output })
  console.log("OMPiUI server manager — SSH/TUI mode")
  let stoppedBeforeExit = false
  // cooked 模式终端的 Ctrl+C 直接终止进程，finally 不会跑；这里补提示。
  process.once("SIGINT", () => {
    readline.close()
    if (manager.isRunning()) {
      console.log("\nBackend is still running in the background.")
      console.log("Reopen `ompiui-admin tui` to manage it, or run `ompiui-admin stop`.")
    }
    process.exit(0)
  })
  try {
    while (true) {
      printStatus(await manager.status())
      const command = (await readline.question("\n[s]tart [x]stop [r]estart [c]redentials [q]uit [enter]refresh > ")).trim().toLowerCase()
      if (command === "q" || command === "quit") {
        if (manager.isRunning()) {
          const answer = (await readline.question("Backend is still running. Stop it before quitting? [Y/n] ")).trim().toLowerCase()
          if (answer !== "n") {
            await manager.stop()
            stoppedBeforeExit = true
          }
        }
        break
      }
      if (command === "s" || command === "start") {
        try {
          await manager.start()
        } catch (error) {
          console.log(`Start failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      else if (command === "x" || command === "stop") await manager.stop()
      else if (command === "r" || command === "restart") {
        try {
          await manager.restart()
        } catch (error) {
          console.log(`Restart failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      else if (command === "c" || command === "credentials") {
        console.log(`Admin token: use the token printed by the web command or OMPIUI_ADMIN_TOKEN`)
        console.log(`Backend token: ${manager.backendToken() ?? "not generated yet — start the backend once"}`)
        const status = await manager.status()
        const share = status.share as Record<string, unknown> | null
        console.log(`Share URL: ${String(share?.url ?? "unavailable")}`)
        console.log(`Deep link: ${String(share?.link ?? "unavailable")}`)
      }
    }
  } finally {
    readline.close()
  }
  // 直接 Ctrl+C 退出时后端仍在跑：告诉用户怎么接管，而不是留下无人管理的进程。
  if (!stoppedBeforeExit && manager.isRunning()) {
    console.log("\nBackend is still running in the background.")
    console.log("Reopen `ompiui-admin tui` to manage it, or run `ompiui-admin stop`.")
  }
}
