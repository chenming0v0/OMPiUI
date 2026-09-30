import path from "node:path"
import { acquireDirectoryLock, type DirectoryLock } from "../pi/directory-lock.ts"
import { ompiuiDataDir } from "./auth-token.ts"

export async function acquireWorkspaceMutationLock(
  root: string,
  options: { namespace?: string; staleMs?: number; timeoutMs?: number } = {},
): Promise<DirectoryLock> {
  return acquireDirectoryLock(
    options.namespace ?? path.join(ompiuiDataDir(), "workspace-locks"),
    `workspace:${path.resolve(root)}`,
    { ...options, busyCode: "WORKSPACE_BUSY" },
  )
}
