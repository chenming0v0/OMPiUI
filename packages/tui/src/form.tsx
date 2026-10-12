import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { LineInput } from "./input.tsx";
import { theme } from "./theme.ts";
import type { ConsoleAction } from "./types.ts";

export function ActionForm({
  action,
  height,
  width,
  disabled,
  onCancel,
  onSubmit,
}: {
  action: ConsoleAction;
  height: number;
  width?: number;
  disabled?: boolean;
  onCancel(): void;
  onSubmit(values: Record<string, string>): void;
}) {
  const fields = action.fields ?? [];
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((field) => [field.key, field.value ?? ""])),
  );
  const [error, setError] = useState("");
  const compact = height < 12;
  const visible = Math.max(1, Math.floor((height - (compact ? 3 : 6)) / 3));
  const offset = Math.max(0, index - visible + 1);

  function submit() {
    if (disabled) return;
    const missing = fields.findIndex(
      (field) => !field.optional && !values[field.key]?.trim(),
    );
    if (missing >= 0) {
      setIndex(missing);
      setError(`${fields[missing]!.label}不能为空`);
      return;
    }
    onSubmit(values);
  }

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
        return;
      }
      if (key.upArrow || (key.tab && key.shift))
        setIndex((value) => (value + fields.length - 1) % fields.length);
      else if (key.downArrow || key.tab)
        setIndex((value) => (value + 1) % fields.length);
      else if (key.ctrl && input === "s") submit();
    },
    { isActive: !disabled },
  );

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={compact ? 0 : 1}
      height={height}
      width={width ?? "100%"}
      backgroundColor={theme.surface}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          {action.label}
        </Text>
        {compact && (
          <Text color={theme.muted}>
            {index + 1} / {fields.length}
          </Text>
        )}
      </Box>
      <Box marginBottom={1}>
        {!compact && (
          <Text color={theme.muted}>
            {index + 1} / {fields.length}
          </Text>
        )}
      </Box>
      {fields.slice(offset, offset + visible).map((field, local) => (
        <Box key={field.key} flexDirection="column" marginBottom={1}>
          <Text color={offset + local === index ? theme.accent : theme.muted}>
            {field.label}
            {field.optional ? "" : " *"}
          </Text>
          <Box
            backgroundColor={
              offset + local === index ? theme.selected : theme.surface
            }
            paddingX={1}
            height={1}
            overflow="hidden"
          >
            <LineInput
              value={values[field.key] ?? ""}
              active={!disabled && offset + local === index}
              secret={field.secret}
              placeholder={
                field.secret && field.optional ? "留空保留原密钥" : " "
              }
              onChange={(value) => {
                setValues((previous) => ({ ...previous, [field.key]: value }));
                setError("");
              }}
              onSubmit={() =>
                index === fields.length - 1 ? submit() : setIndex(index + 1)
              }
            />
          </Box>
        </Box>
      ))}
      <Box marginTop={compact ? 0 : 1}>
        <Text color={error ? theme.danger : theme.muted}>
          {error || "保存 Ctrl+S    取消 Esc"}
        </Text>
      </Box>
    </Box>
  );
}
