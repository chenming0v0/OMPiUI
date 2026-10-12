import type {
  ConsoleAction,
  ConsoleAdapter,
  ConsoleData,
  ConsoleField,
  ConsoleView,
} from "@ompiui/tui";
import { RelayManager } from "./tui-manager.ts";
import type { RelayConfig, RelayTunnelConfig } from "./config.ts";

export function relayPublicUrl(
  config: RelayConfig,
  tunnel?: RelayTunnelConfig,
): string {
  const hostname =
    tunnel?.host ||
    (config.domain && tunnel ? `${tunnel.id}.${config.domain}` : undefined);
  if (hostname) {
    if (!config.publicUrl) return "";
    const url = new URL(config.publicUrl);
    url.hostname = hostname;
    return url.origin;
  }
  return config.publicUrl || "";
}

export class RelayConsole implements ConsoleAdapter {
  constructor(readonly manager: RelayManager) {}

  async read(): Promise<ConsoleData> {
    const config = this.manager.getConfig();
    const status = this.manager.status();
    const online = status.tunnels.filter((tunnel) => tunnel.online).length;
    const active = status.tunnels.reduce(
      (total, tunnel) => total + tunnel.connections,
      0,
    );
    const summary = status.running
      ? status.pending
        ? "待重启"
        : "运行中"
      : "已停止";
    const actions: ConsoleAction[] = [
      {
        id: "start",
        label: "启动中转",
        key: "s",
        disabled: status.running || !config,
      },
      {
        id: "stop",
        label: "停止中转",
        key: "x",
        tone: "danger",
        disabled: !status.running,
        confirm: "停止中转会断开所有手机和桌面连接。继续吗？",
      },
      {
        id: "restart",
        label: "重启中转",
        key: "r",
        tone: "warning",
        disabled: !config,
        confirm: "重启会断开当前连接，并使新配置和新密钥生效。继续吗？",
      },
      { id: "reload", label: "重新读取配置", key: "f" },
    ];
    const initialize: ConsoleAction = {
      id: "initialize",
      label: "创建中转配置",
      key: "n",
      fields: [
        { key: "host", label: "监听地址", value: "127.0.0.1" },
        { key: "port", label: "监听端口", value: "8443" },
        { key: "id", label: "第一条隧道 ID", value: "ompiui" },
        { key: "publicUrl", label: "公网入口", optional: true },
      ],
    };
    const fields: ConsoleField[] = [
      { key: "host", label: "监听地址", value: config?.host || "127.0.0.1" },
      { key: "port", label: "监听端口", value: String(config?.port ?? 8443) },
      {
        key: "publicUrl",
        label: "公网入口",
        value: config?.publicUrl,
        optional: true,
      },
      {
        key: "domain",
        label: "子域路由后缀",
        value: config?.domain,
        optional: true,
      },
      {
        key: "cert",
        label: "TLS 证书路径",
        value: config?.tls?.cert,
        optional: true,
      },
      {
        key: "tlsKey",
        label: "TLS 私钥路径",
        value: config?.tls?.key,
        optional: true,
      },
    ];
    const views: ConsoleView[] = [
      {
        id: "overview",
        label: "概览",
        caption: status.pending
          ? "配置已变更 / 重启后生效"
          : "自建公网中转 / 反向连接",
        rows: [
          {
            id: "status",
            label: "服务状态",
            value: summary,
            tone: status.running
              ? status.pending
                ? "warning"
                : "success"
              : "neutral",
          },
          {
            id: "listen",
            label: "监听地址",
            value: `${config?.tls ? "https" : "http"}://${config?.host || "127.0.0.1"}:${status.port}`,
          },
          {
            id: "online",
            label: "在线隧道",
            value: `${online} / ${config?.tunnels.length ?? 0}`,
            tone: online ? "success" : "neutral",
          },
          { id: "connections", label: "转发连接", value: String(active) },
          {
            id: "public",
            label: "公网入口",
            value: config?.publicUrl || "未配置",
          },
          {
            id: "tls",
            label: "TLS",
            value: config?.tls ? "内置证书" : "由外部 HTTPS 反代提供",
            tone: config?.tls ? "success" : "warning",
          },
          { id: "file", label: "配置文件", value: this.manager.path },
        ],
        actions: config ? actions : [initialize],
      },
      {
        id: "tunnels",
        label: "隧道",
        caption: status.pending
          ? "待重启 / 在线状态来自当前运行配置"
          : "桌面端主动连接 / 手机从公网入口访问",
        rows:
          config?.tunnels.map((tunnel) => {
            const live = status.tunnels.find((item) => item.id === tunnel.id);
            return {
              id: tunnel.id,
              label: tunnel.id,
              value: `${live?.online ? "在线" : "离线"}    ${live?.connections ?? 0} 个连接`,
              tone: live?.online ? ("success" as const) : ("neutral" as const),
              detail:
                relayPublicUrl(config, tunnel) ||
                "公网入口由桌面连接时的 Host 推导",
            };
          }) ?? [],
        empty: "尚未创建中转配置",
        actions: config
          ? [
              {
                id: "add",
                label: "添加隧道",
                key: "a",
                fields: [
                  { key: "id", label: "隧道 ID" },
                  { key: "host", label: "专用公网主机名", optional: true },
                ],
              },
              {
                id: "edit",
                label: "编辑所选隧道",
                key: "e",
                target: true,
                fieldsByTarget: Object.fromEntries(
                  config.tunnels.map((tunnel) => [
                    tunnel.id,
                    [
                      { key: "id", label: "隧道 ID", value: tunnel.id },
                      {
                        key: "host",
                        label: "专用公网主机名",
                        value: tunnel.host,
                        optional: true,
                      },
                    ],
                  ]),
                ),
              },
              {
                id: "disconnect",
                label: "断开所选隧道",
                key: "d",
                tone: "warning",
                target: true,
                confirm:
                  "断开所选隧道会中断当前转发；桌面端仍可自动重连。继续吗？",
                disabled: !status.running,
              },
              {
                id: "rotate",
                label: "轮换所选密钥",
                key: "w",
                tone: "warning",
                target: true,
                confirm:
                  "轮换后需要重启中转，并在对应电脑更新接入密钥。继续吗？",
              },
              {
                id: "remove",
                label: "删除所选隧道",
                key: "z",
                tone: "danger",
                target: true,
                confirm:
                  "删除所选隧道配置后，重启会撤销这台电脑的接入。继续吗？",
                disabled: config.tunnels.length < 2,
              },
              ...actions,
            ]
          : [initialize],
      },
      {
        id: "network",
        label: "监听与路由",
        caption: "配置保存后重启中转生效",
        rows: [
          { id: "host", label: "监听地址", value: config?.host || "127.0.0.1" },
          {
            id: "port",
            label: "监听端口",
            value: String(config?.port ?? 8443),
          },
          {
            id: "publicUrl",
            label: "公网入口",
            value: config?.publicUrl || "-",
          },
          { id: "domain", label: "子域后缀", value: config?.domain || "-" },
          { id: "cert", label: "TLS 证书", value: config?.tls?.cert || "-" },
          { id: "key", label: "TLS 私钥路径", value: config?.tls?.key || "-" },
        ],
        actions: config
          ? [
              { id: "configure", label: "编辑配置", key: "e", fields },
              ...actions,
            ]
          : [initialize],
      },
      {
        id: "credentials",
        label: "接入凭证",
        caption: "配置到桌面端 / 此密钥不替代后端访问令牌",
        rows:
          config?.tunnels.map((tunnel) => ({
            id: tunnel.id,
            label: tunnel.id,
            value: tunnel.key,
            secret: true,
            detail: `OMPIUI_TUNNEL_ID=${tunnel.id}   ${
              config.publicUrl
                ? `OMPIUI_TUNNEL_URL=${config.publicUrl.replace(/^http/, "ws")}`
                : "请配置中转公网地址"
            }`,
          })) ?? [],
        empty: "尚未生成接入密钥",
        actions: config
          ? [
              {
                id: "reveal",
                label: "显示或隐藏密钥",
                key: "v",
                tone: "warning",
              },
              {
                id: "rotate",
                label: "轮换所选密钥",
                key: "w",
                target: true,
                tone: "warning",
                confirm:
                  "新密钥需要同步到对应电脑；重启中转后旧密钥失效。继续吗？",
              },
            ]
          : [initialize],
      },
      {
        id: "logs",
        label: "运行日志",
        caption: "",
        rows: [],
        actions: config ? actions : [initialize],
      },
    ];
    return {
      name: "Relay",
      subtitle: "REVERSE TUNNEL",
      status: summary,
      tone: status.running
        ? status.pending
          ? "warning"
          : "success"
        : "neutral",
      endpoint: this.manager.path,
      ownedRunning: status.running,
      views,
      logs: this.manager.logs.read(),
    };
  }

  async execute(
    action: string,
    values: Record<string, string>,
    target?: string,
  ): Promise<string> {
    switch (action) {
      case "initialize":
        await this.manager.initialize(values);
        return "中转配置已创建";
      case "configure":
        await this.manager.configure(values);
        return "配置已保存，重启后生效";
      case "add":
        await this.manager.addTunnel(values);
        return "隧道已添加；接入凭证可在凭证页查看，重启后生效";
      case "edit":
        await this.manager.editTunnel(target!, values);
        return "隧道路由已保存，重启后生效";
      case "remove":
        await this.manager.removeTunnel(target!);
        return "隧道已删除，重启后生效";
      case "rotate":
        await this.manager.rotateKey(target!);
        return "密钥已轮换，请更新电脑配置并重启中转";
      case "disconnect":
        await this.manager.disconnect(target!);
        return "隧道已断开，桌面端可自动重连";
      case "start":
        await this.manager.start();
        return "中转已启动";
      case "stop":
        await this.manager.stop();
        return "中转已停止";
      case "restart":
        await this.manager.restart();
        return "中转已重启";
      case "reload":
        await this.manager.reloadConfig();
        return "配置已重新读取";
      default:
        throw new Error("未知中转操作");
    }
  }

  dispose(): Promise<void> {
    return this.manager.stop();
  }
}
