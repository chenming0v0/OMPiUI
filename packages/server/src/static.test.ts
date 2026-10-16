import assert from "node:assert/strict";
import test from "node:test";
import fs, {
  type ReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { createStaticServer, resolveStaticPath } from "./static.ts";

function withWebRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ompiui-static-"));
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "app-a1b2c3d4.js"), "console.log(1)");
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveStaticPath keeps requests inside the root", () => {
  withWebRoot((root) => {
    assert.equal(
      resolveStaticPath(root, "/assets/app-a1b2c3d4.js"),
      join(root, "assets", "app-a1b2c3d4.js"),
    );
    assert.equal(resolveStaticPath(root, "/%00"), undefined);
    // 各种形式的 .. 最终都不允许逃出 root（塌缩后落在 root 内也算安全）
    for (const attempt of [
      "/../etc/passwd",
      "/%2e%2e/%2e%2e/secret",
      "/..\\..\\secret",
      "/%2e%2e%5csecret",
    ]) {
      const resolved = resolveStaticPath(root, attempt);
      if (resolved !== undefined) {
        assert.ok(
          resolved.startsWith(root),
          `${attempt} escaped the web root: ${resolved}`,
        );
      }
    }
  });
});

test("createStaticServer is undefined without an index.html", () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-static-empty-"));
  try {
    assert.equal(createStaticServer(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown client routes fall back to index.html", async () => {
  await withWebRootAsync((root) =>
    collect((res) =>
      createStaticServer(root)!.serve(
        fakeRequest("GET"),
        res as never,
        "/sessions/abc",
      ),
    ).then((served) => {
      assert.equal(served.status, 200);
      assert.match(served.body, /app/);
      assert.equal(served.headers["cache-control"], "no-cache");
    }),
  );
});

test("fingerprinted assets get immutable caching, missing files return false", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-static-"));
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "app-a1b2c3d4.js"), "console.log(1)");
    const server = createStaticServer(root)!;
    const asset = await collect((res) =>
      server.serve(fakeRequest("GET"), res as never, "/assets/app-a1b2c3d4.js"),
    );
    assert.equal(asset.status, 200);
    assert.match(asset.headers["cache-control"]!, /immutable/);
    assert.match(asset.headers["content-type"]!, /javascript/);
    assert.equal(
      server.serve(fakeRequest("GET"), fakeResponse() as never, "/missing.js"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("static hosting rejects directory links that leave the web root", () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-static-root-"));
  const outside = mkdtempSync(join(tmpdir(), "ompiui-static-outside-"));
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(
      outside,
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const server = createStaticServer(root)!;
    assert.equal(
      server.serve(
        fakeRequest("GET"),
        fakeResponse() as never,
        "/linked/secret.txt",
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

async function withWebRootAsync(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ompiui-static-"));
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "app-a1b2c3d4.js"), "console.log(1)");
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeRequest(method: string) {
  return { method, headers: {} } as never;
}

test("range responses preserve multipart, suffix, HEAD, and cache metadata", async () => {
  await withWebRootAsync(async root => {
    const server = createStaticServer(root)!;
    const multi = await collect(res => server.serve(
      { method: "GET", headers: { range: "bytes=0-2,5-7" } } as never,
      res as never, "/assets/app-a1b2c3d4.js",
    ));
    assert.equal(multi.status, 206);
    assert.match(multi.headers["content-type"] ?? "", /multipart\/byteranges/);
    assert.match(multi.body, /con/);
    assert.equal(Number(multi.headers["content-length"]), Buffer.byteLength(multi.body));
    const single = await collect(res => server.serve(
      { method: "GET", headers: { range: "bytes=0-2" } } as never,
      res as never, "/assets/app-a1b2c3d4.js",
    ));
    assert.equal(single.status, 206);
    assert.equal(single.body, "con");
    assert.equal(Number(single.headers["content-length"]), 3);
    const suffix = await collect(res => server.serve(
      { method: "GET", headers: { range: "bytes=0-2,-3" } } as never,
      res as never, "/assets/app-a1b2c3d4.js",
    ));
    assert.equal(suffix.status, 206);
    assert.match(suffix.body, /Content-Range: bytes 11-13\/14\r\n\r\n\(1\)/);
    assert.equal(Number(suffix.headers["content-length"]), Buffer.byteLength(suffix.body));
    const head = await collect(res => server.serve(
      { method: "HEAD", headers: { range: "bytes=0-2,5-7" } } as never,
      res as never, "/assets/app-a1b2c3d4.js",
    ));
    const boundary = head.headers["content-type"]!.split("boundary=")[1]!;
    const expected = ["0-2", "5-7"].map(range =>
      `--${boundary}\r\nContent-Type: text/javascript; charset=utf-8\r\nContent-Range: bytes ${range}/14\r\n\r\nxxx\r\n`,
    ).join("") + `--${boundary}--\r\n`;
    assert.equal(head.status, 206);
    assert.equal(head.body, "");
    assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(expected));
    const cached = await collect(res => server.serve(
      { method: "GET", headers: { "if-none-match": multi.headers.etag } } as never,
      res as never, "/assets/app-a1b2c3d4.js",
    ));
    assert.equal(cached.status, 304);
    assert.equal(cached.body, "");
    const excessive = await collect(res => server.serve(
      { method: "GET", headers: { range: `bytes=${Array(17).fill("0-0").join(",")}` } } as never,
      res as never, "/assets/app-a1b2c3d4.js",
    ));
    assert.equal(excessive.status, 416);
    assert.equal(excessive.headers["content-range"], "bytes */14");
  });
});

test("redundant ranges transfer each byte once and ignore unsatisfiable members", async () => {
  await withWebRootAsync(async root => {
    const server = createStaticServer(root)!
    const read = (range: string) => collect(res => server.serve(
      { method: "GET", headers: { range } } as never, res as never, "/assets/app-a1b2c3d4.js",
    ))
    const repeated = await read(`bytes=${Array(16).fill("0-").join(",")}`)
    assert.equal(repeated.status, 206)
    assert.equal(repeated.body.match(/Content-Range:/g)?.length, 1)
    assert.equal(repeated.body.match(/console.log\(1\)/g)?.length, 1)
    const overlaps = await read("bytes=0-5,3-8,7-10")
    assert.equal(overlaps.body.match(/Content-Range:/g)?.length, 1)
    assert.match(overlaps.body, /Content-Range: bytes 0-10\/14/)
    const partial = await read("bytes=99999-,0-0")
    assert.equal(partial.status, 206)
    assert.match(partial.body, /Content-Range: bytes 0-0\/14/)
    assert.equal((await read("other=0-1,2-3")).status, 416)
  })
})

test("multipart ranges survive repeated backpressure and close their file sources on disconnect", { timeout: 10_000 }, async t => {
  await withWebRootAsync(async root => {
    const bytes = Buffer.alloc(512 * 1024, "x");
    writeFileSync(join(root, "large.bin"), bytes);
    const server = createStaticServer(root)!;
    const sources: ReadStream[] = [];
    const responses: SlowResponse[] = [];
    const original = fs.createReadStream;
    const spy = t.mock.method(fs, "createReadStream", (...args: Parameters<typeof original>) => {
      const source = original(...args);
      sources.push(source);
      return source;
    });
    syncBuiltinESMExports();
    try {
      const res = new SlowResponse();
      responses.push(res);
      const done = finished(res, { signal: AbortSignal.timeout(5000) });
      server.serve(
        { method: "GET", headers: { range: "bytes=0-262143,300000-365535" } } as never,
        res as never, "/large.bin",
      );
      await done;
      const body = Buffer.concat(res.chunks);
      const boundary = String(res.headers["content-type"]).split("boundary=")[1]!;
      assert.deepEqual(body, Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-262143/524288\r\n\r\n`),
        bytes.subarray(0, 262144),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 300000-365535/524288\r\n\r\n`),
        bytes.subarray(300000, 365536),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]));
      assert.equal(res.status, 206);
      assert.equal(Number(res.headers["content-length"]), body.length);
      assert.ok(res.drains >= 3);

      for (const part of [0, 1, 2]) {
        const before = sources.length;
        const interrupted: SlowResponse = new SlowResponse(chunk => {
          if (sources.length === before + part + 1 && chunk.length >= 1024) interrupted.destroy();
        });
        responses.push(interrupted);
        const closed = finished(interrupted, { signal: AbortSignal.timeout(5000) });
        server.serve(
          { method: "GET", headers: { range: "bytes=0-262143,262144-458751,500000-524287" } } as never,
          interrupted as never, "/large.bin",
        );
        await assert.rejects(closed, { code: "ERR_STREAM_PREMATURE_CLOSE" });
        await Promise.all(sources.slice(before).map(source => finished(source).catch(() => {})));
        assert.equal(sources.length, before + part + 1);
        for (const source of sources.slice(before)) {
          assert.equal(source.destroyed, true);
          assert.equal(source.closed, true);
        }
      }
    } finally {
      for (const res of responses) res.destroy();
      for (const source of sources) source.destroy();
      await Promise.all(sources.map(source => finished(source).catch(() => {})));
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

class SlowResponse extends Writable {
  status = 0;
  headers: Record<string, string | number> = {};
  readonly chunks: Buffer[] = [];
  drains = 0;

  constructor(private readonly onChunk?: (chunk: Buffer) => void) {
    super({ highWaterMark: 1024 });
    this.on("drain", () => this.drains++);
  }

  writeHead(status: number, headers: Record<string, string | number>) {
    this.status = status;
    this.headers = headers;
    return this;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk);
    this.onChunk?.(chunk);
    setImmediate(callback);
  }
}

function fakeResponse() {
  const stream = new PassThrough();
  const res = stream as PassThrough & {
    status: number;
    headers: Record<string, string>;
    body: string;
    writeHead: (status: number, headers: Record<string, string>) => unknown;
  };
  res.status = 0;
  res.headers = {};
  res.body = "";
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
    return res;
  };
  stream.on("data", (chunk) => {
    res.body += chunk.toString("utf8");
  });
  return res;
}

async function collect(
  serve: (res: ReturnType<typeof fakeResponse>) => boolean,
) {
  const res = fakeResponse();
  const done = new Promise<void>((resolve) => res.on("end", resolve));
  const handled = serve(res);
  if (handled) await done;
  return res;
}
