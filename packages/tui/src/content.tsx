import { Box, Text } from "ink";
import { safeText } from "./logs.ts";
import { theme, toneColor } from "./theme.ts";
import type {
  ConsoleData,
  ConsoleLog,
  ConsoleRow,
  ConsoleView,
} from "./types.ts";

export function rowCapacity(height: number, spacious: boolean): number {
  return Math.max(1, Math.floor((height - 5) / (spacious ? 2 : 1)));
}

function Rule({ width }: { width: number }) {
  return <Text color={theme.border}>{"─".repeat(Math.max(1, width))}</Text>;
}

export function RowList({
  rows,
  target,
  revealed,
  capacity,
  offset,
  spacious,
  width,
}: {
  rows: ConsoleRow[];
  target?: string;
  revealed: boolean;
  capacity: number;
  offset: number;
  spacious: boolean;
  width: number;
}) {
  const labelWidth = width >= 70 ? 20 : Math.max(10, Math.floor(width / 3));
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      {rows.slice(offset, offset + capacity).map((row) => (
        <Box key={row.id} marginBottom={spacious ? 1 : 0} height={1}>
          <Box width={2} flexShrink={0}>
            <Text color={theme.accent}>{row.id === target ? "▎" : " "}</Text>
          </Box>
          <Box width={labelWidth} flexShrink={0}>
            <Text
              color={row.id === target ? theme.text : theme.muted}
              wrap="truncate"
            >
              {safeText(row.label)}
            </Text>
          </Box>
          <Box
            flexGrow={1}
            backgroundColor={row.id === target ? theme.selected : undefined}
          >
            <Text
              color={toneColor(row.tone)}
              bold={row.id === target}
              wrap="truncate"
            >
              {row.secret && !revealed
                ? "********"
                : safeText(row.value || "-")}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function EventFeed({
  logs,
  width,
  height,
  title = "近期动态",
}: {
  logs: ConsoleLog[];
  width: number;
  height: number;
  title?: string;
}) {
  const count = Math.max(1, Math.floor((height - 3) / 3));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box justifyContent="space-between">
        <Text color={theme.text} bold>
          {title}
        </Text>
        <Text color={theme.muted}>{logs.length} 条</Text>
      </Box>
      <Box marginBottom={1}>
        <Rule width={width} />
      </Box>
      {logs.slice(-count).map((log, index) => (
        <Box
          key={`${log.time}-${index}`}
          flexDirection="column"
          marginBottom={1}
        >
          <Text color={theme.muted}>
            {new Date(log.time).toLocaleTimeString("zh-CN", { hour12: false })}
            <Text color={toneColor(log.tone)}>
              {" "}
              {log.tone === "danger"
                ? "ERROR"
                : log.tone === "warning"
                  ? "NOTICE"
                  : "EVENT"}
            </Text>
          </Text>
          <Text color={toneColor(log.tone)} wrap="truncate">
            {safeText(log.text)}
          </Text>
        </Box>
      ))}
      {!logs.length && <Text color={theme.muted}>暂无运行记录</Text>}
    </Box>
  );
}

export function ConsoleContent({
  data,
  view,
  selected,
  revealed,
  width,
  height,
}: {
  data: ConsoleData | null;
  view?: ConsoleView;
  selected: number;
  revealed: boolean;
  width: number;
  height: number;
}) {
  const spacious = height >= 18;
  const capacity = rowCapacity(height, spacious);
  const target = view?.rows[selected]?.id;
  const offset = Math.max(0, selected - capacity + 1);
  const rightFeed = view?.id === "overview" && width >= 98 && height >= 16;
  const mainWidth = rightFeed ? Math.floor(width * 0.58) : width;

  if (view?.id === "logs") {
    const count = Math.max(1, height - 4);
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        overflow="hidden"
      >
        <Box height={2} justifyContent="space-between">
          <Text color={theme.text} bold>
            运行日志
          </Text>
          <Text color={theme.muted}>{data?.logs.length ?? 0} 条 / LIVE</Text>
        </Box>
        <Box marginBottom={1}>
          <Rule width={width} />
        </Box>
        {(data?.logs ?? [])
          .slice(
            Math.max(0, (data?.logs.length ?? 0) - count - selected),
            (data?.logs.length ?? 0) - selected,
          )
          .map((log, index) => (
            <Text
              key={`${log.time}-${index}`}
              color={toneColor(log.tone)}
              wrap="truncate"
            >
              <Text color={theme.muted}>
                {new Date(log.time).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}{" "}
              </Text>
              <Text color={toneColor(log.tone)}>│ </Text>
              {safeText(log.text)}
            </Text>
          ))}
        {!data?.logs.length && <Text color={theme.muted}>暂无日志</Text>}
      </Box>
    );
  }
  return (
    <Box width={width} height={height} columnGap={4} overflow="hidden">
      <Box
        flexDirection="column"
        width={mainWidth}
        flexShrink={0}
        overflow="hidden"
      >
        <Box height={2} justifyContent="space-between">
          <Text color={theme.text} bold>
            {view?.label ?? "连接中"}
          </Text>
          <Text color={theme.muted}>
            {view?.id === "overview"
              ? data?.name === "Relay"
                ? "RELAY / LIVE"
                : "SERVER / LIVE"
              : `${String(selected + 1).padStart(2, "0")} / ${view?.rows.length ?? 0}`}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Rule width={mainWidth} />
        </Box>
        <RowList
          rows={view?.rows ?? []}
          target={target}
          revealed={revealed}
          capacity={capacity}
          offset={offset}
          spacious={spacious}
          width={mainWidth}
        />
        {!view?.rows.length && (
          <Text color={theme.muted}>{view?.empty ?? "暂无数据"}</Text>
        )}
        {view?.rows[selected]?.detail && (
          <Box marginTop={1}>
            <Text color={theme.muted} wrap="truncate">
              {safeText(view.rows[selected]!.detail!)}
            </Text>
          </Box>
        )}
      </Box>
      {rightFeed && (
        <EventFeed
          logs={data?.logs ?? []}
          width={width - mainWidth - 4}
          height={height}
        />
      )}
    </Box>
  );
}
