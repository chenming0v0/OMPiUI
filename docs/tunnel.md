# 自建中转（内网穿透）部署指南

OMPiUI 的「自建中转」是一个**反向隧道**：家里的电脑不需要公网 IP、不开端口转发、不管在不在 NAT/防火墙后面，都会**主动拨号**到你自己部署在中转服务器（VPS）上的 `omp-relay`，并保持一条加密的 WebSocket 控制连接。手机和外部浏览器直接打开中转的公网地址，就像访问一个普通网站一样使用 OMPiUI——读写工作区、开终端、跑 agent。

```
手机浏览器 / OMPiUI App
   │  HTTPS + WSS（公网，现有 token 鉴权不变）
   ▼
omp-relay（你的 VPS，packages/relay）
   │  控制连接 wss://relay/_tunnel（电脑端主动拨出，断线自动重连）
   ▼
OMPiUI server（你的电脑，packages/server 内嵌隧道客户端）
   └→ omp-worker → OMP（全部照旧，本地回环）
```

这套协议的形态参考了 [Pebrel](https://github.com/Kuddev/pebrel) 的「自建中转」：接入密钥只存 SHA-256 摘要、重复接入拒绝、30s 心跳探活、指数退避重连、无存储转发。OMPiUI 前端（SPA）是标准的浏览器页面，走同源请求，所以**经中转访问时前端零改动**。

## 1. 部署中转（VPS）

要求：Node.js ≥ 22.19。把仓库克隆到 VPS（或只拷贝 `packages/relay`），然后：

```bash
npm install
npm run build -w @ompiui/relay
npm run relay:init -- --port 8443          # 生成 ./relay.config.json + 43 字符接入密钥
node packages/relay/dist/cli.js start      # 或 npm run relay -- start
```

`relay.config.json`（保持 `chmod 600`，里面是密钥明文；服务端运行时只保留 SHA-256 摘要）：

```json
{
  "port": 8443,
  "host": "127.0.0.1",
  "tunnels": [{ "id": "ompiui", "key": "<43 字符 base64url>" }]
}
```

`init` 结束时会打印三行 `OMPIUI_TUNNEL_*`，下一步直接粘贴。

### 1.1 TLS 方案 A：Caddy 反代（推荐，有域名）

`host` 保持 `127.0.0.1`，让 Caddy 监听 443 并自动签发证书。`Caddyfile`：

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:8443
}
```

然后把 `relay.config.json` 加一行 `"publicUrl": "https://relay.example.com"`，重启 omp-relay——桌面端和分享链接会宣传这个地址。

### 1.2 TLS 方案 B：裸 IP / 内置证书

没有域名时两种做法：

- **直连 IP + 端口**：把配置改成 `"host": "0.0.0.0"`，并在 `tls` 里给出证书（自签也可，浏览器端会有告警）：

  ```json
  {
    "port": 8443,
    "host": "0.0.0.0",
    "tls": { "cert": "/etc/ompiui-relay/full.pem", "key": "/etc/ompiui-relay/key.pem" },
    "tunnels": [{ "id": "ompiui", "key": "…" }]
  }
  ```

  对应的中转地址是 `wss://<VPS-IP>:8443`。
- **纯测试/内网中转**：`tls` 缺省即为 HTTP（监听 `127.0.0.1`），只建议放在反代后面或临时验证。

### 1.3 Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY packages/relay/package.json packages/relay/package.json
COPY packages/relay/dist packages/relay/dist
RUN cd packages/relay && npm install --omit=dev
CMD ["node", "packages/relay/dist/cli.js", "start", "--config", "/data/relay.config.json"]
```

把 `relay.config.json` 挂到 `/data/`，映射 `8443` 端口即可。

### 1.4 多条隧道（可选）

一台中转可以服务多台电脑：给每台电脑一条 `{ id, key }`。路由规则：

- 某条隧道配置了 `"host": "pc1.relay.example.com"` → 该主机名的流量只进这条隧道（需要给每个子域解析 + 证书，Caddy on-demand TLS 可以自动化）。
- 配置了顶层 `"domain": "relay.example.com"` → `Host: <id>.relay.example.com` 自动路由到对应 ID 的隧道。
- **什么都没配** → 单隧道模式：所有流量进唯一在线的那条隧道（个人使用开箱即用）。一旦配置了任何显式路由，未匹配的 Host 会被拒绝（不静默兜底）。

## 2. 配置 OMPiUI（你的电脑）

拿到 `init` 打印的三行后：

- **桌面端（Tauri）**：设置 → 服务 → 内网穿透（自建中转），填入中转地址 / 接入密钥 / 隧道 ID，重启服务。
- **命令行**：

  ```bash
  OMPIUI_TUNNEL_URL=wss://relay.example.com \
  OMPIUI_TUNNEL_KEY=<key> \
  OMPIUI_TUNNEL_ID=ompiui \
  node packages/server/dist/bundle-entry.js web
  ```

  （等价 CLI：`--tunnel-url` / `--tunnel-key` / `--tunnel-id`。）

服务启动后会打印 `relay tunnel: dialing …`；隧道连上后打印 `[ompiui-tunnel] public entry https://…`。设置页的隧道状态会显示「已连接，公网入口」，**分享面板的地址自动切换为中转公网地址**，手机浏览器打开该地址（或复制 `ompiui://connect` 深链给 OMPiUI App）即可。

中转断了会自动重连（500ms 起指数退避，上限 15 秒）；电脑离线期间中转对新请求返回 502 `TUNNEL_OFFLINE`，不会积压。

## 3. 安全模型（读一遍再用）

- **端到端业务鉴权不变**：所有 API/WS 仍然要求 OMPiUI 访问令牌（token），中转本身不发放权限。隧道开启不会降低服务端的鉴权要求。
- **中转是可信方**（与 Pebrel v1、Caddy/frp 同一信任级别）：TLS 在中转终结，中转进程和 VPS 管理员理论上能看到流量内容——包括你贴进去的代码。**只使用自己部署、自己掌控的中转**；不要把中转地址和接入密钥交给不信任的人。
- **接入密钥 = 注册权**：拿到 key 的人可以把自己的机器冒充为这条隧道（中转会拒绝重复 ID，先到先得）。密钥只存 SHA-256 摘要，泄露时在 `relay.config.json` 换掉 key 并重启 omp-relay 即可吊销。
- **拿到公网地址 + token = 拿到这台电脑**：可以读写工作区、开终端、运行命令、驱动 agent。用强 token，不用时在设置里关掉隧道（服务重启即可）。
- 中转的并发连接（64/隧道）、帧大小（64KiB）、消息速率（100/s）有内置限额，异常流量会断开重连而不是拖垮电脑端。

## 4. 工作原理（给好奇的人）

- 每个公网 HTTP 请求被中转翻译成控制连接上的一条「虚拟连接」：`open`（方法/路径/头，注入 `x-forwarded-*`，剥离逐跳头）→ 二进制帧流（请求体）→ 桌面端对本机 `127.0.0.1:port` 重放请求 → `head`/二进制帧流/`end` 回传。
- WebSocket（事件流、终端流）原样透传：101 握手头保真，之后两侧 socket 纯字节拼接，中转不解析内容。
- 背压：任一方向 `bufferedAmount` 越过 1MiB 高水位即暂停源流，回落 256KiB 恢复，防止大输出把内存打爆。
- Origin 校验：服务端自动把中转公网入口加进允许列表（显式配置的 `OMPIUI_PUBLIC_BASE_URL` 优先级更高），跨域 POST 和 WS 升级才能通过。
