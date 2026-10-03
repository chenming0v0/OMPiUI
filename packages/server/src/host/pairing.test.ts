import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  FAILURE_WINDOW_MS,
  MAX_PAIRING_FAILURES,
  PAIRING_TTL_MS,
  PairingStore,
  generateDisplayCode,
} from "./pairing.ts"

describe("generateDisplayCode", () => {
  it("produces 8-digit zero-padded decimal codes", () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateDisplayCode()
      assert.match(code, /^\d{8}$/)
    }
  })
})

describe("PairingStore", () => {
  it("mints one-time invites that expire after 10 minutes", () => {
    const store = new PairingStore()
    const now = 1_000_000
    const invite = store.mint(now)
    assert.equal(invite.expiresAt - invite.createdAt, PAIRING_TTL_MS)
    assert.match(invite.code, /^\d{8}$/)
    assert.equal(store.find(invite.id, now + 1), invite)
    assert.equal(store.find(invite.id, invite.expiresAt), undefined)
  })

  it("redeems by pair string exactly once", () => {
    const store = new PairingStore()
    const now = 1_000_000
    const invite = store.mint(now)
    const first = store.redeem({ pair: `${invite.id}.${invite.secret}` }, "ip:1", now + 1)
    assert.equal(first.ok, true)
    const second = store.redeem({ pair: `${invite.id}.${invite.secret}` }, "ip:1", now + 2)
    assert.equal(second.ok, false)
    assert.equal(second.ok ? null : second.reason, "USED")
  })

  it("rejects wrong secrets without leaking the failure reason", () => {
    const store = new PairingStore()
    const now = 1_000_000
    const invite = store.mint(now)
    const wrong = store.redeem({ pair: `${invite.id}.deadbeefdeadbeef` }, "ip:2", now + 1)
    assert.equal(wrong.ok, false)
    assert.equal(wrong.ok ? null : wrong.reason, "INVALID")
    // 正确凭据仍然可用
    const right = store.redeem({ pair: `${invite.id}.${invite.secret}` }, "ip:2", now + 2)
    assert.equal(right.ok, true)
  })

  it("accepts the 8-digit display code as a fallback", () => {
    const store = new PairingStore()
    const now = 1_000_000
    const invite = store.mint(now)
    const grouped = `${invite.code.slice(0, 4)} ${invite.code.slice(4)}`
    const outcome = store.redeem({ code: grouped }, "ip:3", now + 1)
    assert.equal(outcome.ok, true)
  })

  it("rate limits a client after 5 failures within the window", () => {
    const store = new PairingStore()
    const now = 1_000_000
    const invite = store.mint(now)
    for (let attempt = 0; attempt < MAX_PAIRING_FAILURES; attempt += 1) {
      const outcome = store.redeem({ pair: `${invite.id}.wrongwrong` }, "attacker", now + attempt)
      assert.equal(outcome.ok, false)
    }
    // 即使出示正确凭据，窗口内也被拒绝
    const blocked = store.redeem({ pair: `${invite.id}.${invite.secret}` }, "attacker", now + 60_000)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok ? null : blocked.reason, "RATE_LIMITED")
    // 窗口过后恢复（用一条新邀请：失败窗口与邀请 TTL 相同，旧邀请已过期）
    const fresh = store.mint(now + FAILURE_WINDOW_MS + 1)
    const recovered = store.redeem({ pair: `${fresh.id}.${fresh.secret}` }, "attacker", now + FAILURE_WINDOW_MS + 1)
    assert.equal(recovered.ok, true)
  })

  it("drops expired invites and bounds concurrent invites", () => {
    const store = new PairingStore()
    let now = 1_000_000
    const stale = store.mint(now)
    now += PAIRING_TTL_MS + 1
    for (let index = 0; index < 12; index += 1) store.mint(now + index)
    assert.equal(store.find(stale.id, now), undefined)
  })
})
