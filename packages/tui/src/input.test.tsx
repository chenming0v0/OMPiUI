import assert from "node:assert/strict";
import { useState } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { test } from "node:test";
import stringWidth from "string-width";
import { LineInput, inputWindow } from "./input.tsx";
import { ActionForm } from "./form.tsx";

const pause = () => new Promise((resolve) => setTimeout(resolve, 60));

test("single-line input scrolls to the cursor without splitting Chinese graphemes", () => {
  const value = "https://desktop-home.relay.example.com:9443/中文路径/new-tail";
  const cursor = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
  ).length;
  const window = inputWindow(value, cursor, 26);
  assert.match(window.before, /new-tail$/);
  assert.ok(stringWidth(window.before + window.cursor + window.after) <= 26);
  const masked = inputWindow(value, cursor, 26, true);
  assert.doesNotMatch(masked.before, /https|new-tail|中文/);
});

test("long address edits keep the new suffix and cursor visible in a 48-column form", async (t) => {
  let submitted: Record<string, string> = {};
  const screen = render(
    <Box width={48}>
      <ActionForm
        action={{
          id: "configure",
          label: "编辑配置",
          fields: [
            {
              key: "url",
              label: "中转地址",
              value: "https://desktop-home.relay.example.com:9443/my-long-path",
            },
          ],
        }}
        height={12}
        onCancel={() => {}}
        onSubmit={(values) => {
          submitted = values;
        }}
      />
    </Box>,
  );
  t.after(() => screen.unmount());
  await pause();
  screen.stdin.write("/new-tail");
  await pause();
  assert.match(screen.lastFrame()!, /new-tail/);
  screen.stdin.write("\r");
  await pause();
  assert.match(submitted.url!, /my-long-path\/new-tail$/);
});

test("cursor movement and backspace edit the intended position", async (t) => {
  let seen = "";
  function Input() {
    const [value, setValue] = useState("abcd");
    return (
      <Box width={12}>
        <LineInput
          value={value}
          active
          onSubmit={() => {}}
          onChange={(next) => {
            seen = next;
            setValue(next);
          }}
        />
      </Box>
    );
  }
  const screen = render(<Input />);
  t.after(() => screen.unmount());
  await pause();
  screen.stdin.write("\u001b[D");
  await pause();
  screen.stdin.write("X");
  await pause();
  assert.equal(seen, "abcXd");
  screen.stdin.write("\u007f");
  await pause();
  assert.equal(seen, "abcd");
  screen.stdin.write("\u0001");
  await pause();
  screen.stdin.write("Z");
  await pause();
  assert.equal(seen, "Zabcd");
});

test("a compact six-row form keeps its active input and save action visible", async (t) => {
  const screen = render(
    <Box width={42}>
      <ActionForm
        action={{
          id: "config",
          label: "编辑配置",
          fields: [
            { key: "host", label: "监听地址", value: "127.0.0.1" },
            { key: "port", label: "监听端口", value: "8787" },
          ],
        }}
        height={6}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    </Box>,
  );
  t.after(() => screen.unmount());
  await pause();
  assert.match(screen.lastFrame()!, /127\.0\.0\.1/);
  assert.match(screen.lastFrame()!, /Ctrl\+S/);
  screen.stdin.write("\t");
  await pause();
  assert.match(screen.lastFrame()!, /8787/);
});
