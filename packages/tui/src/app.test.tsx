import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { ConsoleApp } from "./app.tsx";
import { ConsoleController } from "./controller.ts";
import type { ConsoleData } from "./types.ts";

const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
const data: ConsoleData = {
  name: "Server",
  subtitle: "LOCAL OWNER",
  status: "运行中",
  tone: "success",
  endpoint: "http://127.0.0.1:8787",
  ownedRunning: true,
  logs: [],
  views: [
    {
      id: "overview",
      label: "概览",
      caption: "本机后端",
      rows: [
        {
          id: "url",
          label: "后端地址",
          value: "https://example.com/a/very/long/path/".repeat(5),
        },
      ],
      actions: [
        { id: "stop", label: "停止后端", key: "x", confirm: "中断当前任务？" },
      ],
    },
    {
      id: "credentials",
      label: "凭证与配对",
      caption: "访问令牌",
      rows: [
        {
          id: "token",
          label: "访问令牌",
          value: "private-access-token",
          secret: true,
        },
      ],
      actions: [{ id: "reveal", label: "显示或隐藏凭证", key: "v" }],
    },
  ],
};

for (const columns of [48, 80, 120]) {
  test(`layout fits a ${columns}-column terminal with long values`, async (t) => {
    const controller = new ConsoleController({
      read: async () => data,
      execute: async () => "",
      dispose: async () => {},
    });
    await controller.start();
    const screen = render(
      <ConsoleApp
        controller={controller}
        onExit={() => {}}
        dimensions={{ columns, rows: 24 }}
      />,
    );
    t.after(async () => {
      screen.unmount();
      await controller.shutdown();
    });
    await pause();
    const frame = screen.lastFrame()!;
    assert.match(frame, /OMPiUI/);
    assert.match(frame, /运行中/);
    assert.ok(frame.split("\n").length <= 23);
    for (const line of frame.split("\n"))
      assert.ok(stringWidth(line) <= columns, `too wide: ${line}`);
  });
}

test("credentials are masked, reveal is explicit, and navigation hides them again", async (t) => {
  const controller = new ConsoleController({
    read: async () => data,
    execute: async () => "",
    dispose: async () => {},
  });
  await controller.start();
  const screen = render(
    <ConsoleApp
      controller={controller}
      onExit={() => {}}
      dimensions={{ columns: 100, rows: 24 }}
    />,
  );
  t.after(async () => {
    screen.unmount();
    await controller.shutdown();
  });
  await pause();
  screen.stdin.write("\t");
  await pause();
  assert.match(screen.lastFrame()!, /\*{8}/);
  assert.doesNotMatch(screen.lastFrame()!, /private-access-token/);
  screen.stdin.write("v");
  await pause();
  assert.match(screen.lastFrame()!, /private-access-token/);
  screen.stdin.write("\t");
  await pause();
  screen.stdin.write("\t");
  await pause();
  assert.doesNotMatch(screen.lastFrame()!, /private-access-token/);
});

test("destructive actions and exit default to cancel", async (t) => {
  let actions = 0;
  let exits = 0;
  const controller = new ConsoleController({
    read: async () => data,
    execute: async () => {
      actions++;
      return "";
    },
    dispose: async () => {},
  });
  await controller.start();
  const screen = render(
    <ConsoleApp
      controller={controller}
      onExit={() => {
        exits++;
      }}
      dimensions={{ columns: 100, rows: 24 }}
    />,
  );
  t.after(async () => {
    screen.unmount();
    await controller.shutdown();
  });
  await pause();
  screen.stdin.write("x");
  await pause();
  assert.match(screen.lastFrame()!, /中断当前任务/);
  screen.stdin.write("\r");
  await pause();
  assert.equal(actions, 0);
  screen.stdin.write("x");
  await pause();
  screen.stdin.write("\u001b[C");
  await pause();
  screen.stdin.write("\r");
  await pause();
  assert.equal(actions, 1);
  screen.stdin.write("q");
  await pause();
  assert.match(screen.lastFrame()!, /退出管理器/);
  screen.stdin.write("\u001b");
  await pause();
  assert.equal(exits, 0);
});

test("command palette filters actions without triggering them", async (t) => {
  let actions = 0;
  const controller = new ConsoleController({
    read: async () => data,
    execute: async () => {
      actions++;
      return "";
    },
    dispose: async () => {},
  });
  await controller.start();
  const screen = render(
    <ConsoleApp
      controller={controller}
      onExit={() => {}}
      dimensions={{ columns: 80, rows: 24 }}
    />,
  );
  t.after(async () => {
    screen.unmount();
    await controller.shutdown();
  });
  await pause();
  screen.stdin.write("/");
  await pause();
  assert.match(screen.lastFrame()!, /命令面板/);
  screen.stdin.write("nothing");
  await pause();
  assert.match(screen.lastFrame()!, /没有匹配的命令/);
  assert.equal(actions, 0);
});

test("short terminal windows retain the essential navigation and exit controls", async (t) => {
  const controller = new ConsoleController({
    read: async () => data,
    execute: async () => "",
    dispose: async () => {},
  });
  await controller.start();
  const screen = render(
    <ConsoleApp
      controller={controller}
      onExit={() => {}}
      dimensions={{ columns: 48, rows: 20 }}
    />,
  );
  t.after(async () => {
    screen.unmount();
    await controller.shutdown();
  });
  await pause();
  assert.match(screen.lastFrame()!, /Tab 分页/);
  assert.match(screen.lastFrame()!, /q 退出/);
});
