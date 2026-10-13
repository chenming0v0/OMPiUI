import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { subagentBlockHash, subagentDigest } from "./subagent-sync.js";
import { PI_COMMAND_SPECS } from "./pi-command-specs.js";
import { validateParams } from "./validate-params.js";
import { problemFromError } from "./problem.js";

test("canonical hashes survive JSON transport and agree with standard SHA-256", () => {
  assert.equal(
    subagentDigest("中文"),
    `sha256:${createHash("sha256").update(JSON.stringify("中文")).digest("hex")}`,
  );
  const body = {
    fromByte: 0,
    nextByte: 100,
    previewTruncated: false,
    messages: [{ role: "assistant", content: "中文", unused: undefined }],
  };
  assert.equal(
    subagentBlockHash("preview", body),
    subagentBlockHash("preview", JSON.parse(JSON.stringify(body))),
  );
  assert.equal(subagentDigest({ b: 2, a: 1 }), subagentDigest({ a: 1, b: 2 }));
});

test("both runtime and disk-only command schemas accept bounded conditional sync", () => {
  const params = {
    sessionFile: "/native/child.jsonl",
    fromByte: 0,
    sync: {
      version: 1,
      knownBlocks: [
        { fromByte: 0, nextByte: 100, hash: subagentDigest("test") },
      ],
    },
  };
  const runtime = PI_COMMAND_SPECS.find(
    (spec) => spec.name === "subagent.messages",
  )!;
  const disk = PI_COMMAND_SPECS.find((spec) => spec.name === "session.read")!;
  validateParams(runtime.paramsSchema, params);
  validateParams(disk.paramsSchema, {
    sessionId: "parent",
    query: "subagent.messages",
    params,
  });
  assert.throws(
    () =>
      validateParams(runtime.paramsSchema, {
        ...params,
        sync: {
          ...params.sync,
          knownBlocks: Array(33).fill(params.sync.knownBlocks[0]),
        },
      }),
    { code: "INVALID_REQUEST" },
  );
});

test("snapshot expiration survives worker and HTTP problem serialization", () => {
  const error = Object.assign(new Error("changed"), {
    code: "SYNC_SNAPSHOT_EXPIRED",
  });
  const serialized = JSON.parse(JSON.stringify(problemFromError(error)));
  assert.equal(
    problemFromError(Object.assign(new Error(serialized.message), serialized))
      .code,
    error.code,
  );
});
