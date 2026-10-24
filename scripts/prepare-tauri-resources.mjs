import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspectOmpRuntime } from "./prepare-omp-runtime.mjs"

// --skip-runtime: 轻量版资源。不带官方 OMP 运行时，运行时由外部 OMP CLI 提供；
// 安装包体积和 NSIS 压缩时间都大幅下降。默认（不带参数）仍装配完整运行时。
const skipRuntime = process.argv.slice(2).includes("--skip-runtime")

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packageDir = join(root, "packages", "app", "src-tauri")
const source = join(root, "dist-desktop")
const target = join(packageDir, "resources")

if (!existsSync(source)) {
  throw new Error("dist-desktop does not exist; run npm run package:desktop first")
}

// 以 dist-desktop 中实际存在的产物判断目标平台,而不是宿主 process.platform:
// 在 Linux/macOS 上为 Windows 目标打包后也应能正确校验 .exe 产物。
const isFile = path => existsSync(path) && statSync(path).isFile()
const isWindowsPackage = isFile(join(source, "omp-worker.exe"))
const isUnixPackage = !isWindowsPackage && isFile(join(source, "omp-worker"))
if (!isWindowsPackage && !isUnixPackage) {
  throw new Error(`desktop server binary not found: ${join(source, "omp-worker(.exe)")}; run npm run package:desktop first`)
}
const suffix = isWindowsPackage ? ".exe" : ""
const serverName = `omp-worker${suffix}`
const bridgeName = `ompiui-tailscale-bridge${suffix}`
const server = join(source, serverName)
const bridge = join(source, "tailscale", bridgeName)

// 桥接二进制缺失时必须在此失败:否则 Tauri 打包会静默带上不完整的 tailscale 目录。
if (!isFile(bridge)) {
  throw new Error(
    `embedded tailscale bridge is missing: ${bridge}. ` +
    "Rebuild it with `npm run package:desktop` (or `node scripts/build-tailscale.mjs --out <dist-desktop>/tailscale`).",
  )
}

// Validate the complete native runtime before replacing Tauri resources. The
// existing resources/ -> root mapping and launcher cwd retain relative layout.
if (!skipRuntime) inspectOmpRuntime(join(source, "omp-runtime"), isWindowsPackage ? "win32" : process.platform)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(server, join(target, serverName))
cpSync(join(source, "node_modules"), join(target, "node_modules"), { recursive: true })
cpSync(join(source, "web"), join(target, "web"), { recursive: true })
cpSync(join(source, "tailscale"), join(target, "tailscale"), { recursive: true })
if (!skipRuntime) cpSync(join(source, "omp-runtime"), join(target, "omp-runtime"), { recursive: true })

console.info(`[tauri] resources prepared at ${target}${skipRuntime ? " (lite: no bundled omp-runtime)" : ""}`)
