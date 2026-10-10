import { createServer } from "node:http"

let running = process.argv.includes("--running")
let authUrl = ""
const token = process.env.OMPIUI_BRIDGE_TOKEN
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return }
  if (req.url === "/login" && req.method === "POST") authUrl = "https://login.tailscale.com/a/test-node"
  if (req.url === "/status") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      BackendState: running ? "Running" : "NeedsLogin",
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
