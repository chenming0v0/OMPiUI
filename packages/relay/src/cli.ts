#!/usr/bin/env node
/**
 * omp-relay 命令行：init 生成配置与接入密钥，start 启动中转。
 *
 *   omp-relay init  [--config <path>] [--port <n>] [--id <id>]
 *   omp-relay start [--config <path>]
 *
 * 配置默认取 ./relay.config.json，可用 RELAY_CONFIG 环境变量覆盖。
 */

import { resolve } from "node:path"
import {
  DEFAULT_TUNNEL_ID,
  loadRelayConfig,
  writeInitialConfig,
  type RelayConfig,
} from "./config.ts"
import { startRelay } from "./relay.ts"

const USAGE = `Usage: omp-relay <command> [options]

Commands:
  init   Generate relay.config.json with a fresh tunnel key
  start  Start the relay server

Options:
  --config <path>  Config file (default: ./relay.config.json, env RELAY_CONFIG)
  --port <n>       init only: listen port for the generated config
  --id <id>        init only: tunnel id (default: ${DEFAULT_TUNNEL_ID})
  -h, --help       Show this help`

interface CliArgs {
  command: "init" | "start" | "help"
  config: string
  port?: number
  id?: string
}

function parseArgs(argv: string[]): CliArgs {
  let command: CliArgs["command"] = "help"
  let config = process.env.RELAY_CONFIG?.trim() || "relay.config.json"
  let port: number | undefined
  let id: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "-h" || arg === "--help") {
      command = "help"
      continue
    }
    if (arg === "init" || arg === "start") {
      command = arg
      continue
    }
    const [name, inline] = arg.split("=", 2)
    const value = inline ?? argv[++index]
    if (!value) throw new Error(`${name} requires a value`)
    if (name === "--config") config = value
    else if (name === "--port") port = parsePort(value)
    else if (name === "--id") id = value
    else throw new Error(`unknown option: ${arg}`)
  }
  return { command, config, port, id }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be an integer from 1 to 65535, received: ${value}`)
  }
  return port
}

async function main(): Promise<void> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[omp-relay] ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (args.command === "help") {
    console.info(USAGE)
    return
  }
  if (args.command === "init") {
    let config: RelayConfig
    try {
      config = writeInitialConfig(resolve(args.config), { port: args.port, id: args.id })
    } catch (error) {
      console.error(`[omp-relay] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return
    }
    const tunnel = config.tunnels[0]!
    const scheme = config.tls ? "wss" : "ws"
    console.info(`[omp-relay] config written to ${resolve(args.config)}`)
    console.info("[omp-relay] keep this file private (it holds the tunnel key; chmod 600).")
    console.info("")
    console.info("Fill these into OMPiUI → Settings → Service → Tunnel (or pass them as env vars to the server):")
    console.info("")
    console.info(`OMPIUI_TUNNEL_URL=${scheme}://<your-relay-host>:${config.port}`)
    console.info(`OMPIUI_TUNNEL_KEY=${tunnel.key}`)
    console.info(`OMPIUI_TUNNEL_ID=${tunnel.id}`)
    return
  }
  let config: RelayConfig
  try {
    config = loadRelayConfig(resolve(args.config))
  } catch (error) {
    console.error(`[omp-relay] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }
  const relay = await startRelay({ config })
  const stop = (signal: string) => {
    console.info(`[omp-relay] received ${signal}, shutting down`)
    relay.close().finally(() => process.exit(0))
  }
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))
}

void main().catch(error => {
  console.error(`[omp-relay] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
