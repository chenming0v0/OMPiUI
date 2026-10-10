import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeTailscaleLicenses } from "./tailscale-licenses.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "packages", "server", "tailscale-bridge")
const app = join(root, "packages", "app", "src-tauri", "gen", "android", "app")
const args = process.argv.slice(2)
const arch = args.includes("--target") ? args[args.indexOf("--target") + 1] : null
const target = arch === "aarch64" || arch === "arm64" ? "android/arm64"
  : arch === "armv7" ? "android/arm" : arch === "x86_64" ? "android/amd64"
  : "android/arm64,android/arm,android/amd64"
const tools = join(source, "build", "tools")
mkdirSync(tools, { recursive: true })
mkdirSync(join(app, "libs"), { recursive: true })
const options = { cwd: source, stdio: "inherit", env: { ...process.env, GOBIN: tools } }
const mobileVersion = "v0.0.0-20260908204917-8b95e45f8d3e"
execFileSync("go", ["install", `golang.org/x/mobile/cmd/gomobile@${mobileVersion}`], options)
execFileSync("go", ["install", `golang.org/x/mobile/cmd/gobind@${mobileVersion}`], options)
const gomobile = join(tools, `gomobile${process.platform === "win32" ? ".exe" : ""}`)
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH"
options.env[pathKey] = `${tools}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey]}`
execFileSync(gomobile, ["init"], options)
const aar = join(app, "libs", "ompiui-tailscale.aar")
execFileSync(gomobile, [
  "bind", "-target", target, "-androidapi", "24", "-javapkg", "com.ompiui.tailscale",
  "-ldflags=-s -w", "-o", aar, "./mobile",
], options)
const assets = join(app, "src", "main", "assets", "tailscale")
mkdirSync(assets, { recursive: true })
cpSync(join(source, "NOTICE.md"), join(assets, "NOTICE.md"))
writeTailscaleLicenses(source, join(assets, "third-party-licenses.txt"))
console.info(`[tailscale] embedded Android library built: ${aar}`)
