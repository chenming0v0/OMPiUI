import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import { RelayManager } from "./tui-manager.ts";
import { RelayConsole, relayPublicUrl } from "./tui-adapter.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(port: number, key: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_tunnel?tunnel=pc`, {
    headers: { authorization: `Bearer ${key}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("message", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

test("TUI public routing preserves the externally configured protocol and port", () => {
  const config = {
    port: 8443,
    publicUrl: "https://entry.example:9443",
    domain: "relay.example",
    tunnels: [{ id: "pc", key: "private-test-key-123456" }],
  };
  assert.equal(
    relayPublicUrl(config, config.tunnels[0]),
    "https://pc.relay.example:9443",
  );
  assert.equal(
    relayPublicUrl({ ...config, publicUrl: undefined }, config.tunnels[0]),
    "",
  );
});

test("relay TUI starts empty, creates private config and never starts on read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-tui-relay-"));
  const manager = new RelayManager(join(root, "relay.json"));
  const adapter = new RelayConsole(manager);
  t.after(async () => {
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await adapter.read()).ownedRunning, false);
  assert.equal(manager.getConfig(), null);
  await adapter.execute("initialize", {
    port: String(await freePort()),
    id: "pc",
    host: "127.0.0.1",
  });
  const config = manager.getConfig()!;
  assert.equal(config.tunnels[0]!.key.length, 43);
  assert.equal(manager.status().running, false);
  assert.equal(
    JSON.parse(readFileSync(manager.path, "utf8")).tunnels[0].id,
    "pc",
  );
  await assert.rejects(manager.initialize({}), /已经存在/);
});

test("live relay TUI shows connections, disconnects peers, rotates keys and closes its own listener", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-tui-relay-live-"));
  const manager = new RelayManager(join(root, "relay.json"));
  const adapter = new RelayConsole(manager);
  let ws: WebSocket | undefined;
  t.after(async () => {
    ws?.terminate();
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await freePort();
  await manager.initialize({
    port: String(port),
    id: "pc",
    host: "127.0.0.1",
    publicUrl: "https://relay.example.com",
  });
  const originalKey = manager.getConfig()!.tunnels[0]!.key;
  await Promise.all([manager.start(), manager.start()]);
  ws = await connect(port, originalKey);
  assert.deepEqual(manager.status().tunnels, [
    { id: "pc", online: true, connections: 0 },
  ]);
  assert.match(
    (await adapter.read()).views.find((view) => view.id === "tunnels")!.rows[0]!
      .value,
    /在线/,
  );
  await manager.disconnect("pc");
  assert.equal(manager.status().tunnels[0]!.online, false);
  ws.terminate();
  await manager.rotateKey("pc");
  assert.notEqual(manager.getConfig()!.tunnels[0]!.key, originalKey);
  assert.equal(manager.status().pending, true);
  assert.doesNotMatch(
    JSON.stringify(manager.logs.read()),
    new RegExp(originalKey),
  );
  await manager.restart();
  assert.equal(manager.status().pending, false);
  await assert.rejects(connect(port, originalKey), /401/);
  ws = await connect(port, manager.getConfig()!.tunnels[0]!.key);
  assert.equal(manager.status().tunnels[0]!.online, true);
  await adapter.dispose();
  assert.equal(manager.status().running, false);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

test("relay configuration edits preserve keys, reject duplicate IDs and keep the last tunnel", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-tui-relay-edit-"));
  const manager = new RelayManager(join(root, "relay.json"));
  t.after(async () => {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await manager.initialize({ port: "8443", id: "pc", host: "127.0.0.1" });
  const key = manager.getConfig()!.tunnels[0]!.key;
  await assert.rejects(manager.addTunnel({ id: "pc" }), /duplicate/);
  await manager.addTunnel({ id: "office", host: "office.example.com" });
  await manager.editTunnel("office", { id: "work", host: "work.example.com" });
  assert.equal(manager.getConfig()!.tunnels[1]!.host, "work.example.com");
  await manager.configure({
    host: "127.0.0.1",
    port: "9443",
    publicUrl: "https://relay.example.com",
    domain: "",
    cert: "",
    tlsKey: "",
  });
  assert.equal(manager.getConfig()!.tunnels[0]!.key, key);
  await manager.removeTunnel("work");
  await assert.rejects(manager.removeTunnel("pc"), /至少一条/);
  await assert.rejects(
    manager.configure({ host: "127.0.0.1", port: "0" }),
    /port/,
  );
});

test("external edits are not overwritten and reload leaves a running relay alone", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-tui-relay-external-"));
  const manager = new RelayManager(join(root, "relay.json"));
  t.after(async () => {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await manager.initialize({
    port: String(await freePort()),
    id: "pc",
    host: "127.0.0.1",
  });
  await manager.start();
  const changed = {
    ...manager.getConfig()!,
    publicUrl: "https://external.example.com",
  };
  writeFileSync(manager.path, JSON.stringify(changed));
  await assert.rejects(manager.rotateKey("pc"), /外部修改/);
  assert.equal(manager.status().running, true);
  await manager.reloadConfig();
  assert.equal(manager.status().pending, true);
  assert.equal(manager.getConfig()!.publicUrl, "https://external.example.com");
  writeFileSync(manager.path, "{broken");
  await assert.rejects(manager.restart());
  assert.equal(manager.status().running, true);
});
