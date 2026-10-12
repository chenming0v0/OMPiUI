# 开发与实现

本文记录源码结构、运行配置与开发流程。产品介绍和上手入口见 [README](../README.md)，终端操作见 [TUI 使用指南](tui.md)。

## 源码结构

```text
app (React/Vite) <-> HTTP + WebSocket <-> server (Node)
                                         |
                                    omp-worker
                                         |
                                     stdio JSONL
                                         |
                                     omp --mode rpc
```

| 目录 | 职责 |
| --- | --- |
| `packages/app` | 浏览器与 Tauri 桌面、移动端界面 |
| `packages/server` | HTTP/WebSocket、静态前端托管和 worker 调度 |
| `packages/omp-worker` | OMP RPC 客户端，以及会话、模型、子代理和扩展 UI 的适配 |
| `packages/protocol` | 前后端消息协议 |
| `packages/admin` | 后端管理器、独立管理 API/Web UI 和后端 TUI 适配 |
| `packages/relay` | 自建公网中转和中转 TUI 适配 |
| `packages/tui` | 两套管理器共用的全屏终端界面 |

OMPiUI 通过官方 `omp --mode rpc` 跨进程调用 OMP，而不是在 Node 服务中嵌入 Agent SDK。OMP 负责执行编程任务；OMPiUI 负责界面、连接和运行时协调。

OMP 原生模型与凭据配置来自 `~/.omp/agent/models.yml`、`config.yml`。会话目录必须与官方终端保持互通；浏览和刷新不能触发 Agent 或写入历史，约束见根目录 [AGENTS.md](../AGENTS.md)。

## TUI 实现

共享组件使用 React 与 Ink 渲染，输入表单使用 `ink-text-input`。`ConsoleAdapter` 将不同管理器的状态、页面、字段和动作转换为统一的终端数据。

- `packages/tui/src/controller.ts`：状态刷新、动作执行、确认、表单和关闭流程。
- `packages/tui/src/shell.tsx`、`content.tsx`、`dialogs.tsx`：终端布局、页面和命令面板。
- `packages/tui/src/logs.ts`：有界日志缓冲与敏感信息脱敏。
- `packages/tui/src/run.tsx`：交互终端检测、备用屏幕与信号清理。
- `packages/admin/src/tui-adapter.ts`：连接已有管理器，或建立本地管理 API；退出只清理自己拥有的服务。
- `packages/relay/src/tui-manager.ts`：序列化配置与启停操作，保存前检查外部修改；已保存配置与运行中配置分开，重启后生效。

打开或刷新 TUI 不自动启动后端、中转或编程会话。服务启停来自明确的用户动作；中转 TUI 不扫描或接管独立中转进程。

## 运行配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OMPIUI_DRIVER` | `omp` | `omp` 执行真实任务；`mock` 用于隔离验证 |
| `OMPIUI_HOST` / `OMPIUI_PORT` | `127.0.0.1` / `8787` | 后端监听地址与端口 |
| `OMPIUI_PUBLIC_BASE_URL` | 空 | 反向代理或隧道后的公网基址 |
| `OMPIUI_AUTH_TOKEN` | 自动生成 | 后端 Bearer token，默认持久化到 `~/.ompiui/auth-token` |
| `OMPIUI_DATA_DIR` | `~/.ompiui` | OMPiUI 自身状态目录，不是 OMP 原生会话目录 |
| `OMPIUI_TUNNEL_URL` / `OMPIUI_TUNNEL_KEY` / `OMPIUI_TUNNEL_ID` | 空 | 自建中转地址、密钥与节点 ID |
| `VITE_OMPIUI_API` / `VITE_OMPIUI_TOKEN` | 空 | 浏览器构建时指定后端地址与令牌 |
| `OMPIUI_ADMIN_TOKEN` / `OMPIUI_ADMIN_HOST` / `OMPIUI_ADMIN_PORT` | 自动生成 / `127.0.0.1` / `9898` | 管理令牌与监听地址 |

公网基址同时用于分享地址和 Origin 校验。入口链接中的 `?token=` 会在首屏读取后移出地址栏，后续请求使用 `Authorization`；公开分享链接前必须移除真实令牌。

个别 OpenAI 兼容网关对 OMP 的 `wait` 工具会返回 0-token 空响应。OMPiUI 启动的 OMP 进程会附加 `~/.ompiui/omp-compat.yml`（存在时），可使用 `async.enabled: false` 等覆盖项，而不修改官方 CLI 配置。

## 开发与验证

```bash
npm install
npm run build
npm run dev:server:omp
# 另开一个终端：
npm run dev:app
```

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

TUI 的定向测试和真实 PTY 截图验收见 [终端管理界面的验证章节](tui.md#验证)。截图脚本以临时目录、随机本机端口和 mock 后端运行，不访问真实用户会话或凭证。

新增 workspace 依赖时，应同时检查根构建顺序、CI 产物与版本同步脚本。`tui` 必须先于依赖它的 `relay` 和 `admin` 构建。

## 发版流程

功能 PR 合入 `dev`；`main` 只接收本仓库 `dev` 的发布合并。根包、workspace、Tauri 和锁文件保持同一版本。

```bash
npm run release:prepare -- <version>
```

版本提交留在 `dev`。将 `dev` 合入 `main` 后，再创建发布标签：

```bash
git fetch origin main
git tag v<version> origin/main
git push origin v<version>
```

`v*` 标签触发桌面与移动端发布构建。发布记录写根目录 `CHANGELOG.md`；`packages/app/CHANGELOG.md` 是上游历史，不参与 OMPiUI 发版。
