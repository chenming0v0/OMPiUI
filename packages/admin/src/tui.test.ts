import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { loadAdminConfig } from "./config.ts";
import { ServiceManager } from "./manager.ts";
import { AdminHttpServer } from "./server.ts";
import { createBackendConsole, validateBackendForm } from "./tui-adapter.ts";
import { ConsoleController } from "@ompiui/tui";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ompiui-tui-server-"));
  const env = {
    ...process.env,
    OMPIUI_DATA_DIR: root,
    OMPIUI_ADMIN_DATA_DIR: root,
    OMPIUI_AUTH_TOKEN: "private-backend-token",
  };
  const manager = new ServiceManager({
    env,
    config: {
      ...loadAdminConfig(env),
      serverCommand: process.execPath,
      serverArgs: [
        "-e",
        "console.log('ready private-backend-token'); setInterval(() => {}, 1000)",
      ],
      serverUrl: "http://127.0.0.1:1",
      serverEnv: { OMPIUI_TUNNEL_KEY: "keep-this-key" },
    },
  });
  return { root, env, manager };
}

test("backend TUI reads without spawning, captures redacted output, and cleans up its own child", async (t) => {
  const { root, env, manager } = fixture();
  const adapter = await createBackendConsole({
    manager,
    env,
    port: 0,
    token: "private-admin-token",
  });
  t.after(async () => {
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await adapter.read()).ownedRunning, false);
  assert.equal(manager.isRunning(), false);
  await adapter.execute("start", {});
  assert.equal((await adapter.read()).ownedRunning, true);
  const pid = (await manager.status()).pid!;
  for (let count = 0; count < 30; count++) {
    if ((await adapter.read()).logs.some((log) => log.text.includes("ready")))
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const logs = JSON.stringify((await adapter.read()).logs);
  assert.match(logs, /ready/);
  assert.doesNotMatch(
    logs,
    /private-backend-token|private-admin-token|keep-this-key/,
  );
  await adapter.dispose();
  assert.equal(manager.isRunning(), false);
  assert.throws(() => process.kill(pid, 0));
});

test("TUI attaches to an existing authenticated manager and leaves its child running on exit", async (t) => {
  const { root, env, manager } = fixture();
  manager.captureOutput(() => {});
  const owner = new AdminHttpServer(manager, "shared-admin-token");
  await owner.listen("127.0.0.1", 0);
  const port = Number(new URL(owner.address()!).port);
  const adapter = await createBackendConsole({
    env,
    port,
    token: "shared-admin-token",
  });
  t.after(async () => {
    await adapter.dispose();
    await manager.stop();
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  });
  await adapter.execute("start", {});
  assert.equal(manager.isRunning(), true);
  const data = await adapter.read();
  assert.equal(data.subtitle, "ATTACHED");
  assert.equal(data.ownedRunning, false);
  await adapter.dispose();
  assert.equal(manager.isRunning(), true);
  await adapter.execute("stop", {});
  assert.equal(manager.isRunning(), false);
});

test("occupied management port with the wrong token is never treated as our manager", async (t) => {
  const { root, env, manager } = fixture();
  const owner = new AdminHttpServer(manager, "correct-admin-token");
  await owner.listen("127.0.0.1", 0);
  t.after(async () => {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    createBackendConsole({
      env,
      port: Number(new URL(owner.address()!).port),
      token: "wrong-admin-token",
    }),
    /HTTP 401/,
  );
  assert.equal(manager.isRunning(), false);
});

test("editing network settings keeps the saved key when the secret input is blank", async (t) => {
  const { root, env, manager } = fixture();
  const adapter = await createBackendConsole({
    manager,
    env,
    port: 0,
    token: "admin",
  });
  t.after(async () => {
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await adapter.execute("configure", {
    host: "127.0.0.1",
    port: "9900",
    serverUrl: "http://127.0.0.1:9900",
    publicBaseUrl: "",
    tunnelUrl: "wss://relay.example.com",
    tunnelId: "pc",
    tunnelKey: "",
  });
  const saved = JSON.parse(readFileSync(join(root, "admin.json"), "utf8"));
  assert.equal(saved.serverEnv.OMPIUI_TUNNEL_KEY, "keep-this-key");
  assert.equal(saved.serverEnv.OMPIUI_PORT, "9900");
  assert.equal(manager.isRunning(), false);
  assert.throws(
    () => validateBackendForm({ port: "99999", serverUrl: "http://localhost" }),
    /端口/,
  );
});

test("non-interactive TUI exits without spawning a backend or retaining an API listener", async () => {
  const { root, env, manager } = fixture();
  const adapter = await createBackendConsole({
    manager,
    env,
    port: 0,
    token: "admin",
  });
  const logs = (await adapter.read()).logs;
  const port = Number(new URL(logs[0]!.text.split(" ").at(-1)!).port);
  const { runConsole } = await import("@ompiui/tui");
  try {
    if (!process.stdin.isTTY)
      await assert.rejects(runConsole(adapter), /交互式终端/);
    assert.equal(manager.isRunning(), false);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing the TUI during a real restart never leaves a replacement backend running", async (t) => {
  const { root, env, manager } = fixture();
  const adapter = await createBackendConsole({
    manager,
    env,
    port: 0,
    token: "admin",
  });
  const controller = new ConsoleController(adapter);
  t.after(async () => {
    await controller.shutdown();
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await controller.start();
  await controller.run("start", "start");
  const oldPid = (await manager.status()).pid!;
  const restarting = controller.run("restart", "restart");
  await new Promise((resolve) => setImmediate(resolve));
  await controller.shutdown();
  await restarting;
  assert.equal(manager.isRunning(), false);
  assert.equal((await manager.status()).pid, null);
  assert.throws(() => process.kill(oldPid, 0));
});
