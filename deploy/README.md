# OMPiUI 无桌面部署

OMPiUI 的**编程前端**（`packages/app`，浏览器/桌面里的聊天界面）和**管理平面**（`packages/admin`，TUI + 独立管理 Web UI）是分开的。管理平面负责后端进程生命周期、凭证、分享链接、监听与穿透配置，不碰会话功能。

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│ ompiui-admin（管理平面） │ ─管理→ │ ompiui-server（后端 8787）    │
│  TUI + 管理 Web :9898    │        │  编程前端由它静态托管          │
└─────────────────────────┘        └──────────────────────────────┘
```

- 管理平面默认只监听 `127.0.0.1:9898`，独立管理令牌（`~/.ompiui/admin-token`）。
- 后端默认监听 `127.0.0.1:8787`；要局域网/公网访问，在管理 UI 的「网络与穿透」里改监听地址并重启后端。
- 状态都在 `~/.ompiui/`（容器里是 `/data/ompiui/`）。

## 方式一：VPS 一键安装（systemd）

```bash
curl -fsSL https://raw.githubusercontent.com/chenming0v0/OMPiUI/dev/scripts/install-server.sh | bash
```

或在已有 checkout 里：

```bash
bash scripts/install-server.sh
```

脚本做这些事：克隆（仅裸机需要）→ `npm install` + 构建 → 生成管理令牌 → 注册 systemd 用户服务并启用 linger（登出不停服务）→ 打印管理地址和令牌。

装完后：

```bash
ssh -L 9898:127.0.0.1:9898 <user>@<server>   # 本机打开 http://127.0.0.1:9898
```

粘贴令牌进入管理 UI；或直接在服务器上跑 TUI：

```bash
~/.ompiui/app/packages/admin/dist/cli.js tui
```

TUI 里可以启动/停止/重启后端、查看凭证与分享链接；`Ctrl+C` 退出时若后端还在跑会提示如何接管。

## 方式二：Docker

```bash
git clone --depth 1 -b dev https://github.com/chenming0v0/OMPiUI.git
cd OMPiUI
docker compose -f deploy/docker-compose.yml up -d --build
```

容器里管理平面是 PID 1（`ompiui-admin web --host 0.0.0.0`），自带 HEALTHCHECK。容器内也可以用 TUI：

```bash
docker exec -it ompiui node packages/admin/dist/cli.js tui
docker exec ompiui node packages/admin/dist/cli.js status
```

管理令牌：`docker exec ompiui cat /data/ompiui/admin-token`（compose 默认把 9898 只绑到宿主机回环，走 SSH 隧道访问）。

## 凭证模型

| 凭证 | 用途 | 位置 |
| --- | --- | --- |
| 管理令牌 | 调管理 API / 登录管理 Web UI | `~/.ompiui/admin-token`（或 `OMPIUI_ADMIN_TOKEN`） |
| 后端访问令牌 | 编程前端连后端的 Bearer | `~/.ompiui/auth-token`（后端首次启动生成），管理 UI「凭证与链接」里查看 |

分享链接（`ompiui://connect?url=...&token=...`）把后端地址+访问令牌一起带给其它设备；管理 API 只在管理令牌鉴权后才返回凭证。

## 后续计划（未实现，勿当可用功能）

- 多用户/RBAC、审计日志、HTTPS 证书自动签发。
- 管理平面不负责 OMP provider 登录，那仍由 OMP 原生配置（`~/.omp/agent`）管理。
