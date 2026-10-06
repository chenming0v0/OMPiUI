# OMPiUI

**OMP 的第三方 Web/桌面客户端** — 界面沿用 [PiUI](https://github.com/lehhair/PiUI) 的视觉外壳，agent 执行由 [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) 的官方 RPC 运行时承担：60+ provider、31 个内置工具、子代理系统、MCP/LSP、扩展。

UI 来自 lehhair 的 [PiUI](https://github.com/lehhair/PiUI) 与 [OpenCodeUI](https://github.com/lehhair/OpenCodeUI)，感谢他的开发。OMPiUI 不是这两个项目的官方客户端。

## 要求

- Node ≥ 22.19、npm
- [OMP CLI](https://omp.sh) ≥ 18.2.11：`bun install -g @oh-my-pi/pi-coding-agent`（更老的 omp 缺少 `get_entries` 等 RPC 命令，打开会话时会提示升级）

## 快速开始

```bash
git clone https://github.com/chenming0v0/OMPiUI.git
cd OMPiUI
npm install
npm run build
npm run dev:server:omp   # 后端，默认 127.0.0.1:8787（tsx watch）
npm run dev:app          # 前端（Vite HMR）
```

生产模式单进程托管前端：

```bash
OMPIUI_DRIVER=omp node --import tsx packages/server/src/bundle-entry.ts web --host 127.0.0.1 --port 8787
# 浏览器打开控制台打印的 http://127.0.0.1:8787/?token=...
```

OMPiUI 读取 OMP 的原生配置（`~/.omp/agent/models.yml`、`config.yml`），不维护第二套 provider 凭据。

## 监听地址与远程访问

- 默认只监听 `127.0.0.1`。局域网用 `--host 0.0.0.0`（或 `OMPIUI_HOST=0.0.0.0`），设置页分享面板会给出局域网地址和 `ompiui://connect` 深链。
- 公网入口配置 `OMPIUI_PUBLIC_BASE_URL`（反代/隧道后的对外地址），分享链接和 Origin 校验都以它为准。
- 自建中转穿透：在任意有公网 IP 的机器上运行 `packages/relay`，服务主动拨号，NAT/防火墙后也能用，见 [docs/tunnel.md](docs/tunnel.md)。
- 无桌面 VPS / Docker：管理平面（TUI + 独立管理 Web UI）负责后端进程、凭证与穿透配置，一键安装见 [deploy/README.md](deploy/README.md)。
- 务必走 HTTPS：入口 token 首屏经 `?token=` 进入后立即从地址栏抹掉，之后只走 `Authorization` 头；拿到链接等于拿到这台机器。

## 常用环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OMPIUI_DRIVER` | `omp` | `omp`（真实 agent）/ `mock`（无 OMP 测试） |
| `OMPIUI_HOST` / `OMPIUI_PORT` | `127.0.0.1` / `8787` | 服务监听地址与端口 |
| `OMPIUI_PUBLIC_BASE_URL` | 空 | 公网基址，反代/隧道后必配 |
| `OMPIUI_AUTH_TOKEN` | 自动生成 | 后端 Bearer token，持久化在 `~/.ompiui/auth-token` |
| `OMPIUI_DATA_DIR` | `~/.ompiui` | 自身状态目录 |
| `OMPIUI_TUNNEL_URL` / `_KEY` / `_ID` | 空 | 自建中转的 WSS 地址、接入密钥与节点 ID |
| `VITE_OMPIUI_API` / `VITE_OMPIUI_TOKEN` | 空 | 浏览器构建期指定的后端地址/令牌 |
| `OMPIUI_ADMIN_TOKEN` / `_HOST` / `_PORT` | 自动生成 / `127.0.0.1` / `9898` | 管理平面的令牌与监听 |

## 服务设置

桌面/浏览器端「设置 → 服务」里可改网络监听、公网基址、隧道开关，并生成扫码配对与分享链接；服务器进程的启停、管理令牌和后端凭证在管理平面（见 [deploy/README.md](deploy/README.md)）。

个别 OpenAI 兼容网关对 OMP 的 `wait` 工具会返回 0-token 空响应；OMPiUI 拉起的每个 OMP 进程都会附加 `~/.ompiui/omp-compat.yml`（存在时），可在不影响 OMP CLI 的前提下覆盖，例如 `async.enabled: false`。

## 架构概览

```
app (React/Vite) ⇄ HTTP+WS ⇄ server (Node) ⇄ stdio JSONL ⇄ omp --mode rpc
```

- `packages/app` — PiUI 的 React 前端，数据源换成 OMP
- `packages/server` — HTTP + WebSocket 服务，托管前端静态文件并调度 worker
- `packages/omp-worker` — OMPiUI 核心：`omp --mode rpc` 协议客户端，会话/模型/子代理/扩展 UI 的 OMP 实现
- `packages/protocol` — 前后端消息协议
- `packages/relay` — 自建公网中转服务器
- `packages/admin` — 无桌面部署的管理平面（TUI + 管理 Web UI）

走 `omp --mode rpc` 而不是进程内 SDK，是因为 RPC 面是 OMP 官方钦定的跨进程嵌入协议——server 保持纯 Node，不受 OMP 内部重构影响。

## 开发和验证

```bash
npm run typecheck   # 全仓 tsc
npm test            # protocol / omp-worker / server / admin / app 测试
npm run lint        # app eslint
npm run build       # 全部构建
```

## 发版流程

```bash
npm run release:prepare -- <version>   # 升版本，提交留在 dev
# dev 合入 main 之后：
git tag v<version> origin/main && git push origin v<version>   # tag 触发桌面/移动端构建发布
```

## 许可证

GPL-3.0-only（继承 PiUI）。

## 开源推广

特别致谢：[LINUX DO](https://linux.do)
