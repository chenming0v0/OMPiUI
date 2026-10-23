import { randomUUID } from "node:crypto"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { OmpRpcError, unwrapResponse, type OmpRpcClient, type OmpRpcFrame, type OmpRpcResponse } from "./rpc-client.js"

const promptFlights = new WeakMap<OmpRpcClient, Promise<void>>()

/** Official RPC prompt ACK precedes setup. Slash commands retain their native
 * dispatch and use the correlated terminal result when no synchronous local
 * completion is declared. Never infer acceptance from an unrelated agent_start.
 */
export async function requestNativePromptAcceptance(client: OmpRpcClient, command: JsonObject, timeoutMs = 60_000): Promise<OmpRpcResponse> {
  const previous = promptFlights.get(client)
  let finish!: () => void
  const flight = new Promise<void>(resolve => { finish = resolve })
  promptFlights.set(client, flight)
  if (previous) await previous
  const id = typeof command.id === "string" ? command.id : `ompiui_prompt_${randomUUID()}`
  const message = typeof command.message === "string" ? command.message : ""
  const spaceIndex = message.indexOf(" ")
  const commandPath = message.startsWith("/") ? `command:${message.slice(1, spaceIndex < 0 ? undefined : spaceIndex)}` : undefined
  let commandError: OmpRpcError | undefined
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const onFrame = (frame: OmpRpcFrame) => {
    // Official extension dispatch reports a swallowed handler throw before its
    // correlated local completion. Helper flights prevent same-command overlap.
    if (commandPath && frame.type === "extension_error" && frame.event === "command" && frame.extensionPath === commandPath) {
      commandError = new OmpRpcError(typeof frame.error === "string" ? frame.error : "Native extension command failed", "SUBMISSION_NOT_ADMITTED")
      return
    }
    if (frame.type !== "prompt_result" || frame.id !== id) return
    if (commandError && frame.agentInvoked === false) reject(commandError)
    else if (frame.status === "error" && frame.agentInvoked === false) {
      const message = isJsonObject(frame.error) && typeof frame.error.message === "string" ? frame.error.message : "Native prompt was rejected"
      reject(new OmpRpcError(message, typeof frame.code === "string" ? frame.code : "SUBMISSION_NOT_ADMITTED"))
    } else if (frame.status === "aborted" && frame.agentInvoked === false) {
      reject(new OmpRpcError("Native prompt was aborted; your draft is preserved", "SUBMISSION_NOT_ADMITTED"))
    } else resolve()
  }
  const onExit = () => reject(new OmpRpcError("Official OMP exited before prompt acceptance was confirmed", "OMP_EXITED", "unknown"))
  client.on("frame", onFrame)
  client.on("exit", onExit)
  const timer = setTimeout(() => reject(new OmpRpcError("Native prompt result timed out; submission result unknown and draft preserved", "OMP_TIMEOUT", "unknown")), timeoutMs)
  timer.unref()
  void promise.catch(() => {})
  try {
    const response = await client.request({ ...command, id }, timeoutMs)
    const data = unwrapResponse(response)
    if (isJsonObject(data) && data.agentInvoked === false) {
      if (commandError) throw commandError
      return response
    }
    await promise
    return response
  } finally {
    clearTimeout(timer)
    client.off("frame", onFrame)
    client.off("exit", onExit)
    finish()
    if (promptFlights.get(client) === flight) promptFlights.delete(client)
  }
}
