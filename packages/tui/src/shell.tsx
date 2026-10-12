import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ConsoleState } from "./controller.ts";
import type { ConsoleView } from "./types.ts";
import { Wordmark } from "./brand.tsx";
import { safeText } from "./logs.ts";
import { theme, toneColor } from "./theme.ts";

export function shellLayout(columns: number, rows: number) {
  const tall = rows >= 24;
  const branded = tall && columns >= 80;
  const header = branded ? 5 : 3;
  const footer = tall ? 3 : 2;
  const height = rows - 1;
  return {
    branded,
    tall,
    height,
    header,
    footer,
    content: height - header - footer - 4,
  };
}

export function ConsoleShell({
  state,
  columns,
  rows,
  viewIndex,
  dialog,
  children,
}: {
  state: ConsoleState;
  columns: number;
  rows: number;
  viewIndex: number;
  dialog: boolean;
  children: ReactNode;
}) {
  const { data } = state;
  const layout = shellLayout(columns, rows);
  const view: ConsoleView | undefined = data?.views[viewIndex];
  const targetActions = view?.rows.length;
  const actions = (view?.actions ?? []).filter(
    (action) =>
      action.key && !action.disabled && (!action.target || targetActions),
  );
  const maxActions = !layout.tall
    ? columns >= 80
      ? 2
      : 0
    : columns >= 100
      ? 4
      : columns >= 72
        ? 3
        : 1;
  const narrowNavigation = columns < 80;
  return (
    <Box
      flexDirection="column"
      width={columns}
      height={layout.height}
      backgroundColor={theme.background}
      overflow="hidden"
    >
      <Box
        height={layout.header}
        flexShrink={0}
        paddingX={3}
        alignItems="center"
        justifyContent="space-between"
      >
        <Box alignItems="center" gap={3}>
          {layout.branded && <Wordmark />}
          <Box flexDirection="column">
            <Text color={theme.text} bold>
              {layout.branded
                ? `${data?.name ?? "Console"} / Control`
                : `OMPiUI / ${data?.name ?? "Console"}`}
            </Text>
            {layout.branded && (
              <Text color={theme.muted}>
                OMPiUI <Text color={theme.border}>/</Text>{" "}
                {data?.subtitle === "ATTACHED"
                  ? "已接入管理器"
                  : data?.name === "Relay"
                    ? "自建中转"
                    : "本机后端"}
              </Text>
            )}
          </Box>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color={toneColor(data?.tone)}>
            {state.busy ? "◌ 正在处理" : `● ${data?.status ?? "连接中"}`}
          </Text>
          {layout.branded && (
            <Text color={theme.muted}>{data?.subtitle ?? ""}</Text>
          )}
        </Box>
      </Box>
      <Box height={2} flexShrink={0} paddingX={3} gap={3} overflow="hidden">
        {narrowNavigation ? (
          <Text color={theme.text} bold>
            <Text color={theme.accent}>
              {String(viewIndex + 1).padStart(2, "0")}
            </Text>{" "}
            {view?.label ?? ""}{" "}
            <Text color={theme.muted}>/ {data?.views.length ?? 1}</Text>
          </Text>
        ) : (
          data?.views.map((item, index) => (
            <Text
              key={item.id}
              color={index === viewIndex ? theme.text : theme.muted}
              bold={index === viewIndex}
            >
              <Text color={index === viewIndex ? theme.accent : theme.border}>
                {String(index + 1).padStart(2, "0")}{" "}
              </Text>
              <Text underline={index === viewIndex}>{item.label}</Text>
            </Text>
          ))
        )}
      </Box>
      <Box
        height={layout.content}
        flexShrink={0}
        paddingX={3}
        overflow="hidden"
      >
        {children}
      </Box>
      <Box height={1} flexShrink={0} paddingX={3} overflow="hidden">
        <Text
          color={
            state.error
              ? theme.danger
              : state.busy
                ? theme.warning
                : state.notice
                  ? theme.success
                  : theme.muted
          }
          wrap="truncate"
        >
          {safeText(
            state.error ?? state.busy ?? state.notice ?? data?.endpoint ?? "",
          )}
        </Text>
      </Box>
      <Box
        height={layout.footer}
        flexShrink={0}
        marginX={3}
        marginBottom={1}
        backgroundColor={theme.surface}
        overflow="hidden"
      >
        <Box width={1} flexShrink={0}>
          <Text color={dialog ? theme.warning : theme.accent}>
            {"┃\n".repeat(layout.footer)}
          </Text>
        </Box>
        <Box
          flexDirection="column"
          paddingX={2}
          flexGrow={1}
          justifyContent="center"
          overflow="hidden"
        >
          <Box
            gap={3}
            overflow="hidden"
            justifyContent={!layout.tall ? "space-between" : undefined}
          >
            {dialog ? (
              <Text color={theme.muted}>
                Esc <Text color={theme.text}>返回</Text>
              </Text>
            ) : (
              actions.slice(0, maxActions).map((action) => (
                <Text key={action.id} color={theme.text}>
                  <Text
                    color={toneColor(
                      action.tone === "neutral" || !action.tone
                        ? "accent"
                        : action.tone,
                    )}
                  >
                    {action.key}
                  </Text>{" "}
                  {action.label}
                </Text>
              ))
            )}
            {!dialog && !layout.tall && (
              <Text color={theme.muted}>Tab 分页 / 命令 q 退出</Text>
            )}
          </Box>
          {layout.tall && (
            <Box justifyContent="space-between">
              <Text color={theme.muted}>
                {dialog
                  ? "CONTROL / INPUT"
                  : `${view?.label ?? ""} / ${data?.name ?? "Console"}`}
              </Text>
              <Text color={theme.muted}>
                {dialog
                  ? ""
                  : columns >= 80
                    ? "Tab 分页   i 详情   / 命令   q 退出"
                    : "/ 命令   q 退出"}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
