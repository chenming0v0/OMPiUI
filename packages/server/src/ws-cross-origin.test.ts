import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import { EVENT_WS_SUBPROTOCOL, PROTOCOL_VERSION } from "@ompiui/protocol";
import { EventHub } from "./event-hub.ts";
import { terminalOwnerFromSecret } from "./host/terminal-auth.ts";
import { TerminalManager } from "./host/terminal-manager.ts";
import { ToolInteractionProxy, toolInteractionAuthScope } from "./omp/tool-interaction-proxy.ts";
import { attachEventWebSocket, closeEventWebSocket, type EventWebSocketOptions } from "./ws.ts";

const STATIC_ORIGIN = "https://panel.pages.dev";
const AUTH_TOKEN = "static-frontend-backend-secret";
const EVENT_PATH = "/api/v1/events";
const owner = terminalOwnerFromSecret("11".repeat(32))!;
type Handshake = { status: number; frame?: Record<string, unknown> };

async function fixture(t: TestContext, options: Omit<EventWebSocketOptions, "eventHub"> = {}) {
  const server = createServer();
  const wss = attachEventWebSocket(server, {
    eventHub: new EventHub(), authToken: AUTH_TOKEN, ...options,
  });
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await options.terminalManager?.shutdown();
    options.toolInteractionProxy?.dispose();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  // 等待真实握手结果和首帧，拒绝路径必须返回 HTTP 状态，不能把断连当作 403。
  async function connect(path: string, headers: Record<string, string> = {}): Promise<Handshake> {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`,
      path.startsWith(EVENT_PATH) ? EVENT_WS_SUBPROTOCOL : [], {
        headers: { Origin: STATIC_ORIGIN, ...headers }, handshakeTimeout: 5000,
      });
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    try {
      return await new Promise<Handshake>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket handshake or hello timed out")), 5000);
        socket.once("close", () => {
          clearTimeout(timer);
          reject(new Error("WebSocket closed before handshake or hello"));
        });
        socket.on("error", error => { clearTimeout(timer); reject(error); });
        socket.once("unexpected-response", (_request, response) => {
          clearTimeout(timer);
          response.resume();
          resolve({ status: response.statusCode! });
        });
        socket.once("message", data => {
          clearTimeout(timer);
          try { resolve({ status: 101, frame: JSON.parse(String(data)) }); }
          catch (error) { reject(error); }
        });
      });
    } finally {
      socket.terminate();
    }
  }
  return { connect, origin };
}

for (const credential of ["query", "Bearer"] as const) {
  test(`events accept a valid ${credential} token from independent static origins and send hello`, async t => {
    const f = await fixture(t);
    for (const origin of [STATIC_ORIGIN, "https://independent.example.net"]) {
      const response = await f.connect(
        credential === "query" ? `${EVENT_PATH}?token=${AUTH_TOKEN}` : EVENT_PATH,
        { Origin: origin, ...(credential === "Bearer" ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}) },
      );
      assert.equal(response.status, 101);
      // 现有事件协议的连接确认帧为 hello。
      assert.equal(response.frame?.type, "hello");
      assert.equal(response.frame?.protocolVersion, PROTOCOL_VERSION);
      assert.equal(response.frame?.service, "ompiui-server");
      assert.equal(response.frame?.subprotocol, EVENT_WS_SUBPROTOCOL);
    }
  });
}

test("events reject absent and invalid credentials from static and local origins", async t => {
  const f = await fixture(t);
  for (const origin of [STATIC_ORIGIN, f.origin]) {
    assert.equal((await f.connect(EVENT_PATH, { Origin: origin })).status, 403);
    assert.equal((await f.connect(`${EVENT_PATH}?token=incorrect`, { Origin: origin })).status, 403);
    assert.equal((await f.connect(EVENT_PATH, {
      Origin: origin, Authorization: "Bearer incorrect",
    })).status, 403);
  }
  assert.equal((await f.connect(`/api/v1/unknown?token=${AUTH_TOKEN}`)).status, 403);
});

test("anonymous events retain Origin checks despite supplied query or Bearer credentials", async t => {
  const f = await fixture(t, { authToken: null });
  assert.equal((await f.connect(EVENT_PATH)).status, 403);
  assert.equal((await f.connect(`${EVENT_PATH}?token=${AUTH_TOKEN}`)).status, 403);
  assert.equal((await f.connect(EVENT_PATH, { Authorization: `Bearer ${AUTH_TOKEN}` })).status, 403);
  const response = await f.connect(EVENT_PATH, { Origin: f.origin });
  assert.equal(response.status, 101);
  assert.equal(response.frame?.type, "hello");
});

test("anonymous events retain explicitly allowed origins", async t => {
  const f = await fixture(t, { authToken: null, allowedOrigins: () => [STATIC_ORIGIN] });
  assert.equal((await f.connect(EVENT_PATH)).frame?.type, "hello");
  assert.equal((await f.connect(EVENT_PATH, { Origin: "https://unconfigured.example.net" })).status, 403);
});

// 只替换进程执行端，ticket 的签发、过期、资源绑定和消费均使用实际实现。
function terminalManager() {
  return new TerminalManager({ spawn: () => {
    const exits = new Set<(event: { exitCode: number }) => void>();
    return {
      pid: 0, cols: 80, rows: 24,
      write() {}, resize() {},
      kill() { for (const listener of exits) listener({ exitCode: 0 }); },
      onData() { return { dispose() {} }; },
      onExit(listener) { exits.add(listener); return { dispose() { exits.delete(listener); } }; },
    };
  } });
}

const identity = { runtimeId: "runtime", sessionId: "session", toolCallId: "call", executionId: "execution" };
const descriptor = {
  ...identity, protocolVersion: 1 as const, status: "running" as const,
  command: "read", cwd: process.cwd(), cols: 80, rows: 24, cursor: 0, oldestCursor: 0,
};

function interactionProxy() {
  return new ToolInteractionProxy({ executeSessionCommand: async (sessionId, type, params) => {
    assert.equal(sessionId, identity.sessionId);
    assert.equal(type, "toolInteraction");
    if (params?.operation === "describe") return { ...descriptor };
    assert.equal(params?.operation, "read");
    return { descriptor: { ...descriptor }, fromCursor: 0, cursor: 0, data: "", reset: false };
  } });
}

async function ticketFixture(t: TestContext, kind: "terminal" | "interaction", authToken: string | null = AUTH_TOKEN) {
  if (kind === "terminal") {
    const manager = terminalManager();
    const f = await fixture(t, { terminalManager: manager, authToken });
    const terminal = await manager.create(process.cwd(), { shell: process.execPath, cols: 80, rows: 24 }, owner);
    return {
      ...f,
      streamPath: `/api/v1/host/terminals/${terminal.id}/stream`,
      mismatchedPaths: ["/api/v1/host/terminals/another-terminal/stream"],
      issueTicket: async () => manager.issueConnectToken(process.cwd(), terminal.id, owner).token,
      assertHello(frame: Handshake["frame"]) {
        assert.equal(frame?.type, "hello");
        assert.deepEqual(frame?.terminal, terminal);
      },
    };
  }
  const proxy = interactionProxy();
  const f = await fixture(t, { toolInteractionProxy: proxy, authToken });
  return {
    ...f,
    streamPath: `/api/v1/sessions/${identity.sessionId}/tool-interactions/${identity.executionId}/stream`,
    mismatchedPaths: [
      `/api/v1/sessions/another-session/tool-interactions/${identity.executionId}/stream`,
      `/api/v1/sessions/${identity.sessionId}/tool-interactions/another-execution/stream`,
    ],
    issueTicket: async () => (await proxy.issueTicket(identity, toolInteractionAuthScope(authToken))).ticket,
    assertHello(frame: Handshake["frame"]) {
      assert.equal(frame?.type, "hello");
      assert.deepEqual(frame?.descriptor, descriptor);
    },
  };
}

for (const kind of ["terminal", "interaction"] as const) {
  test(`${kind} accepts a cross-origin ticket, sends hello and rejects replay`, async t => {
    const f = await ticketFixture(t, kind);
    const ticket = await f.issueTicket();
    const url = `${f.streamPath}?ticket=${ticket}`;
    const response = await f.connect(url);
    assert.equal(response.status, 101);
    f.assertHello(response.frame);
    assert.equal((await f.connect(url)).status, 403);
  });

  test(`${kind} requires a ticket even with a valid Bearer or URL token`, async t => {
    const f = await ticketFixture(t, kind);
    assert.equal((await f.connect(f.streamPath)).status, 403);
    assert.equal((await f.connect(`${f.streamPath}?ticket=invalid`)).status, 403);
    assert.equal((await f.connect(f.streamPath, { Authorization: `Bearer ${AUTH_TOKEN}` })).status, 403);
    assert.equal((await f.connect(`${f.streamPath}?token=${AUTH_TOKEN}`)).status, 403);
    const ticket = await f.issueTicket();
    assert.equal((await f.connect(`${f.streamPath}?ticket=${ticket}&token=${AUTH_TOKEN}`)).status, 403);
    assert.equal((await f.connect(`${f.streamPath}?ticket=${ticket}&token=`)).status, 403);
    // URL 长期 token 的拒绝发生在消费 ticket 前，干净的重试仍可连接。
    const response = await f.connect(`${f.streamPath}?ticket=${ticket}`);
    assert.equal(response.status, 101);
    f.assertHello(response.frame);
  });

  test(`${kind} rejects tickets for another resource and consumes the attempted ticket`, async t => {
    const f = await ticketFixture(t, kind);
    for (const otherPath of f.mismatchedPaths) {
      const ticket = await f.issueTicket();
      assert.equal((await f.connect(`${otherPath}?ticket=${ticket}`)).status, 403);
      assert.equal((await f.connect(`${f.streamPath}?ticket=${ticket}`)).status, 403);
    }
  });

  test(`${kind} rejects expired tickets from the static frontend`, async t => {
    const f = await ticketFixture(t, kind);
    const issuedAt = Date.now() - 61_000;
    const clock = t.mock.method(Date, "now", () => issuedAt);
    let ticket: string;
    try { ticket = await f.issueTicket(); }
    finally { clock.mock.restore(); }
    assert.equal((await f.connect(`${f.streamPath}?ticket=${ticket}`)).status, 403);
  });

  test(`${kind} retains Origin checks in anonymous mode even with a valid ticket`, async t => {
    const f = await ticketFixture(t, kind, null);
    const ticket = await f.issueTicket();
    const url = `${f.streamPath}?ticket=${ticket}`;
    assert.equal((await f.connect(url, { Authorization: `Bearer ${AUTH_TOKEN}` })).status, 403);
    const response = await f.connect(url, { Origin: f.origin });
    assert.equal(response.status, 101);
    f.assertHello(response.frame);
  });
}

test("interaction rejects a ticket issued for another auth scope", async t => {
  const proxy = interactionProxy();
  const f = await fixture(t, { toolInteractionProxy: proxy });
  const { ticket } = await proxy.issueTicket(identity, toolInteractionAuthScope("another-secret"));
  const url = `/api/v1/sessions/${identity.sessionId}/tool-interactions/${identity.executionId}/stream?ticket=${ticket}`;
  assert.equal((await f.connect(url, { Authorization: `Bearer ${AUTH_TOKEN}` })).status, 403);
});
