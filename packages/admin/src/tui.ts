import { runConsole } from "@ompiui/tui";
import { createBackendConsole } from "./tui-adapter.ts";
import type { ServiceManager } from "./manager.ts";

export async function runTui(
  manager?: ServiceManager,
  options: { host?: string; port?: number; token?: string } = {},
): Promise<void> {
  await runConsole(await createBackendConsole({ ...options, manager }));
}
