import { WebSocket } from "ws";

/** 心跳独立预留一个在途帧；积压期间只保留最新 ping，避免数据水位误断整条隧道。 */
export function createPongSender(ws: WebSocket): (data: Buffer) => void {
  let sending = false;
  let pending: Buffer | undefined;
  const send = (data: Buffer): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (sending) {
      pending = data;
      return;
    }
    sending = true;
    ws.pong(data, undefined, error => {
      sending = false;
      const next = pending;
      pending = undefined;
      if (!error && next) send(next);
    });
  };
  ws.once("close", () => { pending = undefined; });
  return send;
}
