import assert from "node:assert/strict"
import test from "node:test"
import { parseTrustedProxies, resolveForwardedClient } from "./trusted-proxy.ts"

test("untrusted left prefixes cannot change an append-proxy client identity", () => {
  const trusted = parseTrustedProxies(["127.0.0.1", "10.0.0.0/8"])
  for (const header of [
    "198.51.100.7", "bogus, 198.51.100.7", "6.6.6.6, 198.51.100.7",
    "bogus, 198.51.100.7, 10.1.2.3",
  ]) assert.equal(resolveForwardedClient(header, trusted), "198.51.100.7")
  assert.equal(resolveForwardedClient("198.51.100.7, bogus", trusted), null)
  assert.equal(resolveForwardedClient(["198.51.100.7"], trusted), null)
})
