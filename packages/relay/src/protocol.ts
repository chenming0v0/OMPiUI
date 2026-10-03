/**
 * 中转线协议（桌面隧道客户端 ⇄ 中转服务端）。
 *
 * 形态参考 Pebrel 的 relay：两端都是 WebSocket 客户端、按角色配对、无存储
 * 转发；在这里「角色」是唯一的 desktop（每个隧道一条控制连接），公网访客
 * 走普通 HTTP(S)，由中转翻译成控制连接上的虚拟连接。
 *
 * 帧：
 * - 文本帧 = 一条 JSON 控制消息（ControlFrame）。
 * - 二进制帧 = [u32 BE connId][payload ≤64KiB]，方向即语义：
 *   relay→desktop 是请求体，desktop→relay 是响应体。
 * - 每条 WebSocket message 恰好是一个隧道帧（发送方负责按 64KiB 切块）。
 *
 * 客户端侧的镜像实现见 packages/server/src/tunnel/protocol.ts——两处常量
 * 必须一致，靠 ready.v 握手兜底版本漂移。
 */

/** 控制通道升级路径（公网侧其余路径全部视为访客流量）。 */
export const CONTROL_PATH = "/_tunnel"

/** 单条二进制帧 payload 上限：发送方按此切块，接收方超限即断开。 */
export const FRAME_PAYLOAD_MAX = 64 * 1024

/** 单条控制消息（JSON 文本帧）上限：open/head 携带完整请求/响应头。 */
export const CONTROL_MESSAGE_MAX = 256 * 1024

/** 每条隧道的并发虚拟连接上限（Pebrel 同类限额的精神）。 */
export const CONNECTIONS_PER_TUNNEL_MAX = 64

/** 每条隧道持续消息速率上限：令牌桶容量 200、每秒回填 100。 */
export const MESSAGE_RATE_PER_SECOND = 100
export const MESSAGE_RATE_BURST = 200

/** 背压水位：对端 ws.bufferedAmount 越线暂停源流，回落恢复。 */
export const BACKPRESSURE_HIGH_WATER = 1024 * 1024
export const BACKPRESSURE_LOW_WATER = 256 * 1024

/** 心跳间隔；连续一个周期无 pong 视为死链（Pebrel 用 30s）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** 重连退避：500ms × 2ⁿ，上限 15s，叠加抖动（对齐 Pebrel）。 */
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 15_000

/** ws 关闭码：语义化拒绝，桌面端据此决定提示文案。 */
export const CLOSE_DUPLICATE = 4001
export const CLOSE_UNAUTHORIZED = 4003
export const CLOSE_RATE_LIMITED = 4008

/** 线协议版本：ready.v 携带，客户端不一致即断开重连（退避后仍不一致则报错）。 */
export const WIRE_VERSION = 1

export type ControlFrame =
  | { type: "ready"; v: number; tunnel: string; publicUrl: string | null }
  | { type: "open"; c: number; m: string; u: string; h: Record<string, string> }
  | { type: "head"; c: number; s: number; h: Record<string, string> }
  | { type: "reqEnd"; c: number }
  | { type: "end"; c: number }
  | { type: "fail"; c: number; e?: string }
  | { type: "abort"; c: number }
  | { type: "close"; c: number }

export type ControlFrameType = ControlFrame["type"]

/**
 * 逐跳头：只属于单段 HTTP 连接，跨隧道转发必须剥离。upgrade 透传时
 * connection/upgrade 要保留（101 握手依赖它们）。
 */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

export function stripHopByHopHeaders(
  headers: Record<string, string | string[] | undefined>,
  keepUpgrade = false,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    // upgrade 透传：connection + upgrade 是 101 握手的一部分，必须原样带到对端
    if (keepUpgrade && (lower === "upgrade" || lower === "connection")) {
      result[lower] = Array.isArray(value) ? value.join(", ") : value
      continue
    }
    if (HOP_BY_HOP_HEADERS.includes(lower)) continue
    result[lower] = Array.isArray(value) ? value.join(", ") : value
  }
  return result
}

/** [u32 BE connId][payload] 编码为一条 ws 二进制消息。 */
export function encodeFrameHeader(connId: number): Buffer {
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(connId >>> 0, 0)
  return header
}

/** 把任意长度的 body 切成 ≤FRAME_PAYLOAD_MAX 的帧（头 + 载荷拼成整条消息）。 */
export function encodeFrameMessages(connId: number, chunk: Buffer): Buffer[] {
  const messages: Buffer[] = []
  for (let offset = 0; offset < chunk.length; offset += FRAME_PAYLOAD_MAX) {
    const payload = chunk.subarray(offset, Math.min(offset + FRAME_PAYLOAD_MAX, chunk.length))
    const message = Buffer.concat([encodeFrameHeader(connId), payload])
    messages.push(message)
  }
  return messages
}

/** 解一条 ws 二进制消息；格式非法返回 null（调用方按协议违例断开）。 */
export function decodeFrameMessage(raw: Buffer): { connId: number; payload: Buffer } | null {
  if (raw.length < 4 || raw.length - 4 > FRAME_PAYLOAD_MAX) return null
  return { connId: raw.readUInt32BE(0), payload: raw.subarray(4) }
}

/** 响应头的手工序列化（upgrade 场景绕过 ServerResponse 直写 socket）。 */
export function serializeRawHead(status: number, headers: Record<string, string>): Buffer {
  let head = `HTTP/1.1 ${status}\r\n`
  for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`
  return Buffer.from(`${head}\r\n`, "utf8")
}

/**
 * 中转拒绝页（对齐 server 的 problem 形态）：浏览器里至少能看到结构化
 * 的 code，而不是干巴巴的 502。
 */
export function relayProblemBody(code: string, message: string): string {
  return JSON.stringify({ code, message })
}
