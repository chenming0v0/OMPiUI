import { useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useInput } from "ink";
import type { DOMElement } from "ink";
import stringWidth from "string-width";
import { theme } from "./theme.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const split = (value: string): string[] =>
  Array.from(segmenter.segment(value), (item) => item.segment);

export function inputWindow(
  value: string,
  cursor: number,
  width: number,
  secret = false,
) {
  const parts = split(value);
  const shown = secret ? parts.map(() => "*") : parts;
  const position = Math.min(cursor, parts.length);
  const budget = Math.max(1, width);
  const cursorWidth = stringWidth(shown[position] ?? " ");
  let start = position;
  let beforeWidth = 0;
  while (
    start > 0 &&
    beforeWidth + stringWidth(shown[start - 1]!) <= budget - cursorWidth
  ) {
    start--;
    beforeWidth += stringWidth(shown[start]!);
  }
  let end = position;
  let used = beforeWidth;
  while (end < shown.length && used + stringWidth(shown[end]!) <= budget) {
    used += stringWidth(shown[end]!);
    end++;
  }
  return {
    before: shown.slice(start, position).join(""),
    cursor: shown[position] ?? " ",
    after: shown.slice(position + 1, end).join(""),
  };
}

export function LineInput({
  value,
  active,
  secret,
  placeholder,
  onChange,
  onSubmit,
}: {
  value: string;
  active: boolean;
  secret?: boolean;
  placeholder?: string;
  onChange(value: string): void;
  onSubmit(): void;
}) {
  const ref = useRef<DOMElement>(null);
  const [width, setWidth] = useState(20);
  const [cursor, setCursor] = useState(() => split(value).length);
  const parts = split(value);
  const position = Math.min(cursor, parts.length);

  useEffect(() => {
    if (ref.current) setWidth(Math.max(1, measureElement(ref.current).width));
  });

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit();
        return;
      }
      if (key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (key.leftArrow) {
        setCursor(Math.max(0, position - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(parts.length, position + 1));
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(parts.length);
        return;
      }
      if (key.ctrl && input === "u") {
        onChange(parts.slice(position).join(""));
        setCursor(0);
        return;
      }
      if (key.backspace || key.delete) {
        if (position > 0) {
          onChange(
            [...parts.slice(0, position - 1), ...parts.slice(position)].join(
              "",
            ),
          );
          setCursor(position - 1);
        }
        return;
      }
      if (key.ctrl && input === "d") {
        onChange(
          [...parts.slice(0, position), ...parts.slice(position + 1)].join(""),
        );
        return;
      }
      if (key.ctrl || key.meta || !input) return;
      const added = split(
        input.replace(/[\r\n\t]/g, " ").replace(/[\u0000-\u001f\u007f]/g, ""),
      );
      onChange(
        [...parts.slice(0, position), ...added, ...parts.slice(position)].join(
          "",
        ),
      );
      setCursor(position + added.length);
    },
    { isActive: active },
  );

  const window = inputWindow(value, position, width, secret);
  return (
    <Box ref={ref} width="100%" height={1} overflow="hidden">
      {!active ? (
        <Text color={theme.text} wrap="truncate">
          {secret ? "*".repeat(parts.length) : value || placeholder || " "}
        </Text>
      ) : (
        <Text color={theme.text} wrap="truncate">
          {window.before}
          <Text inverse>{window.cursor}</Text>
          {window.after}
          {!value && placeholder ? (
            <Text color={theme.muted}>{placeholder}</Text>
          ) : (
            ""
          )}
        </Text>
      )}
    </Box>
  );
}
