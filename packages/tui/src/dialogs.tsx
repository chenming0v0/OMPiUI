import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { safeText } from "./logs.ts";
import { theme, toneColor } from "./theme.ts";
import type { ConsoleAction, ConsoleRow } from "./types.ts";

export function ConfirmDialog({
  label,
  message,
  selected,
  width,
  height,
}: {
  label: string;
  message: string;
  selected: number;
  width: number;
  height: number;
}) {
  return (
    <Box
      flexGrow={1}
      width={width}
      height={height}
      justifyContent="center"
      alignItems="center"
    >
      <Box
        flexDirection="column"
        width={Math.min(68, width)}
        borderStyle="single"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        backgroundColor={theme.surface}
      >
        <Text bold color={theme.warning}>
          {label}
        </Text>
        <Box marginY={1}>
          <Text color={theme.text}>{message}</Text>
        </Box>
        <Box gap={4} marginTop={1}>
          <Text
            color={selected === 0 ? theme.text : theme.muted}
            inverse={selected === 0}
          >
            {" "}
            取消{" "}
          </Text>
          <Text color={theme.danger} inverse={selected === 1}>
            {" "}
            确认{" "}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export function InspectDialog({
  row,
  revealed,
  width,
  height,
}: {
  row?: ConsoleRow;
  revealed: boolean;
  width: number;
  height: number;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      paddingY={1}
    >
      <Text color={theme.accent} bold>
        {row?.label}
      </Text>
      <Box marginY={1}>
        <Text color={theme.text}>
          {row?.secret && !revealed ? "********" : safeText(row?.value ?? "")}
        </Text>
      </Box>
      {row?.secret && (
        <Text color={theme.muted}>v {revealed ? "隐藏凭证" : "显示凭证"}</Text>
      )}
      {row?.detail && (
        <Box marginTop={1}>
          <Text color={theme.muted}>{safeText(row.detail)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function CommandPalette({
  commands,
  selected,
  query,
  onQuery,
  width,
  height,
}: {
  commands: ConsoleAction[];
  selected: number;
  query: string;
  onQuery(value: string): void;
  width: number;
  height: number;
}) {
  const count = Math.max(1, height - 6);
  const offset = Math.max(0, selected - count + 1);
  return (
    <Box
      width={width}
      height={height}
      justifyContent="center"
      overflow="hidden"
    >
      <Box
        flexDirection="column"
        width={Math.min(76, width)}
        backgroundColor={theme.surface}
        paddingX={2}
        paddingY={1}
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text color={theme.text} bold>
            命令面板
          </Text>
          <Text color={theme.muted}>{commands.length} 个操作</Text>
        </Box>
        <Box marginY={1} backgroundColor={theme.selected} paddingX={1}>
          <Text color={theme.accent}>{"› "}</Text>
          <TextInput value={query} onChange={onQuery} />
        </Box>
        {commands.slice(offset, offset + count).map((action) => (
          <Box
            key={action.id}
            backgroundColor={
              commands[selected]?.id === action.id ? theme.selected : undefined
            }
            paddingX={1}
            justifyContent="space-between"
          >
            <Text color={toneColor(action.tone)}>
              <Text color={theme.accent}>
                {commands[selected]?.id === action.id ? "› " : "  "}
              </Text>
              {action.label}
            </Text>
            <Text color={theme.muted}>{action.key ?? ""}</Text>
          </Box>
        ))}
        {!commands.length && <Text color={theme.muted}>没有匹配的命令</Text>}
      </Box>
    </Box>
  );
}
