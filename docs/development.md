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

桌面端同样使用宿主机安装的官方 `omp`，不捆绑 Agent SDK，也不存在宿主机／内置 Pi SDK 切换。默认从 `PATH` 查找 `omp`；需要指定版本或安装位置时，在本机服务的环境变量中设置 `OMPI_OMP_BIN` 为 CLI 可执行文件路径，然后重启本地服务。旧 `OMPIUI_USE_SYSTEM_PI`、`OMPIUI_SDK_PATH` 已失效，桌面设置加载与备份导入会移除它们（包括旧 `PIUI_` 前缀），不会把 SDK 目录误转换为可执行文件路径。官方 OMP 仍使用的 `PI_CODING_AGENT_DIR` 等变量不属于迁移残留。

健康检查以 `ompVersion: string | null` 返回已启动 worker 探测到的 CLI 版本；未有握手、mock 驱动或探测失败时为 `null`，不再返回 Pi SDK 的 verified/fallback 字段，也不以基线版本冒充实测版本。读取健康检查不会启动 Agent 会话。此元数据切换使用 OMPiUI 协议 3 / `ompiui.events.v3`、worker 协议 4，前端、服务端与 worker 必须配套升级；官方 OMP RPC 协商版本 2 和原生会话文件不变。

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
| `OMPI_OMP_BIN` | `PATH` 中的 `omp` | 官方 OMP CLI 可执行文件路径（如 `C:/Tools/omp.exe`）；不是 SDK 包目录 |
| `OMPIUI_HOST` / `OMPIUI_PORT` | `127.0.0.1` / `8787` | 后端监听地址与端口 |
| `OMPIUI_PUBLIC_BASE_URL` | 空 | 反向代理或隧道后的公网基址 |
| `OMPIUI_AUTH_TOKEN` | 自动生成 | 后端 Bearer token，默认持久化到 `~/.ompiui/auth-token` |
| `OMPIUI_DATA_DIR` | `~/.ompiui` | OMPiUI 自身状态目录，不是 OMP 原生会话目录 |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | 官方 Agent 配置与会话根；终端和服务应同时使用此变量配置相同目录，profile 规则仍按官方目录处理 |
| `OMP_AGENT_DIR` | 空 | 旧别名仅发现和打开其中 `sessions` 下的历史会话，不改变新会话或模型配置写入目录。官方终端继续旧目录时需显式设置 `PI_CODING_AGENT_DIR` 或使用 `--session-dir` |
| `PI_CODING_AGENT_SESSION_DIR` | 空 | 官方 CLI 的会话目录(扁平存放)。设置后 UI 新建会话写入此目录,并同时发现原生目录中的会话 |
| `OMPIUI_OMP_SESSION_DIRS` | 空 | 额外登记的官方会话目录(对应官方 `--session-dir`),用系统路径分隔符分隔(Windows `;`,其他 `:`)。只读取登记目录,不扫描全盘 |
| `OMPIUI_TUNNEL_URL` / `OMPIUI_TUNNEL_KEY` / `OMPIUI_TUNNEL_ID` | 空 | 自建中转地址、密钥与节点 ID |
| `VITE_OMPIUI_API` / `VITE_OMPIUI_TOKEN` | 空 | 浏览器构建时指定后端地址与令牌 |
| `OMPIUI_ADMIN_TOKEN` / `OMPIUI_ADMIN_HOST` / `OMPIUI_ADMIN_PORT` | 自动生成 / `127.0.0.1` / `9898` | 管理令牌与监听地址 |

公网基址同时用于分享地址和 Origin 校验。入口链接中的 `?token=` 会在首屏读取后移出地址栏，后续请求使用 `Authorization`；公开分享链接前必须移除真实令牌。

个别 OpenAI 兼容网关对 OMP 的 `wait` 工具会返回 0-token 空响应。OMPiUI 启动的 OMP 进程会附加 `~/.ompiui/omp-compat.yml`（存在时），可使用 `async.enabled: false` 等覆盖项，而不修改官方 CLI 配置。

## Windows 后台生命周期

Windows 官方安装包的桌面应用可以按用户明确开启的选项管理后端,两个开关默认均关闭,由原生层持久化保存:

- **登录后仅后台启动后端**:登录系统后以 headless 模式启动安装目录内的官方 `omp-worker.exe`,不打开桌面窗口。同一后端不会被桌面窗口重复创建。
- **异常退出后自动恢复**:仅在后端异常退出时按退避间隔重启。用户主动停止、退出并停止服务、禁用、升级暂停时保持停止,不会被恢复。

状态分为:后台已禁用、后端在后台运行、已由用户停止、升级暂停、异常退出等待恢复。设置页显示当前 PID 与脱敏后的最近错误,并提供停止入口。桌面端与后台启动共用同一份 `envVars` 配置;界面只在原生层保存成功返回后才更新开关,不以 localStorage 代表后台是否已生效。

原生配置保存在 `~/.ompiui/background.json`；`OMPIUI_BACKGROUND_DIR` 仅用于隔离运行验收。当前运行进程的有效环境与下次启动配置分开记录，防止修改端口/令牌后向错误地址发送关闭请求。Windows 登录项为当前官方桌面 exe 的 `--background`，监督进程先于 GUI 初始化启动，不创建 WebView。

安装器在安装或升级前会先暂停恢复并优雅停止本应用的后端与 supervisor；失败阻止替换文件，重复维护调用保持幂等。安装完成后按原有设置恢复新的 worker。卸载清理本应用的后台进程与登录登记，只保留不会自行启动的用户偏好，以兼容 NSIS 的卸载后重装升级路径。独立终端中的 OMP 会话不受影响。

前一轮已有隔离 Windows 目录中编译后原生 exe 的运行记录：后台启动、重复启动保持一个后端、异常退出后恢复、正常关闭不恢复、升级暂停后替换实际 worker 文件并恢复、重复恢复不创建第二个后端。本轮收尾仅静态核对，未重新运行上述场景。未在真实重新登录及完整 NSIS 安装/卸载环境执行，不能把原生维护命令演练等同于完整安装器验收。

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
