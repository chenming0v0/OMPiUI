import {
  LogBuffer,
  type ConsoleAdapter,
  type ConsoleData,
  type ConsoleField,
  type ConsoleView,
} from "@ompiui/tui";
import { loadOrCreateAdminToken } from "./config.ts";
import {
  ServiceManager,
  type BackendSettings,
  type ServiceStatus,
} from "./manager.ts";
import { AdminHttpServer } from "./server.ts";

interface BackendControl {
  remote: boolean;
  status(): Promise<ServiceStatus>;
  settings(): Promise<Record<string, string>>;
  token(): Promise<string | undefined>;
  execute(action: string, settings?: BackendSettings): Promise<void>;
  dispose(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback = "-"): string {
  return typeof value === "string" ? value : fallback;
}
function tunnelLabel(value: unknown, fallback: string): string {
  const labels: Record<string, string> = {
    disabled: "未启用",
    dialing: "连接中",
    connected: "已连接",
    reconnecting: "重新连接",
    error: "连接错误",
  };
  return labels[text(value, "")] ?? text(value, fallback);
}

export function validateBackendForm(
  values: Record<string, string>,
): BackendSettings {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("监听端口必须在 1 到 65535 之间");
  const parsed = new URL(values.serverUrl!);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("健康检查地址必须是无用户名和密码的 HTTP(S) 地址");
  }
  if (values.publicBaseUrl && !/^https?:\/\//i.test(values.publicBaseUrl))
    throw new Error("公网地址必须以 http:// 或 https:// 开头");
  if (values.tunnelUrl && !/^wss?:\/\//i.test(values.tunnelUrl))
    throw new Error("中转地址必须以 ws:// 或 wss:// 开头");
  return {
    host: values.host,
    port: values.port,
    serverUrl: parsed.toString().replace(/\/+$/, ""),
    publicBaseUrl: values.publicBaseUrl,
    tunnelUrl: values.tunnelUrl,
    tunnelId: values.tunnelId,
    ...(values.tunnelKey?.trim() ? { tunnelKey: values.tunnelKey.trim() } : {}),
  };
}

export class BackendConsole implements ConsoleAdapter {
  constructor(
    private readonly control: BackendControl,
    private readonly logs: LogBuffer,
    private readonly adminToken: string,
  ) {}

  async read(): Promise<ConsoleData> {
    const [status, settings, token] = await Promise.all([
      this.control.status(),
      this.control.settings(),
      this.control.token(),
    ]);
    const share = record(status.share);
    const tunnel = record(status.tunnel);
    const external = status.lifecycle !== "running" && Boolean(status.health);
    const healthy = Boolean(status.health);
    const summary = external
      ? "外部后端"
      : status.lifecycle === "running"
        ? healthy
          ? "运行中"
          : "等待就绪"
        : status.lifecycle === "starting"
          ? "启动中"
          : status.lifecycle === "exited"
            ? "异常退出"
            : "已停止";
    const actions = [
      {
        id: "start",
        label: "启动后端",
        key: "s",
        disabled: status.lifecycle === "running" || external,
      },
      {
        id: "stop",
        label: "停止后端",
        key: "x",
        tone: "danger" as const,
        confirm: "停止后端会中断正在执行的任务和远程连接。继续吗？",
        disabled: status.lifecycle !== "running",
      },
      {
        id: "restart",
        label: "重启后端",
        key: "r",
        tone: "warning" as const,
        confirm: "重启后端会中断当前任务，并重新建立远程连接。继续吗？",
        disabled: external,
      },
    ];
    const fields: ConsoleField[] = [
      { key: "host", label: "监听地址", value: settings.host || "127.0.0.1" },
      { key: "port", label: "监听端口", value: settings.port || "8787" },
      { key: "serverUrl", label: "健康检查地址", value: settings.serverUrl },
      {
        key: "publicBaseUrl",
        label: "公网入口",
        value: settings.publicBaseUrl,
        optional: true,
      },
      {
        key: "tunnelUrl",
        label: "中转 WebSocket 地址",
        value: settings.tunnelUrl,
        optional: true,
      },
      {
        key: "tunnelId",
        label: "隧道 ID",
        value: settings.tunnelId,
        optional: true,
      },
      { key: "tunnelKey", label: "中转接入密钥", secret: true, optional: true },
    ];
    const views: ConsoleView[] = [
      {
        id: "overview",
        label: "概览",
        caption: this.control.remote
          ? "已接入现有管理器 / 不在此终端启动第二份后端"
          : "本机后端 / 仅控制当前管理器启动的进程",
        rows: [
          {
            id: "status",
            label: "服务状态",
            value: summary,
            tone: healthy
              ? "success"
              : status.lifecycle === "exited"
                ? "danger"
                : "warning",
          },
          {
            id: "pid",
            label: "进程",
            value: status.pid === null ? "-" : String(status.pid),
          },
          { id: "url", label: "后端地址", value: status.backendUrl },
          {
            id: "health",
            label: "健康检查",
            value: healthy ? "在线" : (status.healthError ?? "离线"),
            tone: healthy ? "success" : "neutral",
          },
          {
            id: "tunnel",
            label: "中转连接",
            value: tunnelLabel(
              tunnel.state,
              settings.tunnelConfigured === "true" ? "等待后端" : "未配置",
            ),
          },
          {
            id: "entry",
            label: "公网入口",
            value: text(tunnel.publicUrl, settings.publicBaseUrl || "-"),
          },
          { id: "error", label: "最近错误", value: status.error ?? "-" },
        ],
        actions,
      },
      {
        id: "network",
        label: "网络与中转",
        caption: "配置保存后重启后端生效",
        rows: [
          {
            id: "host",
            label: "监听地址",
            value: `${settings.host || "127.0.0.1"}:${settings.port || "8787"}`,
          },
          {
            id: "probe",
            label: "健康检查地址",
            value: settings.serverUrl || status.backendUrl,
          },
          {
            id: "public",
            label: "公网入口",
            value: settings.publicBaseUrl || "-",
          },
          { id: "relay", label: "中转地址", value: settings.tunnelUrl || "-" },
          { id: "tunnelId", label: "隧道 ID", value: settings.tunnelId || "-" },
          {
            id: "key",
            label: "中转密钥",
            value: settings.tunnelConfigured === "true" ? "已配置" : "未配置",
          },
        ],
        actions: [
          { id: "configure", label: "编辑配置", key: "e", fields },
          ...actions,
        ],
      },
      {
        id: "credentials",
        label: "凭证与配对",
        caption: "凭证默认隐藏，主动显示后 30 秒自动遮蔽",
        rows: [
          {
            id: "backend-token",
            label: "后端访问令牌",
            value: token || "尚未生成",
            secret: Boolean(token),
          },
          {
            id: "admin-token",
            label: "管理令牌",
            value: this.adminToken,
            secret: true,
          },
          {
            id: "share",
            label: "浏览器链接",
            value: text(share.url, status.backendUrl),
            secret: Boolean(share.url),
          },
          {
            id: "deep-link",
            label: "手机配对链接",
            value: text(share.link, "后端就绪后生成"),
            secret: Boolean(share.link),
          },
        ],
        actions: [
          { id: "reveal", label: "显示或隐藏凭证", key: "v", tone: "warning" },
        ],
      },
      { id: "logs", label: "运行日志", caption: "", rows: [], actions },
    ];
    return {
      name: "Server",
      subtitle: this.control.remote ? "ATTACHED" : "LOCAL OWNER",
      status: summary,
      tone: healthy
        ? "success"
        : status.lifecycle === "exited"
          ? "danger"
          : "warning",
      endpoint: status.backendUrl,
      ownedRunning: !this.control.remote && status.lifecycle === "running",
      views,
      logs: this.logs.read(),
    };
  }

  async execute(
    action: string,
    values: Record<string, string>,
  ): Promise<string> {
    if (action === "configure") {
      await this.control.execute(action, validateBackendForm(values));
      this.logs.append("后端配置已保存", "accent");
      return "配置已保存，重启后端后生效";
    }
    if (!["start", "stop", "restart"].includes(action))
      throw new Error("未知后端操作");
    await this.control.execute(action);
    const message = {
      start: "后端已启动",
      stop: "后端已停止",
      restart: "后端已重启",
    }[action]!;
    this.logs.append(message, action === "stop" ? "warning" : "success");
    return message;
  }

  dispose(): Promise<void> {
    return this.control.dispose();
  }
}

export async function createBackendConsole(
  options: {
    manager?: ServiceManager;
    host?: string;
    port?: number;
    token?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<BackendConsole> {
  const env = options.env ?? process.env;
  const manager = options.manager ?? new ServiceManager({ env });
  const config = manager.getConfig();
  const token = options.token ?? loadOrCreateAdminToken(env);
  const logs = new LogBuffer(() => [
    token,
    manager.backendToken(),
    manager.getConfig().serverEnv.OMPIUI_TUNNEL_KEY,
    env.OMPIUI_TUNNEL_KEY,
  ]);
  manager.captureOutput((line) => logs.append(line));
  const server = new AdminHttpServer(manager, token);
  const host = options.host ?? config.host;
  const port = options.port ?? config.port;
  let control: BackendControl;
  try {
    await server.listen(host, port);
    logs.append(`管理 API ${server.address()}`, "accent");
    control = {
      remote: false,
      status: () => manager.status(),
      settings: async () => manager.publicBackendSettings(),
      token: async () => manager.backendToken(),
      execute: async (action, settings) => {
        if (action === "configure") manager.updateBackendSettings(settings!);
        else if (action === "start") await manager.start();
        else if (action === "stop") await manager.stop();
        else await manager.restart();
      },
      dispose: async () => {
        try {
          await manager.stop();
        } finally {
          await server.close();
        }
      },
    };
  } catch (error) {
    await server.close();
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const dialHost =
      host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
    const base = `http://${dialHost.includes(":") ? `[${dialHost}]` : dialHost}:${port}`;
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(body === undefined ? 5_000 : 20_000),
      });
      if (!response.ok)
        throw new Error(
          `管理 API 返回 HTTP ${response.status}，请检查管理令牌和端口`,
        );
      return (await response.json()) as T;
    };
    // 只连接已配置且通过独立管理令牌验证的管理 API，不接管不明进程。
    await request<{ pid: number; nonce: string }>("/api/owner");
    logs.append(`已接入现有管理器 ${base}；退出不会停止它的后端`, "accent");
    logs.append(
      "此模式仅展示 TUI 操作记录；服务输出仍在原管理器的日志中",
      "warning",
    );
    control = {
      remote: true,
      status: () => request<ServiceStatus>("/api/status"),
      settings: () => request<Record<string, string>>("/api/config"),
      token: async () =>
        (await request<{ backendToken?: string }>("/api/credentials"))
          .backendToken,
      execute: async (action, settings) => {
        await request(
          action === "configure" ? "/api/config" : `/api/service/${action}`,
          settings ?? {},
        );
      },
      dispose: async () => {},
    };
  }
  return new BackendConsole(control, logs, token);
}
