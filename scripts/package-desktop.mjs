#!/usr/bin/env node
/**
 * 打包桌面/便携形态：
 *   dist-desktop/omp-worker.exe     Bun 编译的统一 server/worker/CLI 文件
 *   dist-desktop/web/…             Web 客户端构建产物
 *
 * 用法：node scripts/package-desktop.mjs [--skip-build] [--target bun-windows-x64]
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(repoRoot, "dist-desktop")
const args = process.argv.slice(2)
const skipBuild = args.includes("--skip-build")
const target = args.find((arg, i) => args[i - 1] === "--target") ?? "bun-windows-x64"

// npm 在 Windows 上的入口是 npm.cmd(cmd 批处理),shell:false 时无法直接执行,
// 也不能为此开启 shell(参数会被 cmd.exe 按空格拆分)。与 scripts/test-mock.mjs 一致:
// 通过 npm_execpath 指向的 npm-cli.js 交给 node 执行。
function npmInvocation() {
  const execPath = process.env.npm_execpath
  if (execPath && /npm-cli\.(c?js|mjs)$/i.test(execPath)) {
    return { command: process.execPath, prefix: [execPath] }
  }
  if (process.platform !== "win32") return { command: "npm", prefix: [] }
  // 未经 npm 启动时没有 npm_execpath:按 node.exe 同级的标准安装布局定位 npm-cli.js。
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  if (existsSync(bundled)) return { command: process.execPath, prefix: [bundled] }
  throw new Error("cannot locate npm-cli.js: run through `npm run package:desktop` or install npm next to node.exe")
}

const quoteForDisplay = arg => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)

// 全部调用目标都是真实可执行文件(node、npm-cli.js 经 node、bun、go),
// 因此 shell:false:参数数组原样进入子进程 argv,空格与 CJK 路径不会被拆分。
const run = (command, cmdArgs, options = {}) => {
  console.info(`$ ${[command, ...cmdArgs].map(quoteForDisplay).join(" ")}`)
  execFileSync(command, cmdArgs, { cwd: repoRoot, stdio: "inherit", shell: false, ...options })
}
const runNode = (cmdArgs, options) => run(process.execPath, cmdArgs, options)
const runNpm = (cmdArgs, options) => {
  const npm = npmInvocation()
  run(npm.command, [...npm.prefix, ...cmdArgs], options)
}

if (!skipBuild) {
  runNpm(["run", "build"])
}
mkdirSync(outDir, { recursive: true })
const goOs = target.includes("windows") ? "windows" : target.includes("darwin") ? "darwin" : "linux"
const goArch = target.includes("arm64") ? "arm64" : "amd64"
const tailscaleOut = join(outDir, "tailscale")
runNode(["scripts/build-tailscale.mjs", "--os", goOs, "--arch", goArch, "--out", tailscaleOut])
rmSync(join(outDir, "runtime"), { recursive: true, force: true })
rmSync(join(outDir, "piui-server.exe"), { force: true })
rmSync(join(outDir, "piui-server"), { force: true })

// ---- 1. Web 客户端 ----
console.info("[package] copying web client")
rmSync(join(outDir, "web"), { recursive: true, force: true })
cpSync(join(repoRoot, "packages", "app", "dist"), join(outDir, "web"), { recursive: true })

// ---- 2. Bun PTY 原生库 ----
console.info("[package] copying bun-pty")
const nativeOut = join(outDir, "node_modules")
rmSync(nativeOut, { recursive: true, force: true })
mkdirSync(nativeOut, { recursive: true })
const bunPtyDir = join(repoRoot, "node_modules", "bun-pty")
if (!existsSync(bunPtyDir)) throw new Error("bun-pty is not installed")
const bunPtyOut = join(nativeOut, "bun-pty")
mkdirSync(join(bunPtyOut, "src"), { recursive: true })
mkdirSync(join(bunPtyOut, "rust-pty", "target", "release"), { recursive: true })
cpSync(join(bunPtyDir, "package.json"), join(bunPtyOut, "package.json"))
cpSync(join(bunPtyDir, "LICENSE"), join(bunPtyOut, "LICENSE"))
for (const file of ["index.ts", "interfaces.ts", "terminal.ts"]) {
  cpSync(join(bunPtyDir, "src", file), join(bunPtyOut, "src", file))
}
const nativeLibrary = target.includes("windows")
  ? "rust_pty.dll"
  : target.includes("darwin")
    ? (target.includes("arm64") ? "librust_pty_arm64.dylib" : "librust_pty.dylib")
    : (target.includes("arm64") ? "librust_pty_arm64.so" : "librust_pty.so")
const nativeLibraryPath = join(bunPtyDir, "rust-pty", "target", "release", nativeLibrary)
if (!existsSync(nativeLibraryPath)) throw new Error(`bun-pty native library is missing: ${nativeLibraryPath}`)
cpSync(nativeLibraryPath, join(bunPtyOut, "rust-pty", "target", "release", nativeLibrary))

// ---- 3. bun compile ----
const outfile = join(outDir, target.includes("windows") ? "omp-worker.exe" : "omp-worker")
run("bun", [
  "build", join("packages", "server", "dist", "bundle-entry.js"),
  "--compile",
  `--target=${target}`,
  "--external", "bun-pty",
  "--external", "@lydell/node-pty",
  ...(target.includes("windows") ? ["--icon", join("packages", "app", "assets", "build", "pi.ico")] : []),
  "--outfile", outfile,
])

const requiredFiles = [
  outfile,
  join(tailscaleOut, `ompiui-tailscale-bridge${goOs === "windows" ? ".exe" : ""}`),
  join(outDir, "web", "index.html"),
  join(outDir, "node_modules", "bun-pty", "src", "index.ts"),
  join(outDir, "node_modules", "bun-pty", "rust-pty", "target", "release", nativeLibrary),
]
for (const file of requiredFiles) {
  if (!existsSync(file)) throw new Error(`desktop package is missing required resource: ${file}`)
}

console.info(`
[package] done → ${outDir}
  omp-worker    Web/API 服务、OMP worker 和原生 CLI
  web/         Web 客户端，server 同端口托管
局域网/手机访问：omp-worker.exe web --host 0.0.0.0
`)
