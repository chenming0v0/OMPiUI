# OMPiUI

**OMP 的第三方 Web/桌面客户端** — PiUI 的视觉外壳 + OMP 的官方 RPC 运行时。

OMPiUI 把 [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) 的完整 agent 能力（60+ provider、31 个内置工具、子代理系统、MCP/LSP、扩展）装进一个浏览器可用的图形界面。界面资产来自 [lehhair](https://github.com/lehhair) 的开源客户端，agent 执行完全由 OMP 承担。

## 致谢

UI 来自 [lehhair](https://github.com/lehhair) 的这两个项目，非常感谢 lehhair 的开发：

- [PiUI](https://github.com/lehhair/PiUI) — Web/桌面视觉外壳：会话列表、聊天流、markdown/代码高亮、设置中心等
- [OpenCodeUI](https://github.com/lehhair/OpenCodeUI) — 子代理等界面设计，例如 SubSessionView

OMPiUI 不是这两个项目的官方客户端。

```
┌──────────────┐  HTTP+WS   ┌──────────────┐  spawn    ┌─────────────────┐
│  packages/app │ ◄────────► │ packages/     │ ◄───────► │  omp --mode rpc │
│  (React/Vite) │  pi.event  │ omp-worker    │  stdio    │  (oh-my-pi)     │
│  PiUI 视觉外壳 │  omp.sub-  │ packages/     │  JSONL    │  会话/工具/子代理 │
│              │  agent 等   │ server (Node) │  协议 v2   │                 │
└──────────────┘            └──────────────┘            └─────────────────┘
```

## 架构

- **`packages/app`** — PiUI 的 React 前端（全量保留：session 列表、聊天流、markdown/代码高亮、思考块渲染、diff 视图、设置中心），仅把数据源换成 OMP。
- **`packages/server`** — Node HTTP + WebSocket 服务，托管前端静态文件并调度 worker。
- **`packages/omp-worker`** — **OMPiUI 的核心**：`SessionRuntime`/`CatalogProvider` 契约的 OMP 实现。
  - [`omp/rpc-client.ts`](packages/omp-worker/src/omp/rpc-client.ts) — `omp --mode rpc` 官方协议客户端（协议 v2 分帧协商、`rpc_chunk` 无损重组、请求关联）。
  - [`omp/omp-session.ts`](packages/omp-worker/src/omp/omp-session.ts) — 每个会话一个 OMP 子进程：事件流适配（`auto_compaction_*`→`compaction_*`、`session_settled`→`agent_settled`）、`get_entries` 播种+`since` 增量的内存历史、活跃分支计算。
  - **子代理通道** — `set_subagent_subscription events` 订阅 `subagent_lifecycle/progress/event` 帧，经新增的 `omp.subagent` WS 通道直达前端；`parentToolCallId` 与主时间线的 task 工具调用精确关联。
  - [`omp/omp-catalog.ts`](packages/omp-worker/src/omp/omp-catalog.ts) — 磁盘目录：扫描 `~/.omp/agent/sessions/**/*.jsonl`（title/session 头解析）实现会话列表/预览/删除；模型列表走短生命周期控制 RPC 进程。
  - [`omp/omp-extension-ui.ts`](packages/omp-worker/src/omp/omp-extension-ui.ts) — 扩展 UI 桥：`extension_ui_request` 帧 ↔ PiUI 的对话框宿主（select/confirm/input/editor/notify/widget）。
- **`packages/protocol`** — 前后端消息协议（新增 `omp.subagent` 事件通道）。

## 已实现（对接 OMP）

- 真实对话：流式文本/思考增量、工具调用时间线、上下文用量表、`steer`/`follow_up` 排队、中止
- 会话管理：磁盘列表（跨工作区）、恢复（`switch_session`）、新会话、重命名、删除、预览
- 模型：`get_available_models`/`set_model`/`cycle_model`/思考档位（`~/.omp/agent/models.yml` 的全部 provider 直读）
- **子代理**：task 工具卡片内联实时转录（进度点、工具数/token 计数、工具徽标流、子代理消息迷你流、结构化结果）—— PiUI 原本没有的 UI，设计对齐 OpenCodeUI 的 SubSessionView
- 扩展 UI：OMP 扩展的对话框/状态/widget 桥接
- 压缩、自动重试、bash、导出 HTML 等 RPC 支持的操作

## 运行

要求：Node ≥ 22.19、npm、[OMP CLI](https://omp.sh) **≥ 18.2.11**（`bun install -g @oh-my-pi/pi-coding-agent`）。更老的 omp 缺少 `get_entries` 等 RPC 命令，打开会话时会直接报错提示升级。

```bash
npm install
npm run build          # protocol → omp-worker → server → app
npm run dev:server:omp # OMPIUI_DRIVER=omp 启动 server（tsx watch）
npm run dev:app        # Vite 前端（HMR）
```

生产模式（单进程托管静态文件）：

```bash
OMPIUI_DRIVER=omp node --import tsx packages/server/src/bundle-entry.ts web --host 127.0.0.1 --port 8787
# 浏览器打开控制台打印的 http://127.0.0.1:8787/?token=...
```

OMPiUI 读取 OMP 的原生配置（`~/.omp/agent/models.yml`、`config.yml`），不维护第二套 provider 凭据。

### 远程访问与公网分享

默认只监听本机（`127.0.0.1`）。局域网分享用 `--host 0.0.0.0`（或 `OMPIUI_HOST=0.0.0.0`），设置页的分享面板会给出浏览器可直接打开的地址和 `ompiui://connect` 深链。

**公网访问**：局域网地址在公网不可达，需要反向代理或隧道把一个对外入口指到本服务。配置入口地址后，分享链接、启动日志和 Origin 校验都以它为准，不再猜测第一块网卡：

```bash
OMPIUI_PUBLIC_BASE_URL=https://panel.example.com OMPIUI_DRIVER=omp \
  node --import tsx packages/server/src/bundle-entry.ts web --host 127.0.0.1 --port 8787
# 桌面端也可以在 设置 → 服务 → 网络监听 里填写「公网基址」
```

- **务必走 HTTPS**：入口 token 首屏经 `?token=` 进入（进入后立即从地址栏抹掉，之后只走 `Authorization` 头），明文 HTTP 会把 token 暴露给路径上的所有节点。
- 反向代理建议保留原始 `Host` 头（nginx `proxy_set_header Host $host`）；如果代理重写了 `Host`，Origin 校验也会放行 `OMPIUI_PUBLIC_BASE_URL` 的域名。
- **拿到链接 = 拿到这台机器**：可以读写工作区、开终端、运行命令、驱动 agent。请使用强访问令牌，只在可信通道分享，不用时及时轮换。

### 网关兼容开关

个别 OpenAI 兼容网关（Anthropic 翻译层）对 OMP 的 `wait` 工具 schema 会返回 0-token 空响应。OMPiUI 拉起的每个 OMP 进程都会附加 `~/.ompiui/omp-compat.yml`（存在时），可以在**不影响 OMP CLI** 的前提下做覆盖，例如：

```yaml
async:
  enabled: false   # 从默认工具集移除 wait（launch.enabled 同理）
launch:
  enabled: false
```

## 设计决策：为什么走 RPC 而不是进程内 SDK

PiUI 原本在 worker 进程内直接 import Pi SDK（`@earendil-works/pi-*`，锁 0.84.2）。OMP 18.x 的进程内 API 已与 Pi 大幅分化且要求 Bun 运行时；而 `omp --mode rpc` 是 OMP 官方文档钦定的跨进程嵌入面（稳定 JSONL 协议、协议版本协商、>1MiB 分帧、子代理/扩展 UI/host-tool 子协议全都在 RPC 面上）。基于 RPC 的包装让 OMPiUI 的 server 保持纯 Node、不受 OMP 内部重构影响，也正是"把 OMP 包装成 SDK"的那一层。

app 侧对该 SDK 只有过 type-only 引用；这些类型已按 SDK 0.84.2 的声明结构内联到 `packages/app/src/omp/vendor/*`，依赖随之从 app 的 package.json 移除，桌面打包不再需要安装 Pi SDK。

## License

GPL-3.0-only（继承 PiUI）。
