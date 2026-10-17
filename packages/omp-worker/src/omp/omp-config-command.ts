import { resolveOmpCommand, type OmpCommand } from "./omp-command.js"

export { resolveWindowsNpmShim } from "./omp-command.js"
export type OmpConfigCommand = OmpCommand

export function resolveOmpConfigCommand(): OmpCommand {
  return resolveOmpCommand(process.env.OMPI_OMP_BIN?.trim() || "omp")
}
