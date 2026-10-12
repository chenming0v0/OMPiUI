import { runConsole } from "@ompiui/tui";
import { RelayConsole } from "./tui-adapter.ts";
import { RelayManager } from "./tui-manager.ts";

export async function runRelayTui(path: string): Promise<void> {
  await runConsole(new RelayConsole(new RelayManager(path)));
}
