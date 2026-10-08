#!/usr/bin/env node
import { adminTokenPath, loadAdminConfig, loadOrCreateAdminToken } from "./config.ts"
import { controlOwnedBackend, type OwnerControlAction } from "./lifecycle.ts"
import { ServiceManager } from "./manager.ts"
import { AdminHttpServer } from "./server.ts"
import { runTui } from "./tui.ts"

interface CliOptions {
  command: string
  host?: string
  port?: number
  token?: string
}

function parseArgs(args: string[]): CliOptions {
  // `ompiui-admin --port 1234`（省略命令字）按 web 处理，而不是把 flag 当命令。
  const hasCommand = Boolean(args[0] && !args[0]!.startsWith("-"))
  const options: CliOptions = { command: hasCommand ? args[0]! : "web" }
  for (let index = hasCommand ? 1 : 0; index < args.length; index += 1) {
    const argument = args[index]
    const [name, inline] = argument!.split("=", 2)
    if (!name!.startsWith("-")) throw new Error(`unexpected argument: ${argument} (the command must come first)`)
    const value = inline ?? args[++index]
    if (!value) throw new Error(`${name} requires a value`)
    if (name === "--host") options.host = value
    else if (name === "--port") options.port = Number(value)
    else if (name === "--token") options.token = value
    else throw new Error(`unknown option: ${argument}`)
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error("--port must be an integer from 1 to 65535")
  }
  return options
}

function help(): void {
  console.log(`Usage: ompiui-admin <command> [options]

Commands:
  web       Start the independent management Web UI (default)
  tui       Open the SSH-friendly terminal UI
  start     Run the backend in the foreground until it exits
  stop      Stop the backend through its owning manager
  restart   Restart the backend through its owning manager
  status    Print backend status and exit

start stays attached to this terminal and does not daemonize. It listens on
the management port so a separate stop or restart can reach it. If no live
owner answers, stop and restart exit with an error instead of reporting success.

Options:
  --host <host>    Management bind address (default: 127.0.0.1)
  --port <port>    Management port (default: 9898)
  --token <token>  Override the management token for this process
  -h, --help       Show this help`)
}

async function controlFromOwner(action: OwnerControlAction): Promise<void> {
  const result = await controlOwnedBackend(action)
  if (!result.ok) {
    console.error(`[ompiui-admin] ${result.message}`)
    process.exitCode = 1
    return
  }
  console.log(action === "stop" ? "backend stopped" : "backend restarted")
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("-h") || args.includes("--help")) { help(); return }
  const options = parseArgs(args)
  const config = loadAdminConfig()
  const manager = new ServiceManager({ config })
  if (options.command === "start") {
    const server = new AdminHttpServer(manager, options.token ?? loadOrCreateAdminToken())
    try {
      await server.listen(options.host ?? config.host, options.port ?? config.port)
      await manager.start()
    } catch (error) {
      await server.close()
      throw error
    }
    console.log("backend started")
    console.log(`[ompiui-admin] foreground owner ${server.address()}/ — this process stays until the backend exits`)
    const shutdown = () => { void manager.stop().finally(() => server.close()).finally(() => process.exit(0)) }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
    await manager.untilIdle()
    await server.close()
    return
  }
  if (options.command === "stop") { await controlFromOwner("stop"); return }
  if (options.command === "restart") { await controlFromOwner("restart"); return }
  if (options.command === "status") { console.log(JSON.stringify(await manager.status(), null, 2)); return }
  if (options.command === "tui") { await runTui(manager); return }
  if (options.command !== "web") throw new Error(`unknown command: ${options.command}`)
  const server = new AdminHttpServer(manager, options.token ?? loadOrCreateAdminToken())
  await server.listen(options.host ?? config.host, options.port ?? config.port)
  console.log(`[ompiui-admin] management UI: ${server.address()}/`)
  // 令牌不进服务日志：TTY 下直接展示，journald/容器日志里只给文件路径。
  if (process.env.OMPIUI_ADMIN_TOKEN?.trim()) {
    console.log("[ompiui-admin] admin token: from OMPIUI_ADMIN_TOKEN")
  } else if (process.stdout.isTTY) {
    console.log(`[ompiui-admin] admin token: ${server.token}`)
  } else {
    console.log(`[ompiui-admin] admin token: read ${adminTokenPath()} (kept out of service logs)`)
  }
  console.log("[ompiui-admin] backend lifecycle is controlled from the TUI or Web UI")
  const stop = async () => { await server.close(); await manager.stop() }
  process.once("SIGINT", () => { void stop().finally(() => process.exit(0)) })
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)) })
  await new Promise<void>(() => undefined)
}

main().catch(error => {
  console.error(`[ompiui-admin] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
