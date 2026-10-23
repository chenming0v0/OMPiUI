import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface OmpRuntime {
  root: string
  version: string
  bunVersion: string
}

/** Installed at build/install time only; resolving a runtime never downloads or writes. */
export function resolveInstalledOmpRuntime(env: NodeJS.ProcessEnv = process.env): OmpRuntime | undefined {
  const explicit = env.OMPI_OMP_RUNTIME_DIR?.trim()
  const candidates = explicit ? [path.resolve(explicit)] : [
    path.join(path.dirname(process.execPath), "omp-runtime"),
  ]
  if (!explicit) {
    const starts = [process.cwd()]
    if (import.meta.url.startsWith("file:")) starts.push(path.dirname(fileURLToPath(import.meta.url)))
    for (const start of starts) {
      for (let directory = start; ; directory = path.dirname(directory)) {
        candidates.push(path.join(directory, "omp-runtime"))
        if (directory === path.dirname(directory)) break
      }
    }
  }
  for (const root of new Set(candidates)) {
    const file = path.join(root, "runtime.json")
    if (!existsSync(file) && !explicit) continue
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8"))
      if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
        || typeof manifest.bunVersion !== "string" || !manifest.bunVersion
        || manifest.platform !== process.platform || manifest.arch !== process.arch) {
        throw new Error(`Expected a versioned ${process.platform}/${process.arch} runtime`)
      }
      return { root, version: manifest.version, bunVersion: manifest.bunVersion }
    } catch (error) {
      throw Object.assign(new Error(`Invalid installed OMP runtime at ${root}: ${error instanceof Error ? error.message : String(error)}. Run the OMPiUI runtime preparation step for this host.`), { code: "OMP_RUNTIME_INVALID" })
    }
  }
  return undefined
}

export function installedOmpExecutable(runtime: OmpRuntime, name: "omp" | "bun"): string {
  const executable = path.join(runtime.root, "bin", process.platform === "win32" ? `${name}.exe` : name)
  if (!existsSync(executable)) {
    throw Object.assign(new Error(`Installed OMP runtime is missing ${executable}. Reinstall the OMPiUI runtime bundle.`), { code: "OMP_RUNTIME_INVALID" })
  }
  return executable
}
