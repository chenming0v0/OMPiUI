import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "@ompiui/protocol";
import { MainMessageStream } from "./main-message-stream.js";

test("new tool calls with empty arguments keep their content indexes", () => {
  const events: JsonObject[] = [];
  const stream = new MainMessageStream((event) => events.push(event));
  stream.push({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Checking status" },
        { type: "toolCall", id: "status", name: "status", arguments: {} },
        { type: "text", text: "Next" },
      ],
    },
  });
  assert.deepEqual(events.map(event => event.index), [0, 1, 2]);
  assert.deepEqual(events[1]?.block, {
    type: "toolCall", id: "status", name: "status", arguments: {},
  });
  assert.equal(events[1]?.blockCount, 3);
  assert.equal(events.at(-1)?.complete, true);
});

test("clearing tool arguments emits an empty replacement without repeating it", () => {
  const events: JsonObject[] = [];
  const stream = new MainMessageStream((event) => events.push(event));
  const message = (args: JsonObject) => ({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "toolCall", id: "status", name: "status", arguments: args }] },
  });
  stream.push(message({ path: "src" }));
  events.length = 0;
  stream.push(message({}));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.block, {
    type: "toolCall", id: "status", name: "status", arguments: {},
  });
  assert.equal(events[0]?.complete, true);
  events.length = 0;
  stream.push(message({}));
  assert.equal(events.length, 0);
});
