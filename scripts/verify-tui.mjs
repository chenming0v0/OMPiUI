import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", {
    paths: [process.env.OMPIUI_PLAYWRIGHT_MODULE_DIR || root],
  }),
);
const pty = require("@lydell/node-pty");
const xterm = dirname(require.resolve("@xterm/xterm/package.json"));
const output = resolve(process.argv[2] || join(root, "artifacts", "tui"));
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "ompiui-tui-visual-"));
const terminals = [];
let browser;
let peer;
let frames = "";
let dimensions = { columns: 120, rows: 32 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = {
  ...process.env,
  TERM: "xterm-256color",
  FORCE_COLOR: "3",
  CI: "false",
  CONTINUOUS_INTEGRATION: "false",
  OMPIUI_DATA_DIR: temporary,
  OMPIUI_ADMIN_DATA_DIR: temporary,
  OMPIUI_DRIVER: "mock",
  OMPIUI_AUTH_TOKEN: "visual-test-backend-token",
  OMPIUI_ADMIN_TOKEN: "visual-test-admin-token",
};
delete env.NO_COLOR;

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const web = createServer((request, response) => {
  if (request.url === "/xterm.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(readFileSync(join(xterm, "lib", "xterm.js")));
    return;
  }
  if (request.url === "/xterm.css") {
    response.setHeader("content-type", "text/css");
    response.end(readFileSync(join(xterm, "css", "xterm.css")));
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><link rel="stylesheet" href="/xterm.css">
    <style>html,body{margin:0;background:#101010}#terminal{padding:16px;width:max-content}
    .xterm{font-variant-ligatures:none}</style></head><body><div id="terminal"></div>
    <script src="/xterm.js"></script><script>
    window.term=new Terminal({cols:${dimensions.columns},rows:${dimensions.rows},fontSize:15,
      fontFamily:'Consolas,"Microsoft YaHei",monospace',cursorBlink:false,convertEol:false,
      theme:{background:'#101010',foreground:'#eeeeee'},allowProposedApi:true});
    term.open(document.getElementById('terminal'));window.ready=true;</script></body></html>`);
});

async function launch(mode, args = []) {
  frames = "";
  const terminal = pty.spawn(
    process.execPath,
    [join(root, `packages/${mode}/dist/cli.js`), "tui", ...args],
    {
      name: "xterm-256color",
      cols: dimensions.columns,
      rows: dimensions.rows,
      cwd: root,
      env,
    },
  );
  const item = { terminal, exit: null };
  terminal.onData((data) => {
    frames += data;
  });
  terminal.onExit((event) => {
    item.exit = event.exitCode;
  });
  terminals.push(item);
  await waitFor(() => frames.includes("OMPiUI"), "TUI first frame");
  await sleep(300);
  return item;
}

async function waitFor(predicate, label) {
  for (let count = 0; count < 200; count++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function capture(name) {
  await sleep(300);
  const page = await browser.newPage({
    viewport: { width: 1400, height: 800 },
    deviceScaleFactor: 1,
  });
  try {
    await page.goto(`http://127.0.0.1:${web.address().port}`);
    await page.waitForFunction(() => window.ready);
    await page.evaluate(
      (data) => new Promise((resolve) => window.term.write(data, resolve)),
      frames,
    );
    const lines = await page.evaluate(() => {
      const buffer = window.term.buffer.active;
      return Array.from(
        { length: window.term.rows },
        (_, index) =>
          buffer.getLine(buffer.viewportY + index)?.translateToString(true) ||
          "",
      );
    });
    const text = lines.join("\n");
    assert.match(text, /OMPiUI/);
    assert.doesNotMatch(
      text,
      /visual-test-backend-token|visual-test-admin-token/,
    );
    await page
      .locator("#terminal")
      .screenshot({ path: join(output, `${name}.png`) });
    writeFileSync(join(output, `${name}.txt`), text);
    writeFileSync(join(output, `${name}.ansi`), frames);
    return text;
  } finally {
    await page.close();
  }
}

async function exit(item) {
  item.terminal.write("q");
  await sleep(150);
  // 运行中的本地服务有退出确认，默认取消；显式选中确认后关闭。
  if (frames.includes("退出管理器")) {
    item.terminal.write("\u001b[C");
    await sleep(100);
    item.terminal.write("\r");
  }
  await waitFor(() => item.exit !== null, "TUI cleanup");
  assert.equal(item.exit, 0);
}

try {
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    headless: true,
    channel: process.env.OMPIUI_TUI_BROWSER_CHANNEL || undefined,
  });
  const backendPort = await freePort();
  const adminPort = await freePort();
  writeFileSync(
    join(temporary, "admin.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: adminPort,
      serverCommand: process.execPath,
      serverArgs: [join(root, "packages/server/dist/bundle-entry.js"), "web"],
      serverCwd: root,
      serverUrl: `http://127.0.0.1:${backendPort}`,
      serverEnv: {
        OMPIUI_HOST: "127.0.0.1",
        OMPIUI_PORT: String(backendPort),
        OMPIUI_DRIVER: "mock",
      },
    }),
  );
  const server = await launch("admin");
  server.terminal.write("s");
  await waitFor(() => frames.includes("运行中"), "backend ready");
  assert.match(await capture("server-overview-120"), /运行中/);
  server.terminal.write("\t");
  await sleep(150);
  server.terminal.write("e");
  assert.match(await capture("server-network-form-120"), /编辑配置/);
  server.terminal.write("\u001b");
  await sleep(150);
  server.terminal.write("\t");
  await sleep(150);
  server.terminal.write("i");
  const credentials = await capture("server-credentials-120");
  assert.match(credentials, /\*{8}/);
  server.terminal.write("\u001b");
  await sleep(150);
  server.terminal.write("\t");
  assert.match(await capture("server-logs-120"), /运行日志/);
  await exit(server);
  await assert.rejects(
    fetch(`http://127.0.0.1:${backendPort}/api/v1/host/health`),
  );

  const relayPort = await freePort();
  const relayPath = join(temporary, "relay.json");
  writeFileSync(
    relayPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: relayPort,
      publicUrl: "https://relay.example.com",
      tunnels: [
        { id: "home", key: "visual-private-relay-key-0123456789" },
        { id: "office", key: "visual-private-office-key-0123456789" },
      ],
    }),
  );
  const relay = await launch("relay", ["--config", relayPath]);
  relay.terminal.write("s");
  await waitFor(() => frames.includes("运行中"), "relay ready");
  peer = new WebSocket(`ws://127.0.0.1:${relayPort}/_tunnel?tunnel=home`, {
    headers: { authorization: "Bearer visual-private-relay-key-0123456789" },
  });
  await new Promise((resolve, reject) => {
    peer.once("message", resolve);
    peer.once("error", reject);
  });
  await sleep(2200);
  await capture("relay-overview-120");
  relay.terminal.write("\t");
  assert.match(await capture("relay-tunnels-120"), /在线/);
  relay.terminal.write("/");
  assert.match(await capture("relay-command-palette-120"), /命令面板/);
  relay.terminal.write("\u001b");
  await sleep(150);
  relay.terminal.resize(80, 24);
  dimensions = { columns: 80, rows: 24 };
  assert.match(await capture("relay-tunnels-80"), /在线/);
  relay.terminal.resize(48, 20);
  dimensions = { columns: 48, rows: 20 };
  assert.match(await capture("relay-tunnels-48"), /在线/);
  await exit(relay);
  peer.terminate();
  console.log(`TUI verification passed. Screenshots: ${output}`);
} finally {
  peer?.terminate();
  for (const item of terminals) if (item.exit === null) item.terminal.kill();
  await browser?.close();
  await new Promise((resolve) => web.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
// Windows ConPTY 包会保留已退出终端的管道句柄；验证资源关闭后明确结束脚本。
process.exit(0);
