import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OmpRpcClient, type OmpRpcFrame } from "./rpc-client.js"

// Controlled wire subprocess regression, NOT official-native acceptance evidence.
// The real OMP 18.12.6 smoke lives in scripts/verify-rpc-stream-errors.mjs.
const childSource = `import { createInterface } from 'node:readline';
import { once } from 'node:events';
const emit = async frame => { if (!process.stdout.write(JSON.stringify(frame) + '\\n')) await once(process.stdout, 'drain'); };
await emit({ type: 'ready', protocolVersion: 1 });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'exercise') {
    const payload = Buffer.from(JSON.stringify({ type: 'notice', text: '正文😀' + 'x'.repeat(1152 * 1024) }));
    const step = 256 * 1024, count = Math.ceil(payload.length / step);
    for (let index = 0; index < count; index++) {
      const data = Buffer.from(payload.subarray(index * step, (index + 1) * step));
      if (request.mode === 'frame' && index === 0) data[0] = 0xff;
      await emit({ type: 'rpc_chunk', chunkId: 'controlled-' + request.mode, index, count, byteLength: payload.length + (request.mode === 'stream' ? 1 : 0), data: data.toString('base64') });
    }
    await emit({ type: 'notice', text: 'native-process-continued' });
  }
  if (request.type === 'stderr') process.stderr.write('CONTROLLED_STDERR\\n');
  await emit({ type: 'response', id: request.id, command: request.type, success: true, data: { acknowledged: true } });
}
`

for (const mode of ["normal", "stream", "frame"] as const) {
  test(`real RpcClient subprocess ${mode}: bounded large chunks, one error, stdin/response and stdout continue`, { timeout: 20000 }, async t => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-rpc-stream-process-"))
    const bin = path.join(root, "controlled-wire.mjs")
    writeFileSync(bin, childSource)
    // Resolve the script interpreter explicitly even on a Windows host whose
    // PATH contains npm wrappers or multiple Node installs.
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` }
    mkdirSync(path.join(root, "home"))
    env.HOME = path.join(root, "home")
    env.USERPROFILE = env.HOME
    const client = new OmpRpcClient({ cwd: root, bin, env })
    t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }) })
    const frames: OmpRpcFrame[] = []
    const errors: Array<{ message: string; originalType?: string; kind?: string }> = []
    client.on("frame", frame => frames.push(frame))
    client.on("protocolError", (message, originalType, kind) => errors.push({ message, originalType, kind }))
    await client.waitForReady(5000)
    client.setOutputPaused(true)
    const exercise = client.request({ type: "exercise", mode }, 5000)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(frames.filter(frame => frame.type === "notice").length, 0)
    client.setOutputPaused(false)
    assert.equal((await exercise).success, true)
    assert.ok(frames.some(frame => frame.text === "native-process-continued"))
    const notices = frames.filter(frame => frame.type === "notice")
    if (mode === "normal") {
      assert.equal(errors.length, 0)
      assert.equal(notices.length, 2)
      assert.equal(notices[0]!.text, "正文😀" + "x".repeat(1152 * 1024))
    } else {
      assert.equal(notices.length, 1, "corrupted large frame must not be dispatched")
      assert.equal(errors.length, 1)
      assert.equal(errors[0]!.originalType, "rpc_chunk")
      assert.equal(errors[0]!.kind, mode)
      assert.match(errors[0]!.message, mode === "stream" ? /length mismatch: got \d+ expected \d+/ : /not valid UTF-8 or JSON/)
    }
    assert.deepEqual((await client.request({ type: "after_corruption" }, 5000)).data, { acknowledged: true })
    const stderr = once(client.proc.stderr!, "data")
    await client.request({ type: "stderr" }, 5000)
    await stderr
    assert.match(client.stderrTail, /CONTROLLED_STDERR/)
    assert.equal(client.hasExited, false)
    await client.close()
    assert.equal(client.hasExited, true)
    assert.equal(client.exitInfo.code, 0)
    assert.equal(errors.length, mode === "normal" ? 0 : 1)
  })
}
