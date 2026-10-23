import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const resources = join(root, "packages", "app", "src-tauri", "resources")

// Android is a remote client: no local server/OMP/Bun/native npm dependencies.
// The connected desktop/server ships the complete same-version public runtime.
rmSync(resources, { recursive: true, force: true })
mkdirSync(resources, { recursive: true })
writeFileSync(join(resources, ".mobile-placeholder"), "")

console.info(`[tauri] mobile resource placeholders prepared at ${resources}`)
