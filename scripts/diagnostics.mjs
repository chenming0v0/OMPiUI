import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { queryDiagnostics } from "./lib/diagnostic-query.mjs"

const help = `OMPiUI diagnostic timeline

Usage: npm run diagnostics -- [options]
  --session ID     Session timeline, including server/worker lifecycle context
  --since ISO      Events since an ISO date/time (include timezone)
  --level LEVEL    Minimum level: debug, info, warn, error
  --event TEXT     Filter event names
  --limit N        Last N matching events (default 200)
  --dir PATH       Override diagnostic directory
  --json           Print JSONL instead of a readable timeline
  --out PATH       Export matching JSONL to a new file
  --help           Show this help
`

try {
  const { values } = parseArgs({
    options: {
      session: { type: "string" }, since: { type: "string" }, level: { type: "string" },
      event: { type: "string" }, limit: { type: "string" }, dir: { type: "string" },
      json: { type: "boolean" }, out: { type: "string" }, help: { type: "boolean" },
    },
  })
  if (values.help) {
    console.log(help)
  } else {
    const root = process.env.OMPIUI_DATA_DIR?.trim()
      ? resolve(process.env.OMPIUI_DATA_DIR)
      : process.platform === "win32" && process.env.APPDATA
        ? join(process.env.APPDATA, "com.ompiui.app") : join(homedir(), ".ompiui")
    const directory = values.dir ? resolve(values.dir) : join(root, "logs", "diagnostics")
    const { records, malformed } = await queryDiagnostics(directory, {
      ...values, limit: values.limit ? Number(values.limit) : 200,
    })
    const jsonl = records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "")
    if (values.out) {
      writeFileSync(resolve(values.out), jsonl, { mode: 0o600, flag: "wx" })
      console.log(`Exported ${records.length} events to ${resolve(values.out)}`)
    } else if (values.json) {
      process.stdout.write(jsonl)
    } else {
      console.log(`Directory: ${directory}\nMatching events: ${records.length}`)
      for (const record of records) {
        const { schemaVersion, time, level, event, runId, pid, seq, ...fields } = record
        console.log(`${time} ${level.toUpperCase().padEnd(5)} ${event} [pid=${pid} run=${runId.slice(0, 8)} #${seq}] ${JSON.stringify(fields)}`)
      }
    }
    if (malformed) console.error(`Skipped ${malformed} malformed/incomplete log lines`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
