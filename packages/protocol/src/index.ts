export * from "./version.js"
export * from "./json.js"
export * from "./json-schema.js"
export * from "./problem.js"
export * from "./commands.js"
export * from "./pi-command-specs.js"
export * from "./host-command-specs.js"
export * from "./validate-params.js"
export * from "./envelope.js"
export * from "./registry.js"
export * from "./workspace.js"
export * from "./git.js"
export * from "./extension-ui.js"
export * from "./session-page.js"
export * from "./provider-auth.js"
export * from "./terminal.js"

export type HealthResponse = {
  ok: true
  protocolVersion: typeof import("./version.js").PROTOCOL_VERSION
  service: "ompiui-server"
  piSdkVersion: string
  piSdkVerified?: boolean
  piSdkFallback?: { source: string; message: string } | null
  processId?: number
}

/**
 * Share info for letting another client reach this server. Only served to
 * authenticated callers: anyone who can read it already holds the token.
 */
export type ShareInfo = {
  /** Base URL other clients should use. */
  url: string
  /** Bearer token they must present. */
  token: string
  /** ompiui://connect link carrying both, pasteable in the add-server form. */
  link: string
  /** True when the server is reachable beyond this machine. */
  lan: boolean
  /**
   * True when `url` comes from the configured public base URL
   * (OMPIUI_PUBLIC_BASE_URL / --public-base-url) instead of a LAN address —
   * implies the operator fronted the server with a reverse proxy or tunnel.
   */
  public?: boolean
  /** Present when the self-hosted relay tunnel is configured. */
  tunnel?: {
    /** The tunnel control channel is currently connected to the relay. */
    connected: boolean
    /** Public entry URL reported by the relay; present once connected. */
    publicUrl?: string
    /** The configured relay control URL (wss://…). */
    relayUrl?: string
  }
}

/**
 * Runtime status of the embedded relay tunnel client (self-hosted relay /
 * 反向隧道). Served by GET /api/v1/host/tunnel to authenticated callers.
 */
export type TunnelStatus = {
  /** True when a relay URL + key are configured (regardless of connection). */
  enabled: boolean
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "error"
  /** Relay control URL the client dials out to. */
  relayUrl: string | null
  /** Tunnel id registered at the relay. */
  tunnelId: string | null
  /** Public entry URL reported by the relay once connected. */
  publicUrl: string | null
  lastError: string | null
  /** Consecutive failed dials since the last successful connection. */
  reconnectAttempts: number
}

/**
 * One-time pairing invitation (手机远程扫码配对). Minted by the desktop UI,
 * redeemed exactly once by the phone before `expiresAt`.
 */
export type PairInviteInfo = {
  id: string
  /** 8-digit display code (manual entry fallback). */
  code: string
  /** `<id>.<secret>` carried in the QR / full invite link. */
  pair: string
  /** Unix ms when the invitation stops being redeemable. */
  expiresAt: number
  redeemed: boolean
}

export type PairRedeemResult = {
  /** Base URL the phone should keep using. */
  url: string
  token: string
  link: string
}

/** IPv4 interface reachable from other devices (手机远程 网卡选择)。 */
export type LanInterfaceInfo = {
  name: string
  address: string
  tailscale: boolean
}

/** Embedded/installed Tailscale client state (GET /api/v1/host/tailscale)。 */
export type TailscaleInfo = {
  platform: string
  /** Platform has an embeddable Tailscale distribution. */
  supported: boolean
  installed: boolean
  /** `tailscale status` 可以连上 daemon（服务在跑）。 */
  reachable: boolean
  cliPath: string | null
  installState: "idle" | "downloading" | "installing" | "done" | "error"
  installProgress: number | null
  installError: string | null
  /** tailscaled backend state: Running / NeedsLogin / null (not reachable). */
  backendState: string | null
  authUrl: string | null
  loginPending: boolean
  ips: string[]
  hostName: string | null
  version: string | null
}
export * from "./diagnostics.js"
