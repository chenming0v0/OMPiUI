import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { LogBuffer } from "@ompiui/tui";
import {
  generateTunnelKey,
  validateRelayConfig,
  type RelayConfig,
} from "./config.ts";
import { startRelay, type RunningRelay } from "./relay.ts";

export class RelayManager {
  readonly path: string;
  readonly logs: LogBuffer;
  private config: RelayConfig | null = null;
  private original = "";
  private running: RunningRelay | undefined;
  private activeConfig: RelayConfig | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
    this.logs = new LogBuffer(() => [
      ...(this.config?.tunnels.map((tunnel) => tunnel.key) ?? []),
      ...(this.activeConfig?.tunnels.map((tunnel) => tunnel.key) ?? []),
    ]);
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.path)) {
      this.config = null;
      this.original = "";
      return;
    }
    const original = readFileSync(this.path, "utf8");
    const config = validateRelayConfig(JSON.parse(original), this.path);
    this.config = config;
    this.original = original;
  }

  getConfig(): RelayConfig | null {
    return this.config ? structuredClone(this.config) : null;
  }

  status() {
    return {
      running: Boolean(this.running),
      port: this.running?.port ?? this.config?.port ?? 8443,
      pending: Boolean(
        this.running &&
        JSON.stringify(this.activeConfig) !== JSON.stringify(this.config),
      ),
      tunnels:
        this.running?.tunnelStatus() ??
        this.config?.tunnels.map((tunnel) => ({
          id: tunnel.id,
          online: false,
          connections: 0,
        })) ??
        [],
    };
  }

  private serialize<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  private save(raw: RelayConfig, initial = false): void {
    const next = validateRelayConfig(raw, this.path);
    if (initial && existsSync(this.path))
      throw new Error("配置文件已经存在，请重新读取配置");
    if (
      !initial &&
      (!existsSync(this.path) ||
        readFileSync(this.path, "utf8") !== this.original)
    ) {
      throw new Error("配置文件已在外部修改，请重新读取后再编辑");
    }
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
    this.config = next;
    this.original = content;
  }

  initialize(values: Record<string, string>): Promise<void> {
    return this.serialize(() => {
      this.save(
        {
          host: values.host || "127.0.0.1",
          port: Number(values.port || "8443"),
          publicUrl: values.publicUrl || undefined,
          tunnels: [{ id: values.id || "ompiui", key: generateTunnelKey() }],
        },
        true,
      );
      this.logs.append("中转配置已创建；接入密钥请在凭证页查看", "success");
    });
  }

  configure(values: Record<string, string>): Promise<void> {
    return this.serialize(() => {
      if (!this.config) throw new Error("请先创建中转配置");
      if (Boolean(values.cert?.trim()) !== Boolean(values.tlsKey?.trim()))
        throw new Error("TLS 证书和私钥路径必须同时填写");
      this.save({
        ...this.config,
        host: values.host.trim(),
        port: Number(values.port),
        publicUrl: values.publicUrl?.trim() || undefined,
        domain: values.domain?.trim() || undefined,
        tls: values.cert?.trim()
          ? { cert: values.cert.trim(), key: values.tlsKey!.trim() }
          : undefined,
      });
      this.logs.append("中转监听与路由配置已保存", "accent");
    });
  }

  addTunnel(values: Record<string, string>): Promise<void> {
    return this.serialize(() => {
      if (!this.config) throw new Error("请先创建中转配置");
      this.save({
        ...this.config,
        tunnels: [
          ...this.config.tunnels,
          {
            id: values.id!.trim(),
            key: generateTunnelKey(),
            host: values.host?.trim() || undefined,
          },
        ],
      });
      this.logs.append(`已添加隧道 ${values.id}`, "success");
    });
  }

  editTunnel(id: string, values: Record<string, string>): Promise<void> {
    return this.serialize(() => {
      if (!this.config?.tunnels.some((tunnel) => tunnel.id === id))
        throw new Error("所选隧道已不存在");
      this.save({
        ...this.config,
        tunnels: this.config.tunnels.map((tunnel) =>
          tunnel.id === id
            ? {
                ...tunnel,
                id: values.id!.trim(),
                host: values.host?.trim() || undefined,
              }
            : tunnel,
        ),
      });
      this.logs.append(`隧道 ${id} 路由已更新；重启后生效`, "accent");
    });
  }

  removeTunnel(id: string): Promise<void> {
    return this.serialize(() => {
      if (!this.config?.tunnels.some((tunnel) => tunnel.id === id))
        throw new Error("所选隧道已不存在");
      if (this.config.tunnels.length === 1)
        throw new Error("必须保留至少一条隧道");
      this.save({
        ...this.config,
        tunnels: this.config.tunnels.filter((tunnel) => tunnel.id !== id),
      });
      this.logs.append(`已删除隧道 ${id} 的配置；重启后生效`, "warning");
    });
  }

  rotateKey(id: string): Promise<void> {
    return this.serialize(() => {
      if (!this.config?.tunnels.some((tunnel) => tunnel.id === id))
        throw new Error("所选隧道已不存在");
      this.save({
        ...this.config,
        tunnels: this.config.tunnels.map((tunnel) =>
          tunnel.id === id ? { ...tunnel, key: generateTunnelKey() } : tunnel,
        ),
      });
      this.logs.append(`隧道 ${id} 密钥已轮换；重启后旧密钥失效`, "warning");
    });
  }

  private async startOwned(): Promise<void> {
    if (this.running) return;
    this.reload();
    if (!this.config) throw new Error("请先创建中转配置");
    const config = structuredClone(this.config);
    this.running = await startRelay({
      config,
      log: (line) => this.logs.append(line),
    });
    this.activeConfig = config;
  }

  private async stopOwned(): Promise<void> {
    if (!this.running) return;
    await this.running.close();
    this.running = undefined;
    this.activeConfig = undefined;
    this.logs.append("中转服务已停止", "warning");
  }

  start(): Promise<void> {
    return this.serialize(() => this.startOwned());
  }
  stop(): Promise<void> {
    return this.serialize(() => this.stopOwned());
  }
  restart(): Promise<void> {
    return this.serialize(async () => {
      // 在停止正在运行的服务前先校验磁盘配置，避免坏配置造成无谓断连。
      this.reload();
      if (!this.config) throw new Error("中转配置不存在");
      await this.stopOwned();
      await this.startOwned();
    });
  }

  disconnect(id: string): Promise<void> {
    return this.serialize(() => {
      if (!this.running?.disconnectTunnel(id))
        throw new Error("所选隧道当前没有在线连接");
      this.logs.append(
        `已断开隧道 ${id}；桌面端仍可用当前密钥重新连接`,
        "warning",
      );
    });
  }

  reloadConfig(): Promise<void> {
    return this.serialize(() => {
      this.reload();
      this.logs.append("已重新读取配置", "accent");
    });
  }
}
