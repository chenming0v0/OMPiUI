import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DSH_PAIRING_ROOT, DSH_REMOTE_ORIGIN, dshPairingFingerprint, dshPairingProof, dshPairingQr, dshRecord,
  parseDshPairingSession, parseDshPairingStatus,
  type DshIdentity, type DshPairingDevice, type DshPairingSession, type DshPairingState,
} from '@ompiui/protocol/dsh-remote'
import type { DshRemoteAccount } from './dsh-remote-account.ts'

export interface DshHostPairingView {
  state: DshPairingState
  expiresAt: number
  /** 二维码内容。手机扫走之后就不再给出。 */
  qr?: string
  /** 这台电脑的指纹；手机上显示的应当和它一样。 */
  fingerprint: string
  phone?: { name: string; fingerprint: string }
  failure?: string
  /** 验证码已经提交但没拿到结果：只能原样重发，不能换一个码。 */
  retry: boolean
}

const ACTIVE = new Set<DshPairingState>(['created', 'claimed', 'approved'])

interface Attempt {
  identity: DshIdentity
  session: DshPairingSession
  compactQr: boolean
  state: DshPairingState
  mobile: DshPairingDevice | null
  /** 已经发出去的确认请求原文。只留在内存里，配对一结束就清掉。 */
  submission?: string
  failure?: string
  adopted: boolean
  stop: AbortController
}

function pairingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * 电脑这一侧的扫码配对：出二维码，等手机扫码，再由人在本机界面输入手机上的 8 位验证码。
 *
 * 验证码只从本机管理入口进来，不写盘、不进日志；服务器的状态查询也不会把它返回给电脑。
 * 整段配对只在内存里：会话本来就只活三分钟，后端重启后重新出一个二维码即可。
 */
export class DshHostPairing {
  private attempt?: Attempt
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly account: DshRemoteAccount, private readonly onPaired: () => void,
    private readonly request: typeof fetch = fetch, private readonly pollMs = 2_500) {}

  view(): DshHostPairingView | null {
    const attempt = this.attempt
    if (!attempt) return null
    const overdue = (attempt.state === 'created' || attempt.state === 'claimed') && Date.now() > attempt.session.expiresAt
    const state = overdue ? 'expired' : attempt.state
    return {
      state, expiresAt: attempt.session.expiresAt,
      ...(state === 'created' ? { qr: dshPairingQr(attempt.session, attempt.compactQr) } : {}),
      fingerprint: dshPairingFingerprint(attempt.identity.identityKey),
      ...(attempt.mobile ? { phone: { name: attempt.mobile.name.replace(/\p{Cc}/gu, '').slice(0, 64), fingerprint: dshPairingFingerprint(attempt.mobile.identityKey) } } : {}),
      ...(attempt.failure ? { failure: attempt.failure } : {}),
      retry: attempt.submission !== undefined && ACTIVE.has(state),
    }
  }

  /** 出一个新的二维码；上一轮没结束的配对作废。 */
  start(): Promise<void> {
    return this.serial(async () => {
      await this.discard()
      const capabilities = dshRecord(dshRecord(await this.call('/api/v1/auth/oauth/providers', 'GET'))?.capabilities)
      if (capabilities?.devicePairing !== 'dsh-pairing-v1') {
        throw pairingError('DSH_PAIRING_UNSUPPORTED', 'DS Harness Remote does not offer scan pairing')
      }
      const { identity, device } = await this.account.pairingIdentity()
      const session = parseDshPairingSession(await this.call(DSH_PAIRING_ROOT, 'POST', JSON.stringify({ v: 1, device })))
      if (session.host.deviceId !== identity.deviceId || session.host.identityKey !== identity.identityKey || session.expiresAt <= Date.now()) {
        throw new Error('Invalid DS Harness Remote pairing session')
      }
      const attempt: Attempt = {
        identity, session, compactQr: capabilities.devicePairingQr === 'fragment-ticket-v1',
        state: 'created', mobile: null, adopted: false, stop: new AbortController(),
      }
      this.attempt = attempt
      void this.watch(attempt)
    })
  }

  /** 提交手机上显示的验证码。不带 code 表示原样重发上一次没拿到结果的提交。 */
  confirm(code?: string): Promise<void> {
    return this.serial(async () => {
      const attempt = this.attempt
      if (!attempt || !ACTIVE.has(attempt.state)) throw pairingError('DSH_PAIRING_CLOSED', 'This pairing has ended. Show a new code.')
      let raw = attempt.submission
      if (raw !== undefined) {
        if (code !== undefined) throw pairingError('DSH_PAIRING_ATTEMPT_USED', 'The code was already submitted. Retry it unchanged or show a new code.')
      } else {
        if (attempt.state !== 'claimed' || typeof code !== 'string' || !/^\d{8}$/.test(code)) {
          throw pairingError('DSH_PAIRING_CODE_INVALID', 'Scan the code with the phone first, then enter the 8 digits it shows')
        }
        // 发出去之前就把请求原文定死：只有一次机会，超时后只能原样重发，不能换一个码再试。
        raw = JSON.stringify({ submissionId: randomUUID(), verificationCode: code })
        attempt.submission = raw
      }
      await this.accept(attempt, await this.send(attempt, 'host/confirm', raw))
    })
  }

  /** 结束这一轮配对并收起界面上的结果。 */
  cancel(): Promise<void> {
    return this.serial(() => this.discard())
  }

  private async discard(): Promise<void> {
    const attempt = this.attempt
    this.attempt = undefined
    if (!attempt) return
    attempt.stop.abort()
    attempt.submission = undefined
    if (ACTIVE.has(attempt.state)) await this.send(attempt, 'host/cancel', '{}').catch(() => undefined)
  }

  private async watch(attempt: Attempt): Promise<void> {
    const signal = attempt.stop.signal
    while (!signal.aborted) {
      await delay(this.pollMs, undefined, { signal, ref: false }).catch(() => undefined)
      await this.serial(async () => {
        if (signal.aborted || this.attempt !== attempt) return
        try {
          // 验证码已通过、登记还没做完时，状态查询不会替我们完成：原样重发确认。
          const pending = attempt.state === 'approved' && attempt.submission !== undefined
          await this.accept(attempt, await this.send(attempt, pending ? 'host/confirm' : 'host/status', pending ? attempt.submission! : '{}'))
        } catch (error) {
          if ((error as { code?: string })?.code === 'DSH_PAIRING_NOT_FOUND') this.finish(attempt, 'expired')
          // 其它失败多半是网络抖动，下一轮再查。
        }
      }).catch(() => undefined)
    }
  }

  private async accept(attempt: Attempt, value: unknown): Promise<void> {
    const status = parseDshPairingStatus(value, attempt.session, 'host', attempt.identity, attempt.mobile)
    if (status.mobile) attempt.mobile = status.mobile
    if (status.state === 'completed' && !attempt.adopted) {
      if (!status.tokens) throw new Error('Invalid DS Harness Remote pairing credentials')
      await this.account.adoptPairing(attempt.identity, status.tokens)
      attempt.adopted = true
      this.onPaired()
    }
    attempt.failure = status.failureReason ?? undefined
    if (ACTIVE.has(status.state)) attempt.state = status.state
    else this.finish(attempt, status.state)
  }

  private finish(attempt: Attempt, state: DshPairingState): void {
    attempt.state = state
    attempt.submission = undefined
    attempt.stop.abort()
  }

  private send(attempt: Attempt, action: string, raw: string): Promise<unknown> {
    const path = `${DSH_PAIRING_ROOT}/${attempt.session.sessionId}/${action}`
    return this.call(path, 'POST', raw,
      dshPairingProof(attempt.identity.privateKey, attempt.session.serverPublicKey, attempt.session.sessionId, 'host', path, raw))
  }

  private async call(path: string, method: 'GET' | 'POST', body?: string, proof?: string): Promise<unknown> {
    const response = await this.request(`${DSH_REMOTE_ORIGIN}${path}`, {
      method, body, redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(proof ? { 'x-dsh-pairing-proof': proof } : {}) },
    }).catch(() => { throw pairingError('DSH_UNREACHABLE', 'Could not reach DS Harness Remote') })
    const value: unknown = await response.json().catch(() => null)
    if (response.ok) return value
    const code = dshRecord(dshRecord(value)?.error)?.code
    throw pairingError(response.status === 404 ? 'DSH_PAIRING_NOT_FOUND'
      : typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? `DSH_${code}` : 'DSH_PAIRING_FAILED',
    `DS Harness Remote rejected the pairing request (HTTP ${response.status})`)
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(action)
    this.queue = next
    return next
  }
}
