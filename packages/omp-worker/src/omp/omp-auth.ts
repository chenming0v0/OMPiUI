import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import type { ProviderAuthEvent, ProviderAuthPrompt } from "@ompiui/protocol"
import type { ProviderAuthGateway } from "../command-table.js"
import { OmpRpcClient, unwrapResponse } from "./rpc-client.js"

/**
 * OMP 认证网关 —— ProviderAuthGateway 的 OMP RPC 实现。
 *
 * OMP 的凭据体系（OAuth / API key）由 `~/.omp/agent` 的 agent.db + models.yml
 * 管理，RPC 暴露 get_login_providers / login（OAuth 输入以 extension_ui_request
 * 帧转发）。API key 直填（models.yml 编辑）不在 RPC 面上 —— 相关命令返回
 * CAPABILITY_DISABLED，设置页引导用户走 OMP CLI。
 */
export class OmpProviderAuth implements ProviderAuthGateway {
  private readonly listeners = new Set<(event: ProviderAuthEvent) => void>()
  private readonly flows = new Map<string, { providerId: string; client: OmpRpcClient }>()
  private boundClient: OmpRpcClient | undefined
  private invalidatePending = false

  constructor(private readonly acquire: () => Promise<OmpRpcClient>) {}

  onEvent(listener: (event: ProviderAuthEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: ProviderAuthEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private async ensureBound(): Promise<OmpRpcClient> {
    if (this.boundClient && !this.boundClient.hasExited) return this.boundClient
    const client = await this.acquire()
    client.on("frame", frame => this.handleFrame(client, frame))
    this.boundClient = client
    return client
  }

  /** 控制通道上的 extension_ui_request → 认证流提示（登录 OAuth 输入等） */
  private handleFrame(client: OmpRpcClient, frame: JsonObject): void {
    if (frame.type !== "extension_ui_request") return
    const method = typeof frame.method === "string" ? frame.method : ""
    const id = typeof frame.id === "string" ? frame.id : ""
    const flow = [...this.flows.entries()].find(([, item]) => item.client === client)
    if (!flow) return
    const [flowId, { providerId }] = flow
    const title = typeof frame.title === "string" ? frame.title : ""
    if (method === "open_url") {
      const url = typeof frame.url === "string" ? frame.url : ""
      this.emit({ type: "notification", flowId, providerId, event: { kind: "open_url", url } })
      client.writeExtensionUiResponse({ type: "extension_ui_response", id, value: "" })
      return
    }
    if (method === "input" || method === "select") {
      const prompt: ProviderAuthPrompt = {
        type: method === "select" ? "select" : "secret",
        message: title,
        options: Array.isArray(frame.options)
          ? frame.options.map((option, index) => ({
            id: String(index),
            label: String(option),
          }))
          : undefined,
      }
      // omp 帧 id 作为 promptId 透传，respond 时原样写回
      this.emit({ type: "prompt", flowId, promptId: id, providerId, prompt })
      return
    }
    if (method === "notify") {
      this.emit({ type: "notification", flowId, providerId, event: typeof frame.message === "string" ? frame.message : "" })
      client.writeExtensionUiResponse({ type: "extension_ui_response", id, value: "" })
    }
  }

  async listProviders(): Promise<JsonValue> {
    const client = await this.ensureBound()
    const response = await client.request({ type: "get_login_providers" }, 30_000)
    const data = unwrapResponse<JsonValue>(response)
    const providers = isJsonObject(data) && Array.isArray(data.providers) ? data.providers : Array.isArray(data) ? data : []
    // 前端契约（PiProviderAuthInfo）要求 methods/configured；OMP 的 login 是
    // 统一交互流程，映射成单个可用的登录方法，原始字段放进 status。
    return providers.filter(isJsonObject).map(provider => ({
      id: provider.id ?? provider.providerId ?? "",
      name: provider.name ?? provider.id ?? "",
      ...provider,
      methods: [{
        type: "oauth",
        name: "登录",
        loginAvailable: Boolean(provider.available),
      }],
      configured: Boolean(provider.authenticated),
      status: { authenticated: Boolean(provider.authenticated), available: Boolean(provider.available) },
    }))
  }

  listActiveFlows(): JsonValue {
    return [...this.flows.keys()].map(flowId => ({ flowId }))
  }

  async listModels(): Promise<JsonValue> {
    const client = await this.ensureBound()
    const response = await client.request({ type: "get_available_models" }, 60_000)
    const data = unwrapResponse<JsonValue>(response)
    return isJsonObject(data) && Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : []
  }

  async start(providerId: string, _authType: "api_key" | "oauth"): Promise<JsonValue> {
    const client = await this.ensureBound()
    const flowId = `omp-login-${randomUUID()}`
    this.flows.set(flowId, { providerId, client })
    // login 是异步流程：立即返回 flowId，结果经 provider.auth 事件通知
    void client.request({ type: "login", providerId }, 300_000).then(response => {
      this.finishFlow(flowId)
      if (response.success) {
        this.emit({ type: "completed", flowId, providerId })
      } else {
        this.emit({ type: "failed", flowId, providerId, message: response.error ?? "login failed" })
      }
    }).catch(error => {
      this.finishFlow(flowId)
      this.emit({ type: "failed", flowId, providerId, message: error instanceof Error ? error.message : String(error) })
    })
    return { flowId, providerId }
  }

  respond(flowId: string, promptId: string, value: string): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    // promptId 即 OMP extension_ui_request 帧 id，原样写回应答帧
    flow.client.writeExtensionUiResponse({ type: "extension_ui_response", id: promptId, value })
  }

  cancel(flowId: string): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    this.finishFlow(flowId)
    this.emit({ type: "cancelled", flowId, providerId: flow.providerId })
  }

  /**
   * models.yml 变更后由 watcher 调用：丢弃缓存的 bound client 并关掉旧
   * 进程（长驻 omp 只在启动时读 models.yml），下一次命令拉起新进程重读。
   * 有进行中的登录流时推迟到流结束——登录请求挂在当前进程上，立即作废
   * 会误伤 OAuth。
   */
  async invalidate(): Promise<void> {
    if (this.flows.size > 0) {
      this.invalidatePending = true
      return
    }
    await this.invalidateNow()
  }

  private async invalidateNow(): Promise<void> {
    this.invalidatePending = false
    const client = this.boundClient
    this.boundClient = undefined
    if (client) await client.close().catch(() => undefined)
  }

  /** 登录流结束的公共出口：流计数清零时放行挂起的作废请求 */
  private finishFlow(flowId: string): void {
    this.flows.delete(flowId)
    if (this.invalidatePending && this.flows.size === 0) void this.invalidateNow()
  }

  async logout(_providerId: string): Promise<void> {
    throw Object.assign(new Error("OMP 凭据请通过 OMP CLI（omp /login）或 ~/.omp/agent 配置管理"), {
      code: "CAPABILITY_DISABLED",
    })
  }

  async inspect(): Promise<JsonValue> {
    // 返回体必须满足前端的 PiModelRuntimeSnapshot 契约（providers/models/
    // availableModels 为必填数组），缺字段会让设置页渲染时直接崩掉。
    let models: JsonValue = []
    try {
      models = await this.listModels()
    } catch {
      /* models listing best effort */
    }
    return {
      providers: [],
      models,
      availableModels: Array.isArray(models) ? models : [],
      registeredProviderIds: [],
      registeredProviderConfigs: {},
      note: "OMP provider 配置来自 ~/.omp/agent/models.yml（web 端只读）",
    }
  }

  async setRuntimeApiKey(_providerId: string, _apiKey: string): Promise<void> {
    throw Object.assign(new Error("运行时 API key 请通过 OMP CLI（--api-key）或 models.yml 管理"), {
      code: "CAPABILITY_DISABLED",
    })
  }

  async removeRuntimeApiKey(_providerId: string): Promise<void> {
    throw Object.assign(new Error("OMP 凭据请通过 OMP CLI 管理"), { code: "CAPABILITY_DISABLED" })
  }

  async reloadConfig(): Promise<void> {
    // 长驻进程不会因 models.yml 改动而重读（config.yml 才有进程内热加载）：
    // 只是对同一进程再发一次 get_available_models 拿到的还是旧列表。先作废
    // bound client，ensureBound 拉起新进程，这次查询才能看到新增模型。
    await this.invalidate()
    const client = await this.ensureBound()
    await client.request({ type: "get_available_models" }, 60_000).catch(() => undefined)
  }

  async refresh(_options?: JsonObject): Promise<JsonValue> {
    await this.reloadConfig()
    return { refreshed: true }
  }
}
