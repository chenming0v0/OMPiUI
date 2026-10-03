/**
 * 手机远程扫码配对（一次性邀请）。
 *
 * 语义对齐 Pebrel 的 pairing：邀请 10 分钟有效、只能兑换一次；桌面端展示
 * 8 位数字码，二维码/完整链接里携带 `<id>.<secret>`；手机端 redeem 成功后
 * 服务端才把真正的访问令牌交出去——二维码被旁观截图也不会造成持久泄露，
 * 过期/已用的邀请一律拒绝。
 *
 * 无鉴权兑换端点必须有频控：按客户端 IP 记失败次数，10 分钟窗口内最多
 * 5 次失败（与 Pebrel 的 ≤5 次尝试一致）。
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto"

export const PAIRING_TTL_MS = 10 * 60 * 1000
export const MAX_PAIRING_FAILURES = 5
export const FAILURE_WINDOW_MS = 10 * 60 * 1000
/** 同时存活的邀请上限：避免桌面端反复「换一个」撑大内存。 */
export const MAX_ACTIVE_INVITES = 8

export type PairRedeemFailure = "INVALID" | "EXPIRED" | "USED" | "RATE_LIMITED"

export interface PairingInvite {
  id: string
  secret: string
  code: string
  createdAt: number
  expiresAt: number
  redeemed: boolean
  redeemedBy: string | null
}

export type PairRedeemInput = { pair?: string; code?: string }

export type PairRedeemOutcome =
  | { ok: true; invite: PairingInvite }
  | { ok: false; reason: PairRedeemFailure }

/** 展示码：8 位数字，拒绝采样避免模偏差（对齐 Pebrel 的做法）。 */
export function generateDisplayCode(random = randomInt): string {
  const bound = Math.floor(0x1_0000_0000 / 100_000_000) * 100_000_000
  let value = random(0, 0xffffffff)
  while (value >= bound) value = random(0, 0xffffffff)
  return String(value % 100_000_000).padStart(8, "0")
}

export class PairingStore {
  private readonly invites = new Map<string, PairingInvite>()
  private readonly failures = new Map<string, { count: number; resetAt: number }>()

  /** 生成一条新邀请；顺手清理过期项并限制并发存量。 */
  mint(now = Date.now()): PairingInvite {
    this.prune(now)
    while (this.invites.size >= MAX_ACTIVE_INVITES) {
      const oldest = this.invites.keys().next().value
      if (oldest === undefined) break
      this.invites.delete(oldest)
    }
    const invite: PairingInvite = {
      id: randomBytes(4).toString("hex"),
      secret: randomBytes(8).toString("hex"),
      code: generateDisplayCode(),
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      redeemed: false,
      redeemedBy: null,
    }
    this.invites.set(invite.id, invite)
    return invite
  }

  find(id: string, now = Date.now()): PairingInvite | undefined {
    const invite = this.invites.get(id)
    if (!invite) return undefined
    if (now >= invite.expiresAt) return undefined
    return invite
  }

  /**
   * 兑换：`pair`（`<id>.<secret>`，QR 携带）优先，8 位数字码兜底（手机端
   * 已指向本服务时的手动输入）。命中后立即标记已用——竞态下第二次兑换
   * 拿到 USED。
   */
  redeem(input: PairRedeemInput, clientKey: string, now = Date.now()): PairRedeemOutcome {
    this.prune(now)
    if (!this.allowAttempt(clientKey, now)) return { ok: false, reason: "RATE_LIMITED" }
    const invite = this.resolve(input)
    const failure = (): { ok: false; reason: PairRedeemFailure } => {
      this.recordFailure(clientKey, now)
      if (this.failures.get(clientKey)!.count >= MAX_PAIRING_FAILURES) {
        return { ok: false, reason: "RATE_LIMITED" }
      }
      // 未达限速阈值时统一报 INVALID，不向攻击者区分「码对但过期」
      return { ok: false, reason: "INVALID" }
    }
    if (!invite) return failure()
    if (now >= invite.expiresAt) return failure()
    if (invite.redeemed) return { ok: false, reason: "USED" }
    invite.redeemed = true
    invite.redeemedBy = clientKey
    return { ok: true, invite }
  }

  /** 命中限速的客户端在窗口结束前一律拒绝。 */
  isRateLimited(clientKey: string, now = Date.now()): boolean {
    return !this.allowAttempt(clientKey, now)
  }

  private resolve(input: PairRedeemInput): PairingInvite | undefined {
    const pair = input.pair?.trim() ?? ""
    const dot = pair.indexOf(".")
    if (dot > 0) {
      const id = pair.slice(0, dot)
      const secret = pair.slice(dot + 1)
      const invite = this.invites.get(id)
      if (!invite) return undefined
      const left = Buffer.from(secret, "utf8")
      const right = Buffer.from(invite.secret, "utf8")
      if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined
      return invite
    }
    const code = input.code?.replace(/\D/g, "") ?? ""
    if (code.length !== 8) return undefined
    for (const invite of this.invites.values()) {
      const left = Buffer.from(code, "utf8")
      const right = Buffer.from(invite.code, "utf8")
      if (left.length === right.length && timingSafeEqual(left, right)) return invite
    }
    return undefined
  }

  private allowAttempt(clientKey: string, now: number): boolean {
    const entry = this.failures.get(clientKey)
    if (!entry) return true
    if (now >= entry.resetAt) {
      this.failures.delete(clientKey)
      return true
    }
    return entry.count < MAX_PAIRING_FAILURES
  }

  private recordFailure(clientKey: string, now: number): void {
    const entry = this.failures.get(clientKey)
    if (!entry || now >= entry.resetAt) {
      this.failures.set(clientKey, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
      return
    }
    entry.count += 1
  }

  private prune(now: number): void {
    for (const [id, invite] of this.invites) {
      if (now >= invite.expiresAt) this.invites.delete(id)
    }
    for (const [key, entry] of this.failures) {
      if (now >= entry.resetAt) this.failures.delete(key)
    }
  }
}
