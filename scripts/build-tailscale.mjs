import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeTailscaleLicenses } from "./tailscale-licenses.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "packages", "server", "tailscale-bridge")
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const platform = args.includes("--os") ? value("--os") : process.platform === "win32" ? "windows" : process.platform
const arch = args.includes("--arch") ? value("--arch") : process.arch === "x64" ? "amd64" : process.arch
const out = resolve(args.includes("--out") ? value("--out") : join(source, "build"))
mkdirSync(out, { recursive: true })
const binary = join(out, `ompiui-tailscale-bridge${platform === "windows" ? ".exe" : ""}`)
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", binary, "."], {
  cwd: source, stdio: "inherit",
  env: { ...process.env, GOOS: platform, GOARCH: arch, CGO_ENABLED: "0" },
})
cpSync(join(source, "NOTICE.md"), join(out, "NOTICE.md"))
writeTailscaleLicenses(source, join(out, "third-party-licenses.txt"))
console.info(`[tailscale] embedded bridge built: ${binary}`)
