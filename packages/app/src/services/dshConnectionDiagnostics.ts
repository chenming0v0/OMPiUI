const MAX_ENTRIES = 500

export type DshDiagnosticEvent =
  | 'host_list.request'
  | 'host_list.success'
  | 'host_list.failure'
  | 'connect.start'
  | 'connect.device_lookup.start'
  | 'connect.device_lookup.success'
  | 'connect.device_lookup.failure'
  | 'connect.websocket.start'
  | 'connect.websocket.open'
  | 'connect.websocket.failure'
  | 'connect.hello.sent'
  | 'connect.hello.ack'
  | 'connect.hello.failure'
  | 'connect.request.sent'
  | 'connect.request.accepted'
  | 'connect.request.rejected'
  | 'connect.handshake.complete'
  | 'connect.rpc.describe.start'
  | 'connect.rpc.describe.success'
  | 'connect.rpc.describe.failure'
  | 'connect.rpc.web_open.start'
  | 'connect.rpc.web_open.success'
  | 'connect.rpc.web_open.failure'
  | 'connect.success'
  | 'connect.failure'
  | 'connect.socket.closed'

export interface DshDiagnosticEntry {
  time: string
  event: DshDiagnosticEvent
  attemptId?: string
  durationMs?: number
  status?: number
  code?: string
  closeCode?: number
  closeReason?: string
  hostCount?: number
  onlineCount?: number
  offlineCount?: number
  unknownCount?: number
}

const entries: DshDiagnosticEntry[] = []
const SAFE_CODES = new Set([
  'DSH_AUTH_INVALID', 'DSH_DEVICE_REVOKED', 'HOST_OFFLINE', 'HOST_BUSY', 'HOST_UNAUTHORIZED',
  'DSH_UNREACHABLE', 'PROTOCOL', 'LEASE_FAILED', 'REQUEST_ABORTED', 'TIMEOUT', 'TypeError', 'Error', 'INTERNAL', 'RATE_LIMITED',
])
const SAFE_CLOSE_REASONS = new Set([
  'AUTH_INVALID', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'DEVICE_REVOKED', 'ALREADY_CONNECTED',
  'CONNECTION_REPLACED', 'CONNECTION_FAILED', 'RATE_LIMITED', 'HELLO_TIMEOUT', 'UNSUPPORTED_VERSION',
  'INVALID_MESSAGE', 'MEMBERSHIP_REQUIRED', 'CAPABILITY_NOT_SUPPORTED', 'CONNECTION_LIMIT_REACHED', 'SERVER_SHUTDOWN',
])

/** Keep connection diagnostics in memory only; never record names, IDs, URLs, tokens or error text. */
export function recordDshDiagnostic(event: DshDiagnosticEvent, fields: Omit<DshDiagnosticEntry, 'time' | 'event'> = {}): void {
  const entry: DshDiagnosticEntry = { time: new Date().toISOString(), event }
  if (fields.attemptId && /^[0-9a-f-]{36}$/i.test(fields.attemptId)) entry.attemptId = fields.attemptId
  if (Number.isFinite(fields.durationMs)) entry.durationMs = Math.max(0, Math.round(fields.durationMs!))
  if (Number.isInteger(fields.status)) entry.status = fields.status
  if (fields.code && SAFE_CODES.has(fields.code)) entry.code = fields.code
  if (Number.isInteger(fields.closeCode)) entry.closeCode = fields.closeCode
  const closeReason = fields.closeReason?.trim().toUpperCase().replaceAll(' ', '_')
  if (closeReason && SAFE_CLOSE_REASONS.has(closeReason)) entry.closeReason = closeReason
  for (const key of ['hostCount', 'onlineCount', 'offlineCount', 'unknownCount'] as const) {
    const value = fields[key]
    if (Number.isInteger(value) && value! >= 0) entry[key] = value
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function exportDshDiagnostics(): string {
  return [
    'OMPiUI DS Remote connection diagnostics',
    `App version: ${__APP_VERSION__}`,
    `Exported at: ${new Date().toISOString()}`,
    'Scope: this app process only; latest 500 events. No host names, device IDs, URLs, credentials or session content.',
    ...entries.map(entry => JSON.stringify(entry)),
    '',
  ].join('\n')
}
