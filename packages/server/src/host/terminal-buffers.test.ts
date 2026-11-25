import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "./terminal-manager.ts";
import { TextWindow } from "./text-window.ts";
import { terminalOwnerFromSecret } from "./terminal-auth.ts";
const owner = terminalOwnerFromSecret("11".repeat(32))!;

function fixture() {
  const updates: string[] = [];
  const manager = new TerminalManager({
    publish: (_workspace, channel) => updates.push(channel),
  });
  const outputWindow = new TextWindow(2 * 1024 * 1024);
  const terminal = {
    owner,
    workspacePath: process.cwd(),
    info: { id: "test", cursor: 0, status: "running", title: "initial" },
    get output() {
      return outputWindow.toString();
    },
    get outputBytes() {
      return outputWindow.bytes;
    },
    outputWindow,
    bufferCursor: 0,
    titleBuffer: "",
    subscribers: new Map(),
    listeners: [],
  };
  const internals = manager as unknown as {
    terminals: Map<string, unknown>;
    handleData(terminal: unknown, data: string): void;
  };
  internals.terminals.set("test", terminal);
  return {
    manager,
    terminal,
    updates,
    feed: (data: string) => internals.handleData(terminal, data),
  };
}

test("inactive terminal attachment cannot retain unlimited output and reports expired activation", () => {
  const { manager, terminal, feed } = fixture();
  const attachment = manager.attach(
    process.cwd(),
    "test",
    -1,
    () => {},
    () => {},
    undefined,
    owner,
  );
  for (let index = 0; index < 20; index++) feed("x".repeat(65536));
  assert.equal(terminal.subscribers.size, 0);
  assert.throws(() => attachment.activate(), {
    code: "TERMINAL_CURSOR_EXPIRED",
  });
  attachment.detach();
});

test("terminal replay is byte-bounded and unchanged titles do not broadcast repeatedly", async () => {
  const { manager, feed, updates } = fixture();
  feed("正文😀".repeat(150000));
  const attachment = manager.attach(
    process.cwd(),
    "test",
    undefined,
    () => {},
    () => {},
    undefined,
    owner,
  );
  assert.ok(Buffer.byteLength(attachment.replay) <= 1024 * 1024);
  assert.ok(attachment.replayCursor > 0);
  assert.equal(
    Buffer.from(attachment.replay).toString("utf8"),
    attachment.replay,
  );
  assert.throws(
    () =>
      manager.attach(
        process.cwd(),
        "test",
        0,
        () => {},
        () => {},
        undefined,
        owner,
      ),
    { code: "TERMINAL_CURSOR_EXPIRED" },
  );
  attachment.detach();
  feed("\u001b]0;new title\u0007");
  feed("\u001b]0;new title\u0007");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    updates.filter((channel) => channel === "terminal.updated").length,
    1,
  );
});

test("alternating OSC titles are coalesced and split escape sequences remain readable", async () => {
  const { manager, terminal, feed, updates } = fixture();
  const titles: string[] = [];
  const attachment = manager.attach(process.cwd(), "test", -1, () => {}, () => {}, title => titles.push(title), owner);
  attachment.activate();
  feed("\x1b");
  feed("]0;first\x07");
  feed("\x1b]2;second\x07");
  assert.equal(terminal.info.title, "second");
  assert.deepEqual(titles, []);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(titles, ["second"]);
  assert.deepEqual(updates, ["terminal.updated"]);
  attachment.detach();
});

test("expired tickets are swept without invalidating simultaneous clients", () => {
  const { manager } = fixture();
  const first = manager.issueConnectToken(process.cwd(), "test", owner);
  const internals = manager as unknown as { tickets: Map<string, { expiresAt: number }> };
  internals.tickets.get(first.token)!.expiresAt = Date.now() - 1;
  const second = manager.issueConnectToken(process.cwd(), "test", owner);
  const third = manager.issueConnectToken(process.cwd(), "test", owner);
  assert.equal(internals.tickets.size, 2);
  assert.equal(manager.consumeConnectToken("test", first.token), undefined);
  assert.equal(manager.consumeConnectToken("test", second.token)?.workspacePath, process.cwd());
  assert.equal(manager.consumeConnectToken("test", third.token)?.workspacePath, process.cwd());
});

test("terminal input preserves ordering and checks the Windows input pipe instead of the output pipe", () => {
  const { manager, terminal } = fixture();
  const writes: string[] = [];
  const pty = {
    _socket: { writableLength: 0 },
    _agent: { inSocket: { writableLength: 0 } },
    write: (data: string) => writes.push(data),
  };
  Object.assign(terminal, { process: pty });
  manager.write(process.cwd(), "test", "first", owner);
  manager.write(process.cwd(), "test", "second", owner);
  pty._agent.inSocket.writableLength = 1024 * 1024;
  assert.throws(() => manager.write(process.cwd(), "test", "blocked", owner), { code: "RATE_LIMITED" });
  assert.deepEqual(writes, ["first", "second"]);
});

test("direct terminal renames enforce the title byte budget", () => {
  const { manager } = fixture();
  assert.throws(() => manager.update(process.cwd(), "test", { title: "标题".repeat(100) }, owner), { code: "INVALID_REQUEST" });
  assert.equal(manager.update(process.cwd(), "test", { title: "custom" }, owner).title, "custom");
});

test("legacy ownerless terminals are quarantined rather than silently taken over", () => {
  const { manager, terminal, feed, updates } = fixture();
  const ticket = manager.issueConnectToken(process.cwd(), "test", owner).token;
  // Simulate an old surviving in-memory registry entry. No client may adopt it,
  // and even a ticket issued before owner metadata was lost must fail closed.
  delete (terminal as { owner?: unknown }).owner;
  assert.deepEqual(manager.list(process.cwd(), owner), []);
  for (const action of [
    () => manager.get(process.cwd(), "test", owner),
    () => manager.issueConnectToken(process.cwd(), "test", owner),
    () => manager.attach(process.cwd(), "test", 0, () => {}, () => {}, undefined, owner),
    () => manager.write(process.cwd(), "test", "attack", owner),
    () => manager.update(process.cwd(), "test", { title: "takeover" }, owner),
    () => manager.remove(process.cwd(), "test", owner),
  ]) assert.throws(action, { code: "TERMINAL_NOT_FOUND" });
  assert.equal(manager.consumeConnectToken("test", ticket), undefined);
  manager.closeWorkspace(process.cwd(), owner);
  assert.equal(manager.hasForeignInWorkspace(process.cwd(), owner), true);
  feed("\x1b]0;legacy title\x07");
  assert.deepEqual(updates, []);
})

test("scrollback bytes are bounded without changing character-based cursors", () => {
  const { terminal, feed } = fixture();
  const output = "中文😀".repeat(300000);
  feed(output);
  assert.ok(Buffer.byteLength(terminal.output) <= 2 * 1024 * 1024);
  assert.equal(terminal.outputBytes, Buffer.byteLength(terminal.output));
  assert.equal(terminal.bufferCursor + terminal.output.length, output.length);
  assert.ok(!terminal.output.includes("\ufffd"));
});
