#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OMP_SDK_VERSION } from "../packages/omp-worker/src/omp/constants.ts"

export const OMP_BUN_VERSION = "1.3.14"
const packageName = "@oh-my-pi/pi-coding-agent"
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Reuse the packaging scripts' direct npm-cli invocation on Windows: no cmd
// shell may reinterpret install paths that contain spaces or non-ASCII text.
function npmInvocation() {
  const entry = process.env.npm_execpath
  if (entry && /npm-cli\.(c?js|mjs)$/i.test(entry)) return [process.execPath, [entry]]
  if (process.platform !== "win32") return ["npm", []]
  const entryPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  if (existsSync(entryPath)) return [process.execPath, [entryPath]]
  throw new Error("Cannot locate npm-cli.js; run through npm run prepare:omp-runtime or install npm next to Node")
}

export function inspectOmpRuntime(root, platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8"))
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`OMP runtime target mismatch: ${manifest.platform}/${manifest.arch}, expected ${platform}/${arch}`)
  }
  const suffix = platform === "win32" ? ".exe" : ""
  const packageRoot = join(root, "node_modules", packageName)
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  if (installed.version !== manifest.version) throw new Error("OMP runtime public source version does not match runtime.json")
  const files = [join(root, "bin", `omp${suffix}`), join(root, "bin", `bun${suffix}`),
    join(root, "package-lock.json"), join(packageRoot, "src", "config", "settings.ts"),
    join(packageRoot, "src", "session", "queued-messages.ts"), join(packageRoot, "src", "extensibility", "plugins", "manager.ts")]
  for (const file of files) if (!existsSync(file)) throw new Error(`OMP runtime resource is missing: ${file}`)
  return manifest
}

export async function prepareOmpRuntime({ version = OMP_SDK_VERSION, out = join(repoRoot, "omp-runtime"), binary } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`An exact stable OMP version is required: ${version}`)
  if (!["win32", "linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Public OMP runtime packaging is unsupported on ${process.platform}/${process.arch}; mobile clients connect to a desktop/server host`)
  }
  if (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error("Public OMP native npm dependencies require a glibc Linux host; musl/Android local execution is not packaged")
  }
  const destination = resolve(out)
  if (destination === repoRoot || dirname(destination) === destination) throw new Error("OMP runtime output must be a dedicated resource directory")
  mkdirSync(dirname(destination), { recursive: true })
  const staging = mkdtempSync(join(dirname(destination), ".omp-runtime-"))
  const suffix = process.platform === "win32" ? ".exe" : ""
  try {
    mkdirSync(join(staging, "bin"))
    const omp = join(staging, "bin", `omp${suffix}`)
    if (binary) {
      cpSync(resolve(binary), omp)
    } else {
      const os = process.platform === "win32" ? "windows" : process.platform
      const asset = `omp-${os}-${process.arch}${suffix}`
      const url = `https://github.com/can1357/oh-my-pi/releases/download/v${version}/${asset}`
      console.info(`[omp-runtime] downloading ${url}`)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Cannot download official OMP v${version}: HTTP ${response.status}`)
      writeFileSync(omp, new Uint8Array(await response.arrayBuffer()))
    }
    chmodSync(omp, 0o755)
    const binaryVersion = execFileSync(omp, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true }).trim()
    if (binaryVersion.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== version) throw new Error(`Official binary version ${binaryVersion} does not match requested source ${version}`)
    writeFileSync(join(staging, "package.json"), JSON.stringify({
      name: "ompiui-omp-runtime", private: true, type: "module",
      dependencies: { [packageName]: version, bun: OMP_BUN_VERSION },
    }, null, 2) + "\n")
    const [npm, prefix] = npmInvocation()
    console.info(`[omp-runtime] installing public OMP sources ${version} and Bun ${OMP_BUN_VERSION} with production/native dependencies`)
    execFileSync(npm, [...prefix, "install", "--prefix", staging, "--omit=dev", "--include=optional", "--no-audit", "--no-fund"], {
      cwd: staging, stdio: "inherit", shell: false, windowsHide: true,
    })
    const bun = join(staging, "bin", `bun${suffix}`)
    const bunPackageRoot = join(staging, "node_modules", "bun")
    const bunPackage = JSON.parse(readFileSync(join(bunPackageRoot, "package.json"), "utf8"))
    // Bun's installer uses its npm bin path on every OS, including Unix.
    cpSync(join(bunPackageRoot, bunPackage.bin.bun), bun)
    chmodSync(bun, 0o755)
    const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true }).trim()
    if (bunVersion !== OMP_BUN_VERSION) throw new Error(`Packaged Bun version ${bunVersion} does not match ${OMP_BUN_VERSION}`)
    // Load the real public APIs and native bindings from the isolated install.
    // This only imports code; it never opens Settings, plugins or user sessions.
    const imports = ["src/session/queued-messages.ts", "src/config/model-resolver.ts", "src/config/settings.ts", "src/extensibility/plugins/manager.ts", "src/capability/index.ts"]
      .map(relative => `await import(${JSON.stringify(pathToFileURL(join(staging, "node_modules", packageName, relative)).href)});`).join("\n")
    execFileSync(bun, ["-e", imports], {
      cwd: staging, encoding: "utf8", timeout: 60_000, windowsHide: true,
      env: { ...process.env, HOME: staging, USERPROFILE: staging, PI_CODING_AGENT_DIR: join(staging, ".probe-agent") },
    })
    const manifest = {
      version, bunVersion, platform: process.platform, arch: process.arch,
      binarySha256: createHash("sha256").update(readFileSync(omp)).digest("hex"),
      lockSha256: createHash("sha256").update(readFileSync(join(staging, "package-lock.json"))).digest("hex"),
    }
    writeFileSync(join(staging, "runtime.json"), JSON.stringify(manifest, null, 2) + "\n")
    inspectOmpRuntime(staging)
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
    console.info(`[omp-runtime] ready: ${destination} (official OMP ${version}, Bun ${bunVersion}, ${process.platform}/${process.arch})`)
    return manifest
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const allowed = new Set(["--version", "--out", "--binary"])
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1]) throw new Error("Usage: prepare-omp-runtime.mjs [--version <exact>] [--out <resource-directory>] [--binary <official-OMP>]")
    options[args[index].slice(2)] = args[index + 1]
  }
  await prepareOmpRuntime(options)
}
