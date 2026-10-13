import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "./terminal-manager.ts";
import { TextWindow } from "./text-window.ts";

function fixture() {
  const updates: string[] = [];
  const manager = new TerminalManager({
    publish: (_workspace, channel) => updates.push(channel),
  });
  const outputWindow = new TextWindow(2 * 1024 * 1024);
  const terminal = {
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
  const attachment = manager.attach(process.cwd(), "test", -1, () => {}, () => {}, title => titles.push(title));
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
  const first = manager.issueConnectToken(process.cwd(), "test");
  const internals = manager as unknown as { tickets: Map<string, { expiresAt: number }> };
  internals.tickets.get(first.token)!.expiresAt = Date.now() - 1;
  const second = manager.issueConnectToken(process.cwd(), "test");
  const third = manager.issueConnectToken(process.cwd(), "test");
  assert.equal(internals.tickets.size, 2);
  assert.equal(manager.consumeConnectToken("test", first.token), undefined);
  assert.equal(manager.consumeConnectToken("test", second.token), process.cwd());
  assert.equal(manager.consumeConnectToken("test", third.token), process.cwd());
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
  manager.write(process.cwd(), "test", "first");
  manager.write(process.cwd(), "test", "second");
  pty._agent.inSocket.writableLength = 1024 * 1024;
  assert.throws(() => manager.write(process.cwd(), "test", "blocked"), { code: "RATE_LIMITED" });
  assert.deepEqual(writes, ["first", "second"]);
});

test("direct terminal renames enforce the title byte budget", () => {
  const { manager } = fixture();
  assert.throws(() => manager.update(process.cwd(), "test", { title: "标题".repeat(100) }), { code: "INVALID_REQUEST" });
  assert.equal(manager.update(process.cwd(), "test", { title: "custom" }).title, "custom");
});

test("scrollback bytes are bounded without changing character-based cursors", () => {
  const { terminal, feed } = fixture();
  const output = "中文😀".repeat(300000);
  feed(output);
  assert.ok(Buffer.byteLength(terminal.output) <= 2 * 1024 * 1024);
  assert.equal(terminal.outputBytes, Buffer.byteLength(terminal.output));
  assert.equal(terminal.bufferCursor + terminal.output.length, output.length);
  assert.ok(!terminal.output.includes("\ufffd"));
});
