import type { Problem } from "./problem.js"

export const TERMINAL_STREAM_PROTOCOL_VERSION = 2 as const

export type TerminalStatus = "running" | "exited"

export type TerminalShell = {
  path: string
  name: string
  acceptable: boolean
}

export type TerminalInfo = {
  id: string
  title: string
  shell: string
  cwd: string
  status: TerminalStatus
  pid: number
  exitCode?: number | null
  nativeSessionId?: string
  sessionFile?: string
  ompCommand?: "play" | "stream"
  cursor: number
}

export type TerminalCreateParams = {
  cwd?: string
  shell?: string
  title?: string
  rows?: number
  cols?: number
  nativeSessionId?: string
  ompCommand?: "play" | "stream"
}

export type TerminalUpdateParams = {
  title?: string
  rows?: number
  cols?: number
}

export type TerminalStreamClientFrame =
  | { type: "input"; data: string; inputId?: number }
  | { type: "resize"; rows: number; cols: number }
  | { type: "output_ack"; cursor: number }
  | { type: "ping"; protocolVersion: typeof TERMINAL_STREAM_PROTOCOL_VERSION | 1 }

export type TerminalStreamServerFrame =
  | {
      type: "hello"
      protocolVersion: typeof TERMINAL_STREAM_PROTOCOL_VERSION
      terminal: TerminalInfo
      cursor: number
      inputAck?: true
      outputAck?: true
    }
  | { type: "output"; cursor: number; data: string }
  | { type: "title"; title: string }
  | { type: "ready"; cursor: number }
  | { type: "input_ack"; inputId: number; accepted: true }
  | { type: "input_ack"; inputId: number; accepted: false; retryAfterMs: number }
  | { type: "exit"; cursor: number; exitCode: number | null }
  | { type: "pong"; protocolVersion: typeof TERMINAL_STREAM_PROTOCOL_VERSION; t: number }
  | { type: "problem"; problem: Problem }
