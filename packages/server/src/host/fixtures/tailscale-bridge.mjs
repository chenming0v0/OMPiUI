import { createServer } from "node:http"

let running = process.argv.includes("--running")
const stateIndex = process.argv.indexOf("--state")
const state = stateIndex < 0 ? "NeedsLogin" : process.argv[stateIndex + 1]
let authUrl = ""
const token = process.env.OMPIUI_BRIDGE_TOKEN
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return }
  if (req.url === "/route" && req.method === "POST") {
    let raw = ""
    req.on("data", chunk => { raw += chunk })
    req.on("end", () => {
      const origin = JSON.parse(raw).origin
      if (!/^http:\/\/100\.101\./.test(origin)) json(res, 400, { error: "only Tailscale addresses are allowed" })
      else if (!running) json(res, 409, { error: "Tailscale is not running" })
      else json(res, 200, { url: "http://127.0.0.1:45001" })
    })
    return
  }
  if (req.url === "/discover" && req.method === "POST") {
    if (!running) json(res, 409, { error: `Tailscale discovery requires Running state (current: ${state}); start or sign in first` })
    else json(res, 200, [{ marker: "ompiui", discoveryVersion: 1, displayName: "Desk", instanceId: "b".repeat(32), port: 8787, pairing: true, address: "100.101.2.9" }])
    return
  }
  if (req.url === "/login" && req.method === "POST") authUrl = "https://login.tailscale.com/a/test-node"
  if (req.url === "/status") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      BackendState: running ? "Running" : state,
      AuthURL: running ? "" : authUrl,
      TailscaleIPs: running ? ["100.101.2.3"] : [],
      Self: { DNSName: "ompiui.example.ts.net." },
      Version: "1.104.1",
    }))
  } else { res.writeHead(204); res.end() }
})
server.listen(0, "127.0.0.1", () => {
  const ready = JSON.stringify({ event: "ready", controlAddr: `http://127.0.0.1:${server.address().port}` }) + "\n"
  process.stdout.write(ready.slice(0, 12))
  setTimeout(() => process.stdout.write(ready.slice(12)), 5)
})
process.stdin.resume()
process.stdin.on("end", () => server.close(() => process.exit(0)))
