#!/usr/bin/env node
const { createInterface } = require("node:readline")

createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line)
  const data = command.type === "get_available_models"
    ? { models: [{ id: "test-model", provider: "test" }] }
    : {}
  const rejected = command.type === "negotiate_protocol" && process.env.OMPIUI_TEST_CONTROL_REJECT === "1"
  process.stdout.write(JSON.stringify({
    type: "response", id: command.id, command: command.type, success: !rejected, data,
    ...(rejected ? { error: "test negotiation rejected" } : {}),
  }) + "\n")
})
process.stdout.write(JSON.stringify({ type: "ready" }) + "\n")
