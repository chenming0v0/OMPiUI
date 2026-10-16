import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, eventStreamKey } from "@ompiui/protocol";
import { EventHub } from "./event-hub.ts";
import { attachEventWebSocket, closeEventWebSocket } from "./ws.ts";
import { createAppServer } from "./http.ts";
import { MAX_PROMPT_BODY_BYTES } from "./host/security.ts";
import type { TerminalManager } from "./host/terminal-manager.ts";
import { diagnostics, type DiagnosticFields } from "./diagnostics/recorder.ts";
import { FaultReportService } from "./diagnostics/fault-reports.ts";

test("event history bounds bytes globally and per stream, retaining correct expired-cursor semantics", () => {
  const hub = new EventHub();
  const stream = { kind: "session" as const, id: "large" };
  const before = hub.getCursor(stream);
  for (let index = 0; index < 5; index++)
    hub.publish(stream, "session.head", { text: "x".repeat(700000) });
  assert.equal(hub.replaySince(stream, before).reason, "history_expired");
  const retained = hub.replaySince(stream, {
    ...hub.getCursor(stream),
    sequence: 3,
  });
  assert.equal(retained.events.length, 2);
  for (let index = 0; index < 50; index++) {
    hub.publish({ kind: "session", id: String(index) }, "session.head", {
      text: "x".repeat(700000),
    });
  }
  assert.ok(
    (hub as unknown as { historyBytes: number }).historyBytes <=
      32 * 1024 * 1024,
  );
  hub.resetEpoch(stream);
  assert.equal(
    hub.replaySince(stream, hub.getCursor(stream)).resyncRequired,
    false,
  );
});

test("event subscribers have a finite ceiling and release slots on unsubscribe", () => {
  const hub = new EventHub();
  const subscribers = Array.from({ length: 1024 }, () =>
    hub.subscribe(() => {}),
  );
  assert.throws(() => hub.subscribe(() => {}), /limit/);
  subscribers[0]!();
  const remove = hub.subscribe(() => {});
  remove();
  for (const unsubscribe of subscribers) unsubscribe();
});

test("event replay rotates past a hot stream before draining its entire backlog", { timeout: 5000 }, async () => {
  const server = createServer();
  const hub = new EventHub();
  const wss = attachEventWebSocket(server, { eventHub: hub, authToken: null });
  const streams = [{ kind: "session" as const, id: "hot" }, { kind: "session" as const, id: "other" }];
  const cursors = hub.getCursorMap(streams);
  for (let index = 0; index < 128; index++) hub.publish(streams[0]!, "session.head", { body: "x".repeat(8192) });
  hub.publish(streams[1]!, "session.head", {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`);
  const received: string[] = [];
  const other = new Promise<void>(resolve => ws.on("message", data => {
    const frame = JSON.parse(String(data));
    if (!frame.event) return;
    received.push(frame.event.stream.id);
    if (frame.event.stream.id === "other") resolve();
  }));
  try {
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "subscribe", protocolVersion: PROTOCOL_VERSION, streams, cursors }));
    await other;
    assert.ok(received.indexOf("other") <= 64, "a hot backlog must yield within a replay batch");
  } finally {
    ws.terminate();
    await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("real websocket subscriptions replay only newly added streams and cap connections", async () => {
  const server = createServer();
  const hub = new EventHub();
  let snapshots = 0;
  const wss = attachEventWebSocket(server, {
    eventHub: hub,
    authToken: null,
    maxConnections: 1,
    onSubscribe: () => {
      snapshots++;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`);
  const received: Array<{
    type?: string;
    event?: { stream: { id: string }; channel?: string };
    eventChannel?: string;
    cursor?: unknown;
    eventId?: string;
  }> = [];
  ws.on("message", (data) => received.push(JSON.parse(String(data))));
  const serverStream = { kind: "server" as const, id: "server" };
  const sessionStream = { kind: "session" as const, id: "s" };
  const cursors = hub.getCursorMap([serverStream, sessionStream]);
  hub.publish(serverStream, "sessions.updated", {});
  hub.publish(sessionStream, "session.head", {});
  const subscribe = async (
    streams:
      | (typeof serverStream)[]
      | Array<typeof serverStream | typeof sessionStream>,
  ) => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        protocolVersion: PROTOCOL_VERSION,
        streams,
        cursors,
      }),
    );
    const pong = new Promise<void>((resolve) => {
      const listener = (data: unknown) => {
        if (JSON.parse(String(data)).type === "pong") {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });
    ws.send(
      JSON.stringify({ type: "ping", protocolVersion: PROTOCOL_VERSION }),
    );
    await pong;
  };
  try {
    await once(ws, "open");
    await subscribe([serverStream]);
    await subscribe([serverStream, sessionStream]);
    await subscribe([serverStream, sessionStream]);
    assert.deepEqual(
      received
        .filter((frame) => frame.event)
        .map((frame) => frame.event!.stream.id),
      ["server", "s"],
    );
    assert.equal(snapshots, 1);
    const refused = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`);
    const status = await new Promise<number>((resolve) => {
      refused.on("error", () => {});
      refused.on("unexpected-response", (_req, response) => {
        response.resume();
        resolve(response.statusCode!);
        refused.terminate();
      });
    });
    assert.equal(status, 503);
    hub.publish(sessionStream, "session.head", {
      text: "x".repeat(5 * 1024 * 1024),
    });
    await subscribe([serverStream, sessionStream]);
    const changed = received.find((frame) => frame.type === "payload_omitted");
    assert.ok(changed);
    assert.equal(changed.eventChannel, "session.head");
    assert.equal(changed.event, undefined);
    assert.deepEqual(changed.cursor, hub.getCursor(sessionStream));
    assert.equal(typeof changed.eventId, "string");
    hub.publish(sessionStream, "command.updated", {
      id: "x".repeat(5 * 1024 * 1024), status: "completed",
    });
    await subscribe([serverStream, sessionStream]);
    const omittedCommand = received.find((frame) =>
      frame.type === "payload_omitted" && frame.eventChannel === "command.updated",
    );
    assert.ok(omittedCommand);
    assert.equal("commandId" in omittedCommand, false);
    assert.ok(Buffer.byteLength(JSON.stringify(omittedCommand)) < 4096);
    assert.equal(
      received.some((frame) => frame.type === "resync_required"),
      false,
    );
  } finally {
    ws.terminate();
    await new Promise<void>((resolve) =>
      closeEventWebSocket(wss, () => resolve()),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("subscribe storms are bounded without disconnecting the client", async t => {
  const records: Array<{ event: string; fields: DiagnosticFields }> = [];
  t.mock.method(diagnostics, "record", (event: string, fields: DiagnosticFields = {}) => records.push({ event, fields }));
  const server = createServer();
  const wss = attachEventWebSocket(server, { eventHub: new EventHub(), authToken: null });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`);
  try {
    await once(ws, "open");
    const streams = Array.from({ length: 256 }, (_, index) => ({ kind: "session", id: String(index) }));
    for (let index = 0; index < 20; index++) {
      ws.send(JSON.stringify({ type: "subscribe", protocolVersion: PROTOCOL_VERSION, streams, cursors: {} }));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.ok(records.filter(record => record.event === "connection.subscribed").length <= 12);
    const resync = records.filter(record => record.event === "connection.resync");
    assert.equal(resync.length, 1);
    assert.equal(resync[0]!.fields.count, 256);
  } finally {
    ws.terminate();
    await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const terminal of [false, true]) {
  test(`${terminal ? "terminal" : "event"} websocket rejects fragmented input before business dispatch`, { timeout: 5000 }, async () => {
    const server = createServer();
    let inputs = 0;
    const manager = {
      consumeConnectToken: () => "/workspace",
      attach: () => ({ replay: "", replayCursor: 0, cursor: 0, activate() {}, detach() {} }),
      get: () => ({ id: "t", cursor: 0, status: "running" }),
      write: () => { inputs++; },
    } as unknown as TerminalManager;
    const wss = attachEventWebSocket(server, { eventHub: new EventHub(), authToken: null, terminalManager: manager });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const route = terminal ? "/api/v1/host/terminals/t/stream?ticket=test" : "/api/v1/events";
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}${route}`);
    try {
      await once(ws, "open");
      const closed = once(ws, "close");
      ws.send('{"type":"', { fin: false });
      ws.send('ping"}', { fin: true });
      const [code] = await closed;
      assert.equal(code, 1008);
      assert.equal(inputs, 0);
    } finally {
      ws.terminate();
      await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("terminal malformed-frame floods close rather than enqueue unbounded problem replies", async () => {
  const server = createServer();
  const manager = {
    consumeConnectToken: () => "/workspace",
    attach: () => ({ replay: "", replayCursor: 0, cursor: 0, activate() {}, detach() {} }),
    get: () => ({ id: "t", cursor: 0, status: "running" }),
  } as unknown as TerminalManager;
  const wss = attachEventWebSocket(server, { eventHub: new EventHub(), authToken: null, terminalManager: manager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/host/terminals/t/stream?ticket=test`);
  let problems = 0;
  ws.on("message", data => { if (JSON.parse(String(data)).type === "problem") problems++; });
  try {
    await once(ws, "open");
    const closed = once(ws, "close");
    for (let index = 0; index < 300; index++) ws.send("{");
    const [code] = await closed;
    assert.equal(code, 1013);
    assert.ok(problems <= 240);
  } finally {
    ws.terminate();
    await new Promise<void>(resolve => closeEventWebSocket(wss, () => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("terminal output pauses at the render window and resumes losslessly after consumed cursor acknowledgements", { timeout: 5000 }, async () => {
  const server = createServer();
  let detached = false;
  let activated = false;
  const source = "x".repeat(1024 * 1024);
  const manager = {
    consumeConnectToken: () => "/workspace",
    attach: (_workspace: string, _id: string, cursor = 0) => ({
      replay: source.slice(cursor),
      replayCursor: cursor,
      cursor: source.length,
      activate: () => {
        activated = true;
      },
      detach: () => {
        detached = true;
      },
    }),
    get: () => ({ id: "t", cursor: source.length, status: "running" }),
  } as unknown as TerminalManager;
  const wss = attachEventWebSocket(server, {
    eventHub: new EventHub(),
    authToken: null,
    terminalManager: manager,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/api/v1/host/terminals/t/stream?ticket=test&protocolVersion=2`,
  );
  let restored = "";
  let consumedCursor = 0;
  let ready = false;
  let outputAck = false;
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "hello") outputAck = frame.outputAck === true;
    if (frame.type === "ready") ready = true;
    if (frame.type === "output") {
      assert.equal(frame.cursor, restored.length + frame.data.length);
      restored += frame.data;
      consumedCursor = frame.cursor;
    }
  });
  try {
    await once(ws, "open");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(outputAck, true);
    assert.ok(restored.length > 0 && restored.length <= 256 * 1024);
    const pausedAt = restored.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(restored.length, pausedAt);
    assert.equal(detached, true);
    assert.equal(activated, false);
    assert.equal(ready, false);
    for (let attempt = 0; !ready && attempt < 20; attempt++) {
      ws.send(JSON.stringify({ type: "output_ack", cursor: consumedCursor }));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true);
    assert.equal(activated, true);
    assert.equal(restored, source);
    assert.equal(ws.readyState, WebSocket.OPEN);
    const closed = once(ws, "close");
    ws.send(JSON.stringify({ type: "output_ack", cursor: source.length + 1 }));
    assert.equal((await closed)[0], 1008);
  } finally {
    ws.terminate();
    await new Promise<void>((resolve) =>
      closeEventWebSocket(wss, () => resolve()),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP compresses negotiated JSON and all three command routes reject bodies beyond the prompt budget", async () => {
  const previous = process.env.OMPIUI_DRIVER;
  process.env.OMPIUI_DRIVER = "mock";
  const app = createAppServer({ authToken: null });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = (app.server.address() as { port: number }).port;
  const get = (encoding: string) =>
    new Promise<{ encoding?: string; body: Buffer }>((resolve) => {
      request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/v1/pi/registry",
          headers: { "accept-encoding": encoding },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              encoding: String(res.headers["content-encoding"] ?? ""),
              body: Buffer.concat(chunks),
            }),
          );
        },
      ).end();
    });
  try {
    const gzip = await get("gzip");
    assert.equal(gzip.encoding, "gzip");
    const plain = await get("gzip;q=0");
    assert.equal(plain.encoding, "");
    assert.deepEqual(
      JSON.parse(gunzipSync(gzip.body).toString()),
      JSON.parse(plain.body.toString()),
    );
    assert.ok(plain.body.length > gzip.body.length);
    for (const route of [
      "/api/v1/pi/commands/noop",
      "/api/v1/pi/sessions/s/commands/noop",
      "/api/v1/host/commands/noop",
    ]) {
      const body = Buffer.alloc(MAX_PROMPT_BODY_BYTES + 1, 32);
      const response = await new Promise<{
        status: number;
        connection: string | undefined;
      }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: route,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": body.length,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                connection: res.headers.connection,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      assert.equal(response.status, 413);
      assert.equal(response.connection, "close");
    }
  } finally {
    await app.dispose();
    if (previous === undefined) delete process.env.OMPIUI_DRIVER;
    else process.env.OMPIUI_DRIVER = previous;
  }
});

test("HTTP rejects oversized command ids before cold attachment or command retention", async () => {
  const app = createAppServer({ authToken: null });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = (app.server.address() as { port: number }).port;
  try {
    for (const id of ["x".repeat(1025), "中".repeat(342)]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/pi/sessions/cold/commands/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, params: { text: "must not execute" } }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "INVALID_REQUEST");
      assert.equal(app.sessionHost.getCommand(id), undefined);
      assert.deepEqual(app.sessionHost.listAttachedIds(), []);
    }
  } finally {
    await app.dispose();
  }
});

test("diagnostic report limits distinguish trusted tunnel clients and reject untrusted XFF rotation", async t => {
  const collect = t.mock.method(FaultReportService.prototype, "collect", async () => ({
    report: { content: "diagnostic fixture" },
  } as Awaited<ReturnType<FaultReportService["collect"]>>));
  const previous = process.env.OMPIUI_DRIVER;
  process.env.OMPIUI_DRIVER = "mock";
  const app = createAppServer({ authToken: null, tunnelForwardingToken: "internal-test" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = (app.server.address() as { port: number }).port;
  const get = async (ip: string, marker = "internal-test") => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/host/diagnostics/report`, {
      headers: { "x-forwarded-for": ip, "x-ompiui-internal-tunnel": marker },
    });
    await response.text();
    return response.status;
  };
  try {
    assert.equal(await get("203.0.113.1"), 200);
    assert.equal(await get("203.0.113.2"), 200);
    assert.equal(await get("203.0.113.1"), 429);
    assert.equal(await get("203.0.113.3", "invalid"), 200);
    assert.equal(await get("203.0.113.4", "invalid"), 429);
    assert.equal(collect.mock.callCount(), 3);
  } finally {
    await app.dispose();
    if (previous === undefined) delete process.env.OMPIUI_DRIVER;
    else process.env.OMPIUI_DRIVER = previous;
  }
});
