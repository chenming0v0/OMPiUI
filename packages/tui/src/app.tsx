import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ConsoleController } from "./controller.ts";
import { ActionForm } from "./form.tsx";
import { ConsoleShell, shellLayout } from "./shell.tsx";
import { ConsoleContent, rowCapacity } from "./content.tsx";
import { CommandPalette, ConfirmDialog, InspectDialog } from "./dialogs.tsx";
import { theme } from "./theme.ts";
import type { ConsoleAction } from "./types.ts";

type Dialog =
  | { kind: "palette" }
  | { kind: "form"; action: ConsoleAction; target?: string }
  | { kind: "confirm"; action?: ConsoleAction; target?: string }
  | { kind: "inspect" };

export function ConsoleApp({
  controller,
  onExit,
  dimensions,
}: {
  controller: ConsoleController;
  onExit(): void;
  dimensions?: { columns: number; rows: number };
}) {
  const { stdout } = useStdout();
  const [size, setSize] = useState(
    dimensions ?? { columns: stdout.columns || 80, rows: stdout.rows || 24 },
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [viewIndex, setViewIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [query, setQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [confirmIndex, setConfirmIndex] = useState(0);
  const data = state.data;
  const view = data?.views[viewIndex] ?? data?.views[0];
  const { content: contentHeight } = shellLayout(size.columns, size.rows);
  const width = Math.max(1, size.columns - 6);
  const visibleRows =
    view?.id === "logs"
      ? Math.max(1, contentHeight - 4)
      : rowCapacity(contentHeight, contentHeight >= 18);
  const target = view?.rows[selected]?.id;
  const commands = (view?.actions ?? []).filter(
    (action) =>
      !action.disabled &&
      (!action.target || target) &&
      action.label.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    if (dimensions) {
      setSize(dimensions);
      return;
    }
    const resize = () =>
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout, dimensions]);
  useEffect(() => {
    setRevealed(false);
    setSelected(0);
  }, [viewIndex]);
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(false), 30_000);
    return () => clearTimeout(timer);
  }, [revealed]);
  useEffect(() => {
    if (view?.id !== "logs")
      setSelected((value) =>
        Math.min(value, Math.max(0, (view?.rows.length ?? 0) - 1)),
      );
  }, [view?.rows.length, view?.id]);

  function openAction(action: ConsoleAction) {
    if (state.busy || action.disabled || (action.target && !target)) return;
    setQuery("");
    if (action.id === "reveal") {
      setRevealed((value) => !value);
      setDialog(null);
      return;
    }
    const fields =
      action.fieldsByTarget && target
        ? action.fieldsByTarget[target]
        : action.fields;
    if (fields) {
      setDialog({ kind: "form", action: { ...action, fields }, target });
      return;
    }
    if (action.confirm) {
      setConfirmIndex(0);
      setDialog({ kind: "confirm", action, target });
      return;
    }
    setDialog(null);
    void controller.run(action.id, action.label, {}, target);
  }

  async function quit() {
    try {
      await controller.shutdown();
      onExit();
    } catch (error) {
      process.stderr.write(`${String(error)}\n`);
      onExit();
    }
  }

  useInput((input, key) => {
    if (dialog?.kind === "form" || state.busy) return;
    if (dialog?.kind === "inspect") {
      if (key.escape || key.return) setDialog(null);
      else if (input === "v") setRevealed((value) => !value);
      return;
    }
    if (dialog?.kind === "confirm") {
      if (key.escape || input === "n") {
        setDialog(null);
        return;
      }
      if (key.leftArrow || key.rightArrow || key.tab)
        setConfirmIndex((value) => 1 - value);
      if (key.return) {
        if (confirmIndex === 0) setDialog(null);
        else if (dialog.action) {
          void controller.run(
            dialog.action.id,
            dialog.action.label,
            {},
            dialog.target,
          );
          setDialog(null);
        } else {
          void quit();
        }
      }
      return;
    }
    if (dialog?.kind === "palette") {
      if (key.escape || (key.ctrl && input === "c")) {
        setDialog(null);
        return;
      }
      if (key.upArrow) setCommandIndex((value) => Math.max(0, value - 1));
      if (key.downArrow)
        setCommandIndex((value) => Math.min(commands.length - 1, value + 1));
      if (key.return && commands[commandIndex])
        openAction(commands[commandIndex]!);
      return;
    }
    if ((key.ctrl && input === "c") || input === "q") {
      if (data?.ownedRunning) {
        setConfirmIndex(0);
        setDialog({ kind: "confirm" });
      } else void quit();
    } else if (key.tab || key.leftArrow || key.rightArrow) {
      setViewIndex(
        (value) =>
          (value +
            (key.leftArrow || key.shift ? -1 : 1) +
            (data?.views.length ?? 1)) %
          (data?.views.length ?? 1),
      );
    } else if (key.upArrow || input === "k") {
      setSelected((value) =>
        view?.id === "logs"
          ? Math.min(
              value + 1,
              Math.max(0, (data?.logs.length ?? 0) - visibleRows),
            )
          : Math.max(0, value - 1),
      );
    } else if (key.downArrow || input === "j") {
      setSelected((value) =>
        view?.id === "logs"
          ? Math.max(0, value - 1)
          : Math.min(Math.max(0, (view?.rows.length ?? 0) - 1), value + 1),
      );
    } else if (input === "i" && target) setDialog({ kind: "inspect" });
    else if (input === "/" || key.return || (key.ctrl && input === "p")) {
      setQuery("");
      setCommandIndex(0);
      setDialog({ kind: "palette" });
    } else if (input === " ") {
      void controller.refresh();
      controller.clearMessage();
    } else {
      const action = view?.actions.find((item) => item.key === input);
      if (action) openAction(action);
    }
  });

  if (size.columns < 48 || size.rows < 16) {
    return (
      <Box flexDirection="column" width={size.columns}>
        <Text color={theme.accent}>OMPiUI / {data?.name ?? "Console"}</Text>
        <Text>终端窗口太小（至少 48 列、16 行）</Text>
        <Text color={theme.muted}>{data?.status ?? "正在读取状态"}</Text>
      </Box>
    );
  }

  return (
    <ConsoleShell
      state={state}
      columns={size.columns}
      rows={size.rows}
      viewIndex={viewIndex}
      dialog={Boolean(dialog)}
    >
      {dialog?.kind === "form" ? (
        <Box width={width} justifyContent="center">
          <ActionForm
            key={dialog.action.id}
            action={dialog.action}
            height={contentHeight}
            width={Math.min(76, width)}
            disabled={Boolean(state.busy)}
            onCancel={() => setDialog(null)}
            onSubmit={(values) => {
              const current = dialog;
              void controller
                .run(
                  current.action.id,
                  current.action.label,
                  values,
                  current.target,
                )
                .then((saved) => {
                  if (saved) setDialog(null);
                });
            }}
          />
        </Box>
      ) : dialog?.kind === "confirm" ? (
        <ConfirmDialog
          width={width}
          height={contentHeight}
          selected={confirmIndex}
          label={dialog.action?.label ?? "退出管理器"}
          message={
            dialog.action?.confirm ?? "退出会停止此 TUI 启动的服务。继续吗？"
          }
        />
      ) : dialog?.kind === "inspect" ? (
        <InspectDialog
          row={view?.rows[selected]}
          revealed={revealed}
          width={width}
          height={contentHeight}
        />
      ) : dialog?.kind === "palette" ? (
        <CommandPalette
          commands={commands}
          selected={commandIndex}
          query={query}
          onQuery={(value) => {
            setQuery(value);
            setCommandIndex(0);
          }}
          width={width}
          height={contentHeight}
        />
      ) : (
        <ConsoleContent
          data={data}
          view={view}
          selected={selected}
          revealed={revealed}
          width={width}
          height={contentHeight}
        />
      )}
    </ConsoleShell>
  );
}
