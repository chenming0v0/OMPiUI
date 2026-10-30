import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

/** node-pty 与 bun-pty 共同的最小接口面（两者 API 本来就兼容） */
type PtyProcess = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(
    listener: (event: { exitCode: number; signal?: number | string }) => void,
  ): { dispose(): void };
};
type PtyModule = {
  spawn: (file: string, args: string[], options: object) => PtyProcess;
};
let ptyModule: PtyModule | undefined;

const isBunRuntime =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * PTY 库按运行时二选一（与 opencode 的 #pty 条件 imports 同一个思路）：
 * - Bun（含 bun --compile）→ bun-pty：纯 FFI 原生库，不碰 Node socket API。
 *   node-pty 的 ConPTY 走 Windows 命名管道 + net.Socket，Bun 兼容层会在
 *   写入时同步抛 ERR_SOCKET_CLOSED 并带走整个进程。
 * - Node（开发/测试）→ @lydell/node-pty。
 * 编译形态下两者都从 OMPIUI_NATIVE_MODULES 按绝对路径加载——Bun 编译产物的
 * require 不会为磁盘上的外部模块做 node_modules 上溯解析。
 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule;
  const nativeRoot = process.env.OMPIUI_NATIVE_MODULES?.trim();
  if (isBunRuntime) {
    if (nativeRoot && process.platform === "win32") {
      // 显式指定 DLL 路径，跳过包内的探测逻辑
      process.env.BUN_PTY_LIB ??= join(
        nativeRoot,
        "bun-pty",
        "rust-pty",
        "target",
        "release",
        "rust_pty.dll",
      );
    }
    const entry = nativeRoot
      ? join(nativeRoot, "bun-pty", "src", "index.ts")
      : "bun-pty";
    ptyModule = createRequire(nativeRoot ? entry : import.meta.url)(
      entry,
    ) as PtyModule;
  } else if (nativeRoot) {
    const platformEntry = join(
      nativeRoot,
      "@lydell",
      `node-pty-${process.platform}-${process.arch}`,
      "lib",
      "index.js",
    );
    ptyModule = createRequire(platformEntry)(platformEntry) as PtyModule;
  } else {
    ptyModule = createRequire(import.meta.url)("@lydell/node-pty") as PtyModule;
  }
  return ptyModule;
}
import type {
  EventChannel,
  TerminalCreateParams,
  TerminalShell,
  TerminalInfo,
  TerminalUpdateParams,
} from "@ompiui/protocol";
import { resolveWorkspacePath } from "./path-safety.ts";
import { workspacePathKey } from "./workspace-store.ts";
import { TextWindow } from "./text-window.ts";
import { RateBudget } from "../rate-budget.ts";

const OUTPUT_BUFFER_LIMIT = 2 * 1024 * 1024;
const REPLAY_BYTE_LIMIT = 1024 * 1024;
const PENDING_BYTE_LIMIT = 1024 * 1024;
const EXITED_SESSION_LIMIT = 25;
const TERMINAL_LIMIT = 32;
const FORCE_KILL_DELAY_MS = 1_000;
const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 1024;
const execFileAsync = promisify(execFile);

type TerminalEventChannel = Extract<EventChannel, `terminal.${string}`>;

type Subscriber = {
  active: boolean;
  pending: Array<{ data: string; bytes: number }>;
  pendingBytes: number;
  overflow?: boolean;
  end?: { exitCode: number | null };
  pendingTitle?: string;
  onData: (data: string, bytes: number) => void;
  onEnd: (event: { exitCode: number | null }) => void;
  onTitle: (title: string) => void;
};

type ActiveTerminal = {
  workspacePath: string;
  info: TerminalInfo;
  process: PtyProcess;
  customTitle?: string;
  titleBuffer: string;
  titleTimer?: NodeJS.Timeout;
  inputBudget?: RateBudget;
  output: string;
  outputBytes: number;
  outputWindow: TextWindow;
  bufferCursor: number;
  subscribers: Map<object, Subscriber>;
  listeners: Array<{ dispose(): void }>;
};

type OwnedProcess = {
  exited: Promise<void>;
  stopRequested: boolean;
  exitObserved: boolean;
  linuxStartTime?: string;
  forceKillTimer?: NodeJS.Timeout;
};

type TerminalTicket = {
  terminalId: string;
  workspacePath: string;
  expiresAt: number;
};

export type TerminalAttachment = {
  replay: string;
  replayCursor: number;
  cursor: number;
  activate(): void;
  detach(): void;
};

export type TerminalManagerOptions = {
  publish?: (
    workspacePath: string,
    channel: TerminalEventChannel,
    payload: TerminalInfo,
  ) => void;
};

export class TerminalManager {
  private readonly terminals = new Map<string, ActiveTerminal>();
  private readonly exitedOrder: string[] = [];
  private readonly tickets = new Map<string, TerminalTicket>();
  /** Retained after tab/workspace removal until the owned PTY reports real exit. */
  private readonly ownedProcesses = new Map<PtyProcess, OwnedProcess>();
  private readonly exitErrors: unknown[] = [];
  /** Creates still awaiting async cwd resolution; counts toward the limit. */
  private pendingCreates = 0;
  private shuttingDown = false;
  private readonly creates = new Set<Promise<TerminalInfo>>();

  constructor(private readonly options: TerminalManagerOptions = {}) {}

  list(workspacePath: string): TerminalInfo[] {
    return Array.from(this.terminals.values())
      .filter(
        (terminal) =>
          workspacePathKey(terminal.workspacePath) ===
          workspacePathKey(workspacePath),
      )
      .map((terminal) => ({ ...terminal.info }));
  }

  /** Only this manager's live GUI shells can keep a checkout in use. */
  hasRunningInDirectory(directory: string): boolean {
    const root = workspacePathKey(path.resolve(directory));
    const contains = (candidate: string) => {
      const relative = path.relative(root, workspacePathKey(path.resolve(candidate)));
      return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    for (const terminal of this.terminals.values()) {
      if (terminal.info.status === "running" &&
        (contains(terminal.workspacePath) || contains(terminal.info.cwd))) return true;
    }
    return false;
  }

  async listShells(): Promise<TerminalShell[]> {
    const candidates =
      process.platform === "win32" ? await windowsShells() : await unixShells();
    const seen = new Set<string>();
    const shells: TerminalShell[] = [];
    for (const candidate of candidates) {
      const shell = candidate.trim();
      if (!shell || seen.has(shell) || !isFile(shell)) continue;
      seen.add(shell);
      shells.push({
        path: shell,
        name: shellName(shell),
        acceptable: isAcceptableShell(shell),
      });
    }
    return shells;
  }

  get(workspacePath: string, id: string): TerminalInfo {
    return { ...this.require(workspacePath, id).info };
  }

  async create(
    workspacePath: string,
    params: TerminalCreateParams = {},
  ): Promise<TerminalInfo> {
    if (this.shuttingDown) {
      throw Object.assign(new Error("terminal manager is shutting down"), { code: "TERMINAL_CLOSED" });
    }
    // Reserve a slot synchronously so concurrent creates cannot all pass the
    // limit check while an earlier one is still awaiting its working directory.
    let running = 0;
    for (const terminal of this.terminals.values()) {
      if (terminal.info.status === "running") running += 1;
    }
    if (running + this.pendingCreates >= TERMINAL_LIMIT) {
      throw Object.assign(new Error("terminal limit reached"), {
        code: "TERMINAL_LIMIT_REACHED",
      });
    }
    this.pendingCreates += 1;
    const creating = this.createReserved(workspacePath, params);
    this.creates.add(creating);
    try {
      return await creating;
    } finally {
      this.pendingCreates -= 1;
      this.creates.delete(creating);
    }
  }

  private async createReserved(
    workspacePath: string,
    params: TerminalCreateParams,
  ): Promise<TerminalInfo> {
    const cwd = await this.resolveCwd(workspacePath, params.cwd);
    const shell = resolveShell(params.shell);
    requireByteLimit(shell, 4096, "shell");
    const size = terminalSize(params.rows, params.cols);
    const id = `term_${randomUUID()}`;
    const customTitle = params.title?.trim() || undefined;
    if (customTitle) requireByteLimit(customTitle, 512, "title");
    const title = customTitle || path.basename(shell) || "Terminal";
    const environment = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OMPIUI_TERMINAL: "1",
    };

    let child: PtyProcess;
    try {
      if (this.shuttingDown) {
        throw Object.assign(new Error("terminal manager is shutting down"), { code: "TERMINAL_CLOSED" });
      }
      child = loadPty().spawn(shell, shellArgs(shell), {
        name: "xterm-256color",
        cwd,
        cols: size.cols,
        rows: size.rows,
        env: environment,
      });
    } catch (error) {
      throw Object.assign(
        new Error(
          `failed to start terminal: ${error instanceof Error ? error.message : String(error)}`,
        ),
        {
          code: "TERMINAL_START_FAILED",
        },
      );
    }

    const outputWindow = new TextWindow(OUTPUT_BUFFER_LIMIT);
    const terminal: ActiveTerminal = {
      workspacePath,
      info: {
        id,
        title,
        shell,
        cwd,
        status: "running",
        pid: child.pid,
        cursor: 0,
      },
      process: child,
      customTitle,
      titleBuffer: "",
      get output() {
        return outputWindow.toString();
      },
      get outputBytes() {
        return outputWindow.bytes;
      },
      outputWindow,
      bufferCursor: 0,
      subscribers: new Map(),
      listeners: [],
    };
    this.terminals.set(id, terminal);
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
    const owned: OwnedProcess = {
      exited,
      stopRequested: false,
      exitObserved: false,
      linuxStartTime: !isBunRuntime && process.platform === "linux"
        ? readOwnedLinuxProcessStartTime(child.pid) : undefined,
    };
    this.ownedProcesses.set(child, owned);
    // This listener is deliberately not in terminal.listeners: removing a tab
    // must not lose the actual exit barrier.
    const exitListener = child.onExit(({ exitCode }) => {
      if (owned.exitObserved) return;
      owned.exitObserved = true;
      clearTimeout(owned.forceKillTimer);
      owned.forceKillTimer = undefined;
      // bun-pty emits onExit synchronously from kill(), and also on read EOF.
      // Neither proves child.wait completed. Confirm disappearance of this
      // exact owned PID; never signal a PID that may have been reused.
      void (async () => {
        if (isBunRuntime) await waitForOwnedProcessExit(child.pid);
        // Defer disposal: bun-pty iterates its mutable listener array.
        // Close its PTY only after the real owned process disappeared.
        queueMicrotask(() => {
          try {
            exitListener.dispose();
            if (isBunRuntime) child.kill();
            if (this.terminals.get(id) === terminal) this.handleExit(terminal, exitCode);
          } catch (error) {
            this.exitErrors.push(error);
          } finally {
            this.ownedProcesses.delete(child);
            resolveExit();
          }
        });
      })();
    });
    terminal.listeners.push(child.onData((data) => this.handleData(terminal, data)));
    this.publish(terminal, "terminal.created");
    return { ...terminal.info };
  }

  update(
    workspacePath: string,
    id: string,
    params: TerminalUpdateParams,
  ): TerminalInfo {
    const terminal = this.require(workspacePath, id);
    let changed = false;
    if (params.title !== undefined) {
      const title = params.title.trim();
      requireByteLimit(title, 512, "title");
      if (!title)
        throw Object.assign(new Error("params.title must not be empty"), {
          code: "INVALID_REQUEST",
        });
      if (title !== terminal.info.title) {
        clearTimeout(terminal.titleTimer);
        terminal.titleTimer = undefined;
        changed = true;
        terminal.info.title = title;
        terminal.customTitle = title;
        for (const subscriber of terminal.subscribers.values()) {
          if (!subscriber.active) {
            subscriber.pendingTitle = title;
            continue;
          }
          try {
            subscriber.onTitle(title);
          } catch {
            // A disconnected client must not affect the terminal process.
          }
        }
      }
    }
    if (params.rows !== undefined || params.cols !== undefined) {
      const size = terminalSize(
        params.rows ?? terminal.process.rows,
        params.cols ?? terminal.process.cols,
      );
      // 尺寸没变就不动 pty 也不广播——客户端每次连接都会发一次 resize，
      // 无条件 publish 会触发 "updated → 重新拉列表 → 重连 → 再 resize" 的循环
      if (
        size.cols !== terminal.process.cols ||
        size.rows !== terminal.process.rows
      ) {
        changed = true;
        if (terminal.info.status === "running")
          terminal.process.resize(size.cols, size.rows);
      }
    }
    if (changed) this.publish(terminal, "terminal.updated");
    return { ...terminal.info };
  }

  remove(workspacePath: string, id: string): void {
    const terminal = this.require(workspacePath, id);
    this.removeTerminal(terminal);
  }

  issueConnectToken(
    workspacePath: string,
    id: string,
  ): { token: string; expiresIn: number } {
    const terminal = this.require(workspacePath, id);
    const now = Date.now();
    for (const [token, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(token);
    }
    if (this.tickets.size >= MAX_TICKETS) {
      throw Object.assign(new Error("terminal ticket limit reached"), { code: "RATE_LIMITED" });
    }
    const token = randomUUID();
    this.tickets.set(token, {
      terminalId: id,
      workspacePath: terminal.workspacePath,
      expiresAt: now + TICKET_TTL_MS,
    });
    return { token, expiresIn: TICKET_TTL_MS / 1000 };
  }

  consumeConnectToken(id: string, token: string): string | undefined {
    const record = this.tickets.get(token);
    if (!record) return undefined;
    this.tickets.delete(token);
    if (record.expiresAt <= Date.now() || record.terminalId !== id)
      return undefined;
    const terminal = this.terminals.get(id);
    if (!terminal) return undefined;
    return terminal.workspacePath;
  }

  write(workspacePath: string, id: string, data: string): void {
    const terminal = this.require(workspacePath, id);
    if (terminal.info.status !== "running") {
      throw Object.assign(new Error("terminal has exited"), {
        code: "TERMINAL_EXITED",
      });
    }
    const bytes = Buffer.byteLength(data);
    terminal.inputBudget ??= new RateBudget(4 * 1024 * 1024, 1024 * 1024);
    // Node PTY 的写入管道有可观测水位；Bun PTY 为同步写入，没有该队列。
    const process = terminal.process as PtyProcess & {
      _socket?: { writableLength: number };
      _agent?: { inSocket?: { writableLength: number } };
    };
    const pendingBytes = process._agent?.inSocket?.writableLength ?? process._socket?.writableLength ?? 0;
    if (pendingBytes + bytes > 1024 * 1024 || !terminal.inputBudget.allow(bytes)) {
      throw Object.assign(new Error("terminal input budget exceeded"), { code: "RATE_LIMITED" });
    }
    terminal.process.write(data);
  }

  attach(
    workspacePath: string,
    id: string,
    cursor: number | undefined,
    onData: (data: string, bytes: number) => void,
    onEnd: (event: { exitCode: number | null }) => void,
    onTitle: (title: string) => void = () => {},
  ): TerminalAttachment {
    const terminal = this.require(workspacePath, id);
    const end = terminal.info.cursor;
    let from = cursor === -1 ? end : (cursor ?? terminal.bufferCursor);
    if (!Number.isSafeInteger(from) || from < 0) {
      throw Object.assign(
        new Error("terminal cursor must be a non-negative integer or -1"),
        { code: "INVALID_REQUEST" },
      );
    }
    if (from > end) {
      throw Object.assign(new Error("terminal cursor is in the future"), {
        code: "INVALID_REQUEST",
      });
    }
    if (from < terminal.bufferCursor) {
      throw Object.assign(new Error("terminal output cursor has expired"), {
        code: "TERMINAL_CURSOR_EXPIRED",
      });
    }
    const offset = Math.max(0, from - terminal.bufferCursor);
    const replayWindow = terminal.outputWindow.sliceFrom(offset, REPLAY_BYTE_LIMIT);
    let replay = replayWindow.text;
    const remaining = terminal.outputWindow.length - offset;
    if (remaining > replayWindow.chars) {
      if (cursor !== undefined)
        throw Object.assign(
          new Error("terminal replay byte window has expired"),
          { code: "TERMINAL_CURSOR_EXPIRED" },
        );
      // 首次挂接只保留最近的字节窗口；重连游标则必须明确报告失效。
      const tail = terminal.outputWindow.tail(REPLAY_BYTE_LIMIT);
      from = terminal.info.cursor - tail.chars;
      replay = tail.text;
    }

    // An exited terminal is a retained replay window: attach, deliver what is
    // still buffered, then report the exit. There is no live process to write to.
    if (terminal.info.status !== "running") {
      const exitCode = terminal.info.exitCode ?? null;
      return {
        replay,
        replayCursor: from,
        cursor: end,
        activate: () => {
          try {
            onEnd({ exitCode });
          } catch {
            // A detached client must not prevent the socket from closing.
          }
        },
        detach: () => {},
      };
    }

    const subscriber: Subscriber = {
      active: false,
      pending: [],
      pendingBytes: 0,
      onData,
      onEnd,
      onTitle,
    };
    const token = {};
    terminal.subscribers.set(token, subscriber);

    return {
      replay,
      replayCursor: from,
      cursor: end,
      activate: () => {
        if (subscriber.active) return;
        if (subscriber.overflow)
          throw Object.assign(
            new Error("terminal pending output has expired"),
            { code: "TERMINAL_CURSOR_EXPIRED" },
          );
        subscriber.active = true;
        try {
          for (const chunk of subscriber.pending) subscriber.onData(chunk.data, chunk.bytes);
        } catch {
          terminal.subscribers.delete(token);
        }
        subscriber.pending.length = 0;
        subscriber.pendingBytes = 0;
        if (subscriber.end) {
          try {
            subscriber.onEnd(subscriber.end);
          } catch {
            // A detached client must not affect the terminal process.
          }
        }
        if (subscriber.pendingTitle) {
          try {
            subscriber.onTitle(subscriber.pendingTitle);
          } catch {
            // A detached client must not affect the terminal process.
          }
          subscriber.pendingTitle = undefined;
        }
      },
      detach: () => {
        terminal.subscribers.delete(token);
        subscriber.pending.length = 0;
        subscriber.pendingBytes = 0;
        subscriber.end = undefined;
      },
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          const exits = Array.from(this.ownedProcesses.values(), ({ exited }) => exited);
          this.dispose();
          await Promise.allSettled(this.creates);
          await Promise.all(exits);
          if (this.exitErrors.length) {
            throw new AggregateError(this.exitErrors, "failed to reap owned terminal processes");
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("owned terminals did not exit")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  dispose(): void {
    this.shuttingDown = true;
    // Retry previously removed handles first, without signalling any process
    // that has already exited (its PID may now belong to an unrelated process).
    const activeProcesses = new Set(Array.from(this.terminals.values(), terminal => terminal.process));
    for (const process of this.ownedProcesses.keys()) {
      if (!activeProcesses.has(process)) this.stopOwnedProcess(process);
    }
    for (const terminal of Array.from(this.terminals.values()))
      this.removeTerminal(terminal, false);
    this.terminals.clear();
    this.exitedOrder.length = 0;
    this.tickets.clear();
  }

  /** Closes every terminal owned by the workspace and invalidates their connect tickets. */
  closeWorkspace(workspacePath: string): void {
    const key = workspacePathKey(workspacePath);
    for (const terminal of Array.from(this.terminals.values())) {
      if (workspacePathKey(terminal.workspacePath) === key)
        this.removeTerminal(terminal);
    }
    for (const [token, record] of this.tickets) {
      if (workspacePathKey(record.workspacePath) === key)
        this.tickets.delete(token);
    }
  }

  private require(workspacePath: string, id: string): ActiveTerminal {
    const terminal = this.terminals.get(id);
    if (
      !terminal ||
      workspacePathKey(terminal.workspacePath) !==
        workspacePathKey(workspacePath)
    ) {
      throw Object.assign(new Error(`terminal not found: ${id}`), {
        code: "TERMINAL_NOT_FOUND",
      });
    }
    return terminal;
  }

  private async resolveCwd(
    workspacePath: string,
    requested?: string,
  ): Promise<string> {
    const resolved = resolveWorkspacePath(workspacePath, requested ?? "");
    if (!resolved.exists)
      throw Object.assign(new Error("terminal cwd does not exist"), {
        code: "INVALID_REQUEST",
      });
    const stat = await lstat(resolved.absolute);
    if (!stat.isDirectory())
      throw Object.assign(new Error("terminal cwd must be a directory"), {
        code: "INVALID_REQUEST",
      });
    return resolved.absolute;
  }

  private handleData(terminal: ActiveTerminal, data: string): void {
    const bytes = Buffer.byteLength(data);
    if (!terminal.customTitle) {
      // 普通输出不拼接标题缓冲；仅追踪 OSC 起始或跨块的 ESC。
      if (terminal.titleBuffer || data.includes("\x1b]") || data.endsWith("\x1b")) {
        terminal.titleBuffer = (terminal.titleBuffer + data).slice(-512);
      }
    }
    const title = terminal.customTitle
      ? undefined
      : extractTerminalTitle(terminal.titleBuffer);
    if (title) terminal.titleBuffer = "";
    else if (!terminal.titleBuffer.includes("\x1b]")) {
      terminal.titleBuffer = terminal.titleBuffer.endsWith("\x1b") ? "\x1b" : "";
    }
    if (title && title !== terminal.info.title) {
      terminal.info.title = title;
      terminal.titleTimer ??= setTimeout(() => this.flushTitle(terminal), 250);
      terminal.titleTimer.unref();
    }
    terminal.info.cursor += data.length;
    for (const [token, subscriber] of terminal.subscribers) {
      if (!subscriber.active) {
        subscriber.pendingBytes += bytes;
        if (
          subscriber.pendingBytes > PENDING_BYTE_LIMIT ||
          subscriber.pending.length >= 1024
        ) {
          subscriber.overflow = true;
          subscriber.pending.length = 0;
          subscriber.pendingBytes = 0;
          terminal.subscribers.delete(token);
          continue;
        }
        subscriber.pending.push({ data, bytes });
        continue;
      }
      try {
        subscriber.onData(data, bytes);
      } catch {
        terminal.subscribers.delete(token);
      }
    }
    terminal.outputWindow.append(data, bytes);
    terminal.bufferCursor = terminal.info.cursor - terminal.outputWindow.length;
  }

  private handleExit(terminal: ActiveTerminal, exitCode: number): void {
    if (terminal.info.status === "exited") return;
    this.flushTitle(terminal);
    terminal.info.status = "exited";
    terminal.info.exitCode = exitCode;
    const end = { exitCode };
    for (const subscriber of terminal.subscribers.values()) {
      if (!subscriber.active) subscriber.end = end;
      else {
        try {
          subscriber.onEnd(end);
        } catch {
          // A disconnected client must not prevent other subscribers from closing.
        }
      }
    }
    terminal.subscribers.clear();
    this.exitedOrder.push(terminal.info.id);
    this.publish(terminal, "terminal.exited");
    while (this.exitedOrder.length > EXITED_SESSION_LIMIT) {
      const oldest = this.exitedOrder.shift();
      const expired = oldest ? this.terminals.get(oldest) : undefined;
      if (expired) this.removeTerminal(expired);
    }
  }

  private removeTerminal(terminal: ActiveTerminal, publish = true): void {
    clearTimeout(terminal.titleTimer);
    this.terminals.delete(terminal.info.id);
    const index = this.exitedOrder.indexOf(terminal.info.id);
    if (index >= 0) this.exitedOrder.splice(index, 1);
    this.invalidateTerminalTickets(terminal.info.id);
    for (const listener of terminal.listeners) listener.dispose();
    terminal.listeners.length = 0;
    this.stopOwnedProcess(terminal.process);
    for (const subscriber of terminal.subscribers.values()) {
      if (subscriber.active) {
        try {
          subscriber.onEnd({ exitCode: terminal.info.exitCode ?? null });
        } catch {
          // Cleanup continues even when a client callback fails.
        }
      }
    }
    terminal.subscribers.clear();
    if (publish) this.publish(terminal, "terminal.deleted");
  }

  private stopOwnedProcess(process: PtyProcess): void {
    const owned = this.ownedProcesses.get(process);
    if (!owned || owned.stopRequested || owned.exitObserved) return;
    // ConPTY kill releases native handles before its delayed onExit callback.
    // Repeated dispose/shutdown must not close those handles again.
    owned.stopRequested = true;
    // Node's Linux adapter sends only one SIGHUP. Bash can lose an early HUP
    // during startup or deliberately ignore it, so retain a bounded fallback.
    // Do not use this path for ConPTY or bun-pty (kill also closes handles).
    if (owned.linuxStartTime !== undefined) {
      owned.forceKillTimer = setTimeout(() => {
        owned.forceKillTimer = undefined;
        // node-pty may defer onExit until after waitpid/socket close. Recheck
        // identity and live state rather than trusting a retained numeric PID.
        if (this.ownedProcesses.get(process) !== owned || owned.exitObserved ||
          readOwnedLinuxProcessStartTime(process.pid) !== owned.linuxStartTime) return;
        try {
          process.kill("SIGKILL");
        } catch {
          // A signal racing exit is not proof of reaping; await the real onExit.
        }
      }, FORCE_KILL_DELAY_MS);
      owned.forceKillTimer.unref();
    }
    try {
      process.kill();
    } catch {
      clearTimeout(owned.forceKillTimer);
      owned.forceKillTimer = undefined;
      owned.stopRequested = false;
      // Do not treat a failed signal as exit. Keep the handle until onExit,
      // and retry this owned handle on a later dispose/shutdown.
    }
  }

  private invalidateTerminalTickets(id: string): void {
    for (const [token, record] of this.tickets) {
      if (record.terminalId === id) this.tickets.delete(token);
    }
  }

  private flushTitle(terminal: ActiveTerminal): void {
    if (!terminal.titleTimer) return;
    clearTimeout(terminal.titleTimer);
    terminal.titleTimer = undefined;
    for (const subscriber of terminal.subscribers.values()) {
      if (!subscriber.active) subscriber.pendingTitle = terminal.info.title;
      else {
        try {
          subscriber.onTitle(terminal.info.title);
        } catch {
          // 单个客户端回调失败不影响其他订阅者。
        }
      }
    }
    this.publish(terminal, "terminal.updated");
  }

  private publish(
    terminal: ActiveTerminal,
    channel: TerminalEventChannel,
  ): void {
    this.options.publish?.(terminal.workspacePath, channel, {
      ...terminal.info,
    });
  }
}

function readOwnedLinuxProcessStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesized and may itself contain spaces or ')'. Fields after
    // its final ')' start at field 3 (state); field 22 is the birth timestamp.
    const commEnd = stat.lastIndexOf(")");
    if (!stat.startsWith(`${pid} (`) || commEnd < stat.indexOf("(") || stat[commEnd + 1] !== " ") return;
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    if (!/^[A-Za-z]$/.test(fields[0] ?? "") || Number(fields[1]) !== process.pid ||
      ["Z", "X", "x"].includes(fields[0] ?? "")) return;
    return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
  } catch {
    // Missing /proc, access denied, or a reaped child: fail closed.
    return undefined;
  }
}

async function waitForOwnedProcessExit(pid: number): Promise<void> {
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      // Access denied or another ambiguous OS error is not proof of exit.
    }
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}

function requireByteLimit(value: string, maxBytes: number, field: string): void {
  if (Buffer.byteLength(value) > maxBytes) {
    throw Object.assign(new Error(`terminal ${field} exceeds ${maxBytes} bytes`), { code: "INVALID_REQUEST" });
  }
}

function resolveShell(requested?: string): string {
  if (requested?.trim()) return requested.trim();
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

async function unixShells(): Promise<string[]> {
  try {
    const text = await readFile("/etc/shells", "utf8");
    const listed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (listed.length > 0) return listed;
  } catch {
    // Use the standard fallbacks below when /etc/shells is unavailable.
  }
  return ["/bin/bash", "/bin/zsh", "/bin/sh"];
}

async function windowsShells(): Promise<string[]> {
  const shells = await Promise.all([
    commandPath("pwsh"),
    commandPath("powershell"),
  ]);
  const gitPaths = await commandPaths("git");
  for (const git of gitPaths) {
    const bash = [
      path.join(git, "..", "..", "bin", "bash.exe"),
      path.join(git, "..", "..", "..", "bin", "bash.exe"),
    ].find(isFile);
    if (bash) {
      shells.push(bash);
      break;
    }
  }
  shells.push(process.env.ComSpec || "cmd.exe");
  return shells.filter((shell): shell is string => Boolean(shell));
}

async function commandPath(command: string): Promise<string | undefined> {
  return (await commandPaths(command))[0];
}

async function commandPaths(command: string): Promise<string[]> {
  try {
    const result = await execFileAsync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { windowsHide: true },
    );
    return String(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function shellName(shell: string): string {
  return path
    .basename(shell)
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function isAcceptableShell(shell: string): boolean {
  return !new Set(["fish", "nu"]).has(shellName(shell));
}

function shellArgs(shell: string): string[] {
  const name = path.basename(shell).toLowerCase();
  if (name === "cmd" || name === "cmd.exe") return ["/d"];
  if (
    name === "powershell" ||
    name === "powershell.exe" ||
    name === "pwsh" ||
    name === "pwsh.exe"
  ) {
    return ["-NoLogo", "-NoProfile"];
  }
  return ["-i"];
}

function terminalSize(
  rows?: number,
  cols?: number,
): { rows: number; cols: number } {
  const valid = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
      throw Object.assign(
        new Error("terminal size must be an integer from 1 to 500"),
        { code: "INVALID_REQUEST" },
      );
    }
    return value;
  };
  return { rows: valid(rows, 24), cols: valid(cols, 80) };
}

export function extractTerminalTitle(data: string): string | undefined {
  const match = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(data);
  const title = match?.[1]?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return title ? title.slice(0, 120) : undefined;
}
