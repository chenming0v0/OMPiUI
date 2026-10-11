import { parseArgs } from "node:util"
import { migrateLegacySessions, planLegacySessionMigration } from "../packages/omp-worker/src/omp/legacy-session-migration.js"
import { detectOmpVersionSync, isOmpVersionSupported } from "../packages/omp-worker/src/omp/omp-version.js"

const { values } = parseArgs({ options: { cwd: { type: "string" }, apply: { type: "boolean" } } })
if (!values.cwd) throw new Error("Usage: npm run sessions:migrate -- --cwd <workspace> [--apply]")
const ompVersion = detectOmpVersionSync(process.env.OMPI_OMP_BIN)
if (!ompVersion || !isOmpVersionSupported(ompVersion)) throw new Error("Cannot determine a supported OMP version; no sessions were migrated")
const result = values.apply ? migrateLegacySessions(values.cwd, ompVersion) : planLegacySessionMigration(values.cwd, ompVersion)
console.log(JSON.stringify({ mode: values.apply ? "apply" : "preview", ompVersion, ...result }, null, 2))
