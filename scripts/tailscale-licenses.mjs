import { execFileSync } from "node:child_process"

export function writeTailscaleLicenses(source, output) {
  execFileSync("go", ["run", "./cmd/licenses", "--out", output], {
    cwd: source, stdio: "inherit",
  })
}
