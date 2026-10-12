import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleController } from "./controller.ts";
import { LogBuffer, safeText } from "./logs.ts";
import type { ConsoleAdapter, ConsoleData } from "./types.ts";

const data: ConsoleData = {
  name: "Server",
  subtitle: "LOCAL",
  status: "已停止",
  tone: "neutral",
  endpoint: "http://127.0.0.1:8787",
  ownedRunning: false,
  views: [],
  logs: [],
};

test("refresh never starts the service and overlapping actions run once", async (t) => {
  let actions = 0;
  let release!: () => void;
  let disposed = 0;
  const adapter: ConsoleAdapter = {
    read: async () => data,
    execute: async () => {
      actions += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    },
    dispose: async () => {
      disposed += 1;
    },
  };
  const controller = new ConsoleController(adapter);
  t.after(() => controller.shutdown());
  await controller.start();
  await controller.refresh();
  assert.equal(actions, 0);
  const running = controller.run("start", "start");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await controller.run("start", "start"), false);
  assert.equal(actions, 1);
  release();
  assert.equal(await running, true);
  assert.equal(controller.getSnapshot().busy, null);
  await Promise.all([controller.shutdown(), controller.shutdown()]);
  assert.equal(disposed, 1);
});

test("failed actions redact newly entered keys and remain retryable", async (t) => {
  const controller = new ConsoleController({
    read: async () => data,
    execute: async (_id, values) => {
      throw new Error(`bad key ${values.tunnelKey} ?token=secret`);
    },
    dispose: async () => {},
  });
  t.after(() => controller.shutdown());
  assert.equal(
    await controller.run("save", "save", { tunnelKey: "new-private-key" }),
    false,
  );
  assert.doesNotMatch(
    controller.getSnapshot().error ?? "",
    /new-private-key|token=secret/,
  );
  assert.equal(controller.getSnapshot().busy, null);
});

test("logs are bounded and remove terminal control codes and credentials", () => {
  const logs = new LogBuffer(() => ["private-token"]);
  for (let index = 0; index < 350; index++)
    logs.append(
      `\u001b[31mline ${index} private-token ?token=abc&x=1\u001b[0m`,
    );
  assert.equal(logs.read().length, 300);
  assert.doesNotMatch(
    JSON.stringify(logs.read()),
    /private-token|token=abc|\\u001b/,
  );
  assert.equal(safeText("\u001b]0;title\u0007test"), "test");
});

test("shutdown cancels actions awaiting a refresh before they can start anything", async () => {
  let release!: (data: ConsoleData) => void;
  let actions = 0;
  let disposed = false;
  const controller = new ConsoleController({
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    execute: async () => {
      actions++;
      return "started";
    },
    dispose: async () => {
      disposed = true;
    },
  });
  const reading = controller.refresh();
  const starting = controller.run("start", "start");
  const closing = controller.shutdown();
  release(data);
  await Promise.all([reading, starting, closing]);
  assert.equal(actions, 0);
  assert.equal(disposed, true);
});

test("shutdown waits for an active operation before disposing its resources", async () => {
  let finish!: () => void;
  const order: string[] = [];
  const controller = new ConsoleController({
    read: async () => data,
    execute: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      order.push("operation");
      return "done";
    },
    dispose: async () => {
      order.push("dispose");
    },
  });
  const operation = controller.run("restart", "restart");
  await new Promise((resolve) => setImmediate(resolve));
  const closing = controller.shutdown();
  assert.deepEqual(order, []);
  finish();
  await Promise.all([operation, closing]);
  assert.deepEqual(order, ["operation", "dispose"]);
});
