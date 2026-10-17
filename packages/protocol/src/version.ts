export const PROTOCOL_VERSION = 3 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** 历史 adapter 快照的 OMP 兼容基线，不代表实际安装的 CLI 版本。 */
export const OMP_RUNTIME_BASELINE_VERSION = "18.3.1" as const;

export const DEFAULT_HTTP_BASE = "http://127.0.0.1:8787";
export const DEFAULT_HOST_WS_URL = "ws://127.0.0.1:8787";
export const EVENT_WS_SUBPROTOCOL = "ompiui.events.v3";
