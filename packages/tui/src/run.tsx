import { render } from "ink";
import { ConsoleApp } from "./app.tsx";
import { ConsoleController } from "./controller.ts";
import type { ConsoleAdapter } from "./types.ts";

export async function runConsole(adapter: ConsoleAdapter): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await adapter.dispose();
    throw new Error(
      "TUI 需要交互式终端；请使用 SSH -t 或 docker exec -it，非交互部署请使用对应 CLI 命令。",
    );
  }
  const controller = new ConsoleController(adapter);
  const alternate = process.env.INK_SCREEN_READER !== "true";
  if (alternate) process.stdout.write("\u001b[?1049h");
  const instance = render(
    <ConsoleApp controller={controller} onExit={() => instance.unmount()} />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  const exited = instance.waitUntilExit();
  const terminate = () => {
    void controller
      .shutdown()
      .catch((error) => process.stderr.write(`${String(error)}\n`))
      .finally(() => instance.unmount());
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  process.once("SIGHUP", terminate);
  process.stdin.once("end", terminate);
  try {
    await controller.start();
    await exited;
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
    process.off("SIGHUP", terminate);
    process.stdin.off("end", terminate);
    try {
      await controller.shutdown();
    } finally {
      instance.cleanup();
      if (alternate) process.stdout.write("\u001b[?1049l");
    }
  }
}
