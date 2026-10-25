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

桌面发布与服务器安装默认使用预装 `omp-runtime/`：`bin/omp`（Windows 为 `omp.exe`）是官方独立 CLI，`bin/bun` 是 Bun 1.3.14，`node_modules/` 保留与 CLI 完全同版本的官方 npm 源码包及当前平台完整生产／原生依赖。服务仍通过 RPC 调用官方进程，不在 Node 内嵌第二份 Agent SDK；运行不要求全局 npm 包或全局 Bun。运行时解析只读取已安装资源，不在启动或浏览时下载、安装依赖。

显式 `OMPI_OMP_BIN` 优先于内置 CLI（设为 `omp` 可选择 `PATH` 中的 CLI）；未显式指定时先选内置运行时，没有预装资源才从 `PATH` 查找。公共源码必须与所选 CLI 的实测版本完全一致，缺失或不匹配明确失败，不借用无关全局包。`OMPI_OMP_RUNTIME_DIR` 替换预装运行时根，`OMPI_OMP_PACKAGE_ROOT` 显式指定同版本官方包目录，`OMPI_BUN_BIN` 指定真实 Bun 解释器。旧 `OMPIUI_USE_SYSTEM_PI`、`OMPIUI_SDK_PATH` 已失效，桌面设置加载与备份导入会移除它们（包括旧 `PIUI_` 前缀），不会把 SDK 目录误转换为可执行文件路径。官方 OMP 仍使用的 `PI_CODING_AGENT_DIR` 等变量不属于迁移残留。

健康检查以 `ompVersion: string | null` 返回已启动 worker 探测到的 CLI 版本；未有握手、mock 驱动或探测失败时为 `null`，不再返回 Pi SDK 的 verified/fallback 字段，也不以基线版本冒充实测版本。读取健康检查不会启动 Agent 会话。此元数据切换使用 OMPiUI 协议 3 / `ompiui.events.v3`、worker 协议 4，前端、服务端与 worker 必须配套升级；官方 OMP RPC 协商版本 2 和原生会话文件不变。

OMP 原生模型与凭据配置来自 `~/.omp/agent/models.yml`、`config.yml`。会话目录必须与官方终端保持互通；浏览和刷新不能触发 Agent 或写入历史，约束见根目录 [AGENTS.md](../AGENTS.md)。

### 原生会话操作边界

受管会话在官方 RPC UI 进程内加载公共扩展桥接；桥接只适配官方 `AgentSession`／`SessionManager`，不在 worker 另建提示词或队列执行器。桥接的队列、模型范围与扩展设置模块通过官方公开 canonical subpaths 由 host loader 解析，使用当前官方会话及同一设置注册表，不从绝对 `file://` 源码入口另加载模块图。独立设置／包操作仍使用与所选 CLI 完全同版本的公开源码及其依赖；缺少原生 API／Bun 时明确失败，不以空结果代替。

- 普通消息的准入由原生 dispatch／排队结果决定；Slash 保留官方命令、技能与模板分派。RPC ACK 不是本地命令成功或整个回合结束，扩展命令真实抛错的 `extension_error` 必须与本次命令边界一起处理，不能把随后本地完成回执当成功。
- Slash 菜单 chip 只标记文字范围，提交仍发送原文与独立图片；替换／删除 chip 按范围调整后续 @file 标记，不删除图片。等待接受时仍可贴图、上传或删除附件；失败保留当前草稿，成功只移除接受快照里的附件，新增／替换附件与修改后文字上的 chip 保留。原生 consumed 命令可以只产出文字输出，不代表图片已进入模型。
- 队列选择使用运行时条目标识，而不是仅信任可移动的下标；编辑取回保留原生规范化图片与隐藏上下文，并合并到原服务器／会话草稿。只读状态请求不发布合成 `queue_update`；停止既不清空也不重放队列，完整结束只以原生状态／事件为准。Steering 可以随官方停止后的续跑被消费，不能承诺所有队列在 ACK 后暂停。
- 队列交付模式使用官方 RPC `set_steering_mode`／`set_follow_up_mode`，仅影响当前运行时，不写全局配置或私有会话模式。两种队列分别读回 `all`／`one-at-a-time`；控件等待真实状态读回，读回失败显示错误并保留先前选择。磁盘预览无法推断运行时模式，显示未选择状态而不是伪造默认值。批次、交付点、剩余队列和图片顺序均由原生 Agent 控制，不由 GUI 逐条投递。
- 已开始工具的失败／取消／未知结果只由原生终态证据确定，最后部分输出与原因保留；真实工具结果始终优先。后台刷新和重连不得把完成或中断工具复活成运行。
- 分页窗口缺少工具调用时，已加载的 `toolResult` 按原生日志位置独立显示，未知参数明确标记、不推断目标；调用通过既有有界分页或 live 消息可见后归并一次。旧 render-key 映射不能代替当前窗口中的持久化 owner，重读不扩大已完成执行缓存、也不全量拉取历史补关联。
- 专用 ask／todo／yield／task 视图必须保留原生结果的阅读、复制与展开入口；失败优先于成功形状的入参／details。合法成功的附加说明、取消／跳过／无法解析答案、原生 `details.meta` 截断与限制信息不得随结构化视图丢弃，diff／files 与图片入口继续保留。隔离验收使用官方 18.12.6 公共工具实现产生的问答、todo、yield、eval、bash 与 task 拒绝结果，并在真实 ToolGroup／ToolPartView 的桌面与移动 compact／classic／timeline、过程折叠组合中验证；混合子任务、图片和截断元数据为合法隔离夹具，不等同于已附着原生会话的 RPC 端到端验收。
- 官方 bash 命名服务结果即使 `isError: false`，`details.service.state: failed` 仍作为原生失败状态保留原文。`ready: false` 或就绪等待 `timedOut: true` 本身不伪造进程／工具失败；超时说明照常可读、可复制。成功读取 `proc://` 返回 daemon 的 failed／starting 状态也不等同于 read 工具失败。真实服务退出与就绪超时原文已在官方 18.12.6 隔离结果中观察，修正后的状态分类由集成回归与界面验收核对，不重放用户服务副作用。
- 扩展取消使用官方 `targetId`，结算保留原请求会话身份；会话替换后的旧应答不能发送进新运行时。
- 扩展对话框使用官方 `select(title, items, dialogOptions)`；描述属于选项对象 `{ label, description }`，不能把 `optionDetails` 当作扩展 API 参数。`editor(title, prefill, dialogOptions, { promptStyle })` 的样式参数在第四位。浮动卡片与扩展面板都按原索引显示说明，只向原生返回 label；旧的纯字符串帧仍正常工作。
- 对话框声明 `role="dialog"`，避免全局发送／停止快捷键在捕获阶段抢走局部 Enter／Escape。Prompt-style editor 的 Enter 提交、Shift+Enter 换行；普通 editor 使用 Ctrl/Cmd+Enter，Shift／Alt 修饰的 Enter 不提交。按钮保留自身的键盘动作，IME 组合事件、`isComposing` 和 229 键码都受到保护，空 prefill 与空提交值保留。
- #368 的隔离 OMP 18.12.6 验收使用 `ui-test-metadata` 扩展命令：原生返回 `Review`／`Two`，input、prompt editor 和普通 editor 返回真实空字符串，取消／超时返回 `undefined`，最终 pending 已结算。浏览器辅助工具曾发生跨目标路由，既有界面观察不作为关闭证据；需在独立直连 CDP 或串行集成环境重测两处界面的描述、按键及 IME 保护。OS 输入法候选窗的人工交互不由 CDP 验收覆盖。
- 导航／Undo／Redo 调用官方同文件 `navigateTree`，Fork 分支创建新文件；取消／中断不恢复错误目标，也不清理源草稿。总结取消使用原生 `abortBranchSummary`，节点标签使用 `SessionManager.appendLabelChange` 写入并 flush 官方日志。成功原生回执的身份与图片草稿不依赖后续投影读回；读回失败返回明确部分刷新错误，不能把已提交变更误报为可重试的操作失败。
- 历史图片（用户／助手、工具 content／嵌套 details、子会话预览）保留所属原生 sessionId／entryId；blob 从官方当前 agent／profile 的共享 `blobs/<sha256>` 读取，自定义 session-dir 不改变 blob 归属。预览只读，不扫描猜测目录或改写历史。大图点击后按 256 KiB base64 页恢复，64 MiB 编码预览预算；校验分页长度、MIME、etag 和磁盘版本，引用／服务器换代、缺失或读取中截断会清除旧图并显示错误，可取消下载。
- 目标栏直接读取官方 `get_state.goal` 的 mode/enabled、目标 ID、预算、`tokensUsed` 与 `timeUsedSeconds`；离线浏览从当前原生分支的 `mode_change` 快照投影，不实例化 writer、不把暂态 exiting/reason 当持久化字段。create/get/pause/resume/drop 使用原生 RPC GoalController，replace/complete/budget 使用受支持的 `AgentSession.goalRuntime`。受管进程配置启用官方 `goal.continuationModes: [rpc]`，不写用户设置、不再存在 WebUI 续跑循环或完成标记。预算留空表示清除；暂停目标保留 objective；目标图片明确拒绝，普通消息仍走官方图片规范化。隔离 18.12.6 实测原生计量 18→36 tokens、预算受限、GUI 暂停／恢复／完成／放弃、原生 Goal 工具完成日志及 CLI↔UI 同文件继续；catalog 预览字节不变，备份失败不启动写入。完整主界面和宿主租约并发仍由集成验收覆盖。

官方设置页编辑全局覆盖，项目覆盖仍按官方优先级生效；保存保留未编辑键、准确备份与独立原生落盘读回。包管理的安装／更新等待官方操作结果，资源检查只读，不执行扩展或 MCP。

Windows／官方 OMP 18.12.6 的设置验收使用实际 Management 设置页、独立 `Settings.loadReadOnly` 与 `omp config list --json` 交叉读回：表单和 nested/dotted JSON patch、项目优先级、null reset、保留其它角色与扩展命名空间、精确写前备份，以及错误后可编辑草稿均已验证。页面保存成功只声明原生持久化；已有会话是否即时应用，仍按各设置的官方 reload／订阅语义，不通过停止或重启用户会话验收。

原生 YAML 序列化不保证末尾换行；外部追加 sibling 的验收样本必须显式加入换行分隔。缺少分隔会把 `false` 与下一行键拼成畸形 YAML，不是设置 helper 损坏配置的证据；不得为此放宽官方解析或把错误配置当空对象。原始文件（包括原有换行字节）的 `.bak` 必须在有效 patch 写入前精确保留，拒绝的 patch 不改配置或备份。

会话资源检查只使用当前运行时实际加载的扩展、命令与处理器。缺少元数据与真实空列表分别显示；官方 18.3.1 的 prompt metadata 不提供文件路径，不能伪造。显式 Reload 使用公开会话重新加载与 `refreshSkillsAndCommands` 支持的技能／文件命令重发现，不承诺重建扩展工厂或重新发现全部提示模板。


新对话优先使用当前项目；未选项目时，恢复当前服务器保存的上次项目，其次使用已打开工作区，最后使用服务器用户主目录。应用安装目录只负责加载程序资源，不再作为隐式项目根目录。保存项目已不存在时应重新选择项目，不静默切换到其他目录。

桌面显式目录参数（资源管理器“Open with OMPiUI”）优先于保存项目；快捷方式的“起始位置”只在没有保存项目时作为首次启动目录。启动目录读取只更新界面与项目选择，不启动 Agent 或改写会话历史。

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
| `OMPI_OMP_BIN` | 内置 `omp-runtime/bin/omp`，无内置资源时查 `PATH` | 显式选择官方 CLI 可执行文件路径（如 `C:/Tools/omp.exe`），设为 `omp` 则强制查 `PATH`；不是 SDK 包目录，公共源码版本必须与实测 CLI 完全一致 |
| `OMPI_OMP_RUNTIME_DIR` | 自动发现预装 `omp-runtime/` | 替换为已准备好的当前平台运行时根（含 `runtime.json`、`bin/`、`node_modules/`）；不触发下载 |
| `OMPI_OMP_PACKAGE_ROOT` | 随所选 CLI／预装运行时定位 | 显式指定 `@oh-my-pi/pi-coding-agent` 包根；须保留公开源码与完整生产／原生依赖，版本必须与所选 CLI 完全一致 |
| `OMPI_BUN_BIN` | 内置 `omp-runtime/bin/bun`，无内置资源时查 `PATH` | 显式指定真实 Bun 解释器可执行文件；打包后端自身不是 Node／Bun 解释器 |
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

Windows 安装器固定使用当前 Tauri NSIS 模板，在旧卸载器删除快捷方式之前保存完整 `.lnk`，安装后恢复起始位置、参数、图标和显示方式；仅在安装路径改变时更新目标。安装取消且原安装文件身份未变时恢复暂停前状态，开始替换文件后拒绝自动回滚。维护命令与 supervisor 串行协调关闭，并持有已核对安装路径的进程句柄等待退出，不以 HTTP 端口关闭代替进程退出，也不按可复用 PID 终止独立 OMP。

本轮实际编译 Windows 原生 exe，并在隔离配置目录运行 supervisor 与两个并发维护 CLI：关闭请求仅发一次，监听器关闭后仍等待 worker 退出；取消恢复原停止状态，旧配置格式重写后仍恢复原运行意图，开始替换后拒绝回滚，卸载完成后保持停止。独立浏览器已验证模型持久化、刷新保留草稿及新会话使用原项目；官方会话互通与只读浏览验收通过。完整安装／升级未在本机验收，按用户要求由用户下载新版本验证；隔离夹具不能替代真实版本升级与登录验收。

## 开发与验证

```bash
npm install
npm run prepare:omp-runtime
npm run build
npm run dev:server:omp
# 另开一个终端：
npm run dev:app
```

源码开发／服务器运行需要 Node.js ≥ 22.19 和 npm。`npm run prepare:omp-runtime` 在显式准备阶段生成根目录 `omp-runtime/`，该目录不入库；默认使用 worker 标定的精确官方版本，并安装 Bun 1.3.14 与完整生产／原生依赖。需要其他官方版本或已有官方 binary 时可传 `-- --version <exact-version> --binary <official-OMP-path>`；binary 与 npm 源码版本必须完全一致，不能混搭。

准备脚本支持 Windows、glibc Linux、macOS 的 x64／arm64，必须在目标系统与架构上安装原生依赖；桌面打包同样拒绝跨宿主平台／架构准备。此范围是 stage 支持范围，不代表每个平台的发布产物已验收。musl Linux 与 Android 不提供本地引擎打包；Android 仅作为客户端连接桌面／服务器主机。正常桌面打包、服务器安装与 Docker 镜像构建会显式准备运行时，服务启动和只读浏览不会补装依赖。

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

`dev` 预构建按源码树标识保存完整五平台附件；标签发布或手动指定 `tag` 时只复用同源码树、未过期的完整集合，继续校验 SHA-256 与必需安装包，不混用不同运行。完整官方运行时的附件传输不保证五分钟完成，发布任务期限为 45 分钟。若标签已创建、尚未发布且仅工作流需要修正，可在 `dev` 手动运行 `desktop-release.yml` 并指定原 `tag`、`rebuild=false`、`verify_only=false`；源码仍取原标签，不移动标签或混入 `dev` 后续代码。
