export type DriverMode = "mock" | "omp"

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  const value = (env.OMPIUI_DRIVER ?? "omp").trim().toLowerCase()
  if (value === "omp" || value === "pi" || value === "1" || value === "true" || value === "real") return "omp"
  if (value === "mock" || value === "0" || value === "false") return "mock"
  throw Object.assign(new Error(`OMPIUI_DRIVER must be omp or mock, received: ${env.OMPIUI_DRIVER}`), { code: "INVALID_CONFIGURATION" })
}
