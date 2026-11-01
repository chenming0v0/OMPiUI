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
                                     omp --mode rpc-ui
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

OMPiUI 通过官方 `omp --mode rpc-ui` 托管写入会话；只读控制进程使用普通 `rpc`。两者都是跨进程官方 RPC，不在 Node 服务中嵌入第二份 Agent SDK。OMP 负责执行编程任务；OMPiUI 负责界面、连接和运行时协调。

桌面发布与服务器安装默认使用预装 `omp-runtime/`：`bin/omp`（Windows 为 `omp.exe`）是官方独立 CLI，`bin/bun` 是 Bun 1.3.14，`node_modules/` 保留与 CLI 完全同版本的官方 npm 源码包及当前平台完整生产／原生依赖。服务仍通过 RPC 调用官方进程，不在 Node 内嵌第二份 Agent SDK；运行不要求全局 npm 包或全局 Bun。运行时解析只读取已安装资源，不在启动或浏览时下载、安装依赖。

显式 `OMPI_OMP_BIN` 优先于内置 CLI（设为 `omp` 可选择 `PATH` 中的 CLI）；未显式指定时先选内置运行时，没有预装资源才从 `PATH` 查找。公共源码必须与所选 CLI 的实测版本完全一致，缺失或不匹配明确失败，不借用无关全局包。`OMPI_OMP_RUNTIME_DIR` 替换预装运行时根，`OMPI_OMP_PACKAGE_ROOT` 显式指定同版本官方包目录，`OMPI_BUN_BIN` 指定真实 Bun 解释器。旧 `OMPIUI_USE_SYSTEM_PI`、`OMPIUI_SDK_PATH` 已失效，桌面设置加载与备份导入会移除它们（包括旧 `PIUI_` 前缀），不会把 SDK 目录误转换为可执行文件路径。官方 OMP 仍使用的 `PI_CODING_AGENT_DIR` 等变量不属于迁移残留。

健康检查以 `ompVersion: string | null` 返回已启动 worker 探测到的 CLI 版本；未有握手、mock 驱动或探测失败时为 `null`，不再返回 Pi SDK 的 verified/fallback 字段，也不以基线版本冒充实测版本。读取健康检查不会启动 Agent 会话。此元数据切换使用 OMPiUI 协议 3 / `ompiui.events.v3`、worker 协议 4，前端、服务端与 worker 必须配套升级；官方 OMP RPC 协商版本 2 和原生会话文件不变。

OMP 原生模型与凭据配置来自 `~/.omp/agent/models.yml`、`config.yml`。会话目录必须与官方终端保持互通；浏览和刷新不能触发 Agent 或写入历史，约束见根目录 [AGENTS.md](../AGENTS.md)。

### 原生会话操作边界

受管会话在官方 RPC UI 进程内加载公共扩展桥接；桥接只适配官方 `AgentSession`／`SessionManager`，不在 worker 另建提示词或队列执行器。桥接的队列、模型范围与扩展设置模块通过官方公开 canonical subpaths 由 host loader 解析，使用当前官方会话及同一设置注册表，不从绝对 `file://` 源码入口另加载模块图。独立设置／包操作仍使用与所选 CLI 完全同版本的公开源码及其依赖；缺少原生 API／Bun 时明确失败，不以空结果代替。

- 普通消息的准入由原生 dispatch／排队结果决定；Slash 保留官方命令、技能与模板分派。RPC ACK 不是本地命令成功或整个回合结束，扩展命令真实抛错的 `extension_error` 必须与本次命令边界一起处理，不能把随后本地完成回执当成功。
- 队列选择使用运行时条目标识，而不是仅信任可移动的下标；编辑取回保留原生规范化图片与隐藏上下文，并合并到原服务器／会话草稿。忙碌提交从首帧在待发送区展示，原生消息开始后才进入历史；「立即发送」按点击顺序追加到原生 steering 队列，不插到队首。受管会话首次提交使用原生 `all` 批量模式（仅进程内、不改官方全局设置）；用户随后显式设置的队列模式仍由原生处理。
- 手动 Stop 在发送官方 `abort` 前启用原生 client-owned continuation 门禁，并取消 GUI goal 续跑定时器；保留队列对象、条目标识、图片和顺序，不清空、不重放、不取回到草稿。只读状态／历史刷新不解除暂停；后续明确提交、立即发送或恢复目标才解除门禁。模型正常结束不启用此门禁，未消费消息按 FIFO 在下一轮批量进入上下文。
- 最低及打包 OMP 版本为 `18.12.6`；旧版用户中止后仍可能续跑遗留 steering，不能用假 idle 或重复 abort 兜底。运行 `node --import tsx scripts/verify-stop-queue.mjs` 可在隔离官方 runtime 与本地模型上验证批量上下文、立即发送顺序、完整历史、Stop 队列身份与只读刷新。
- Slash 的 `prompt`／`sendUserMessage` 与原子中断一样等待本次原生 `prompt_result`，HTTP 保持到原生 300 秒处理期限之后（330 秒），不能在普通 20 秒网络期限后把仍可完成的原生对话当失败而留下可重复提交的旧命令。普通消息仍使用准入回执与原有短期限；本地草稿只在真实成功后按提交快照清理，更新后的文字／图片和原生拒绝保留。
- Slash 菜单 chip 只标记文字范围，提交仍发送原文与独立图片；替换／删除 chip 按范围调整后续 @file 标记，不删除图片。等待接受时仍可贴图、上传或删除附件；失败保留当前草稿，成功只移除接受快照里的附件，新增／替换附件与修改后文字上的 chip 保留。原生 consumed 命令可以只产出文字输出，不代表图片已进入模型。
- #375 的关闭范围为菜单／图片传输与草稿保护，不包含真实视觉识别。失败不广播旧提交为 Undo/Fork 恢复；重试成功按原 composer 快照清理，保留在飞编辑并清理已接受的恢复 marker。普通 `@file` 内容已送达 provider，`message:fileMention` 专用显示未支持独立披露。没有额外真实／付费视觉调用，不将送达当作看图理解；专项矩阵见 [菜单图片与草稿验收](command-images-acceptance.md)。
- 当前会话的 `immediate`／`wait` 只控制 Steer 对工具的干预，不控制显式 Stop／`abort_and_prompt`。OMP 18.12.6 隔离工具验收中，Immediate 让前台 bash 提前转后台并保留后续结果，Wait 等待该工作完成后注入消息；两种模式的纯等待均允许原生提前结束。设置以 `get_state.interruptMode` 读回为准，不写全局设置，不用默认值冒充不可用的原生值。
- “中断并提交”只发一次官方 `abort_and_prompt`，浏览器 blob 图片在发送前完整转为原生图片；不可读图片在中断前报错。官方 ACK 早于提示词准备，客户端等待本次 ID 的 `prompt_result`，保持草稿可编辑直到受理结论可确定；提交前失败保留文本和附件。原生已受理的回合失败仍由运行事件显示，不恢复成可重复投递的草稿。没有 `abort` → 普通 `prompt` 模拟，也不清理原生队列。
- `abortAndPrompt` 与 `prompt`／`sendUserMessage` 同属回合级 worker 请求，不用默认 60 秒命令期限丢弃仍等待原生终态的原子操作；调用方取消、原生处理期限、心跳看门狗和显式配置的 worker 期限继续生效。
- 新运行时打开回执携带会话事件游标；第一次订阅优先保留已消费游标，否则从打开／分支快照的检查点重放，防止首条 `/changelog` 等快速原生命令的输出早于窗格订阅而丢失。`/changelog` 的 default／full／last 参数与内容均来自所选官方 OMP；完整 markdown 保留在扩展面板的命令反馈中，`/ui-about` 与设置中的 OMPiUI 版本检查保持独立。
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
- 导航／Undo／Redo 调用官方同文件 `navigateTree`；Redo 按撤销前的原生分支每个用户回合的尾节点恢复，不猜最新兄弟分支。树图保持紧凑，原生节点选择器仍可导航工具结果与元数据；详情使用只读 `session.read/entry.get` 分片读回完整消息，不能把树页的截短文本当正文块数组。图片／文本草稿由同一会话共享 store 更新所有同源窗格。取消／中断不恢复错误目标，也不清理源草稿。
- 消息 Fork 的 `before` 只对用户消息调用官方 `AgentSession.branch`，恢复该消息原生文本／图片；`at` 使用 OMP 18.12.6+ 的 `AgentSession.fork(entryId)`，包含消息、原生工具批次结果及 artifacts，新身份／文件由原生回执决定。较旧运行时的 inclusive fork 明确返回 `CAPABILITY_DISABLED`，不静默退化成整会话复制；原有整会话 `--fork` 独立保留。总结取消使用原生 `abortBranchSummary`，`customInstructions` 直接传给原生总结器，等待期限与原生操作一致；没有伪 `replaceInstructions`／总结标签入口，独立节点标签仍使用 `SessionManager.appendLabelChange` 并 flush 官方日志。成功回执的身份与图片草稿不依赖后续投影读回；读回失败返回明确部分刷新错误，不能把已提交变更误报为可重试的操作失败。
- 历史图片（用户／助手、工具 content／嵌套 details、子会话预览）保留所属原生 sessionId／entryId；blob 从官方当前 agent／profile 的共享 `blobs/<sha256>` 读取，自定义 session-dir 不改变 blob 归属。预览只读，不扫描猜测目录或改写历史。大图点击后按 256 KiB base64 页恢复，64 MiB 编码预览预算；校验分页长度、MIME、etag 和磁盘版本，引用／服务器换代、缺失或读取中截断会清除旧图并显示错误，可取消下载。
- 目标栏直接读取官方 `get_state.goal` 的 mode/enabled、目标 ID、预算、`tokensUsed` 与 `timeUsedSeconds`；离线浏览从当前原生分支的 `mode_change` 快照投影，不实例化 writer、不把暂态 exiting/reason 当持久化字段。create/get/pause/resume/drop 使用原生 RPC GoalController，replace/complete/budget 使用受支持的 `AgentSession.goalRuntime`。受管进程配置启用官方 `goal.continuationModes: [rpc]`，不写用户设置、不再存在 WebUI 续跑循环或完成标记。预算留空表示清除；暂停目标保留 objective；目标图片明确拒绝，普通消息仍走官方图片规范化。隔离 18.12.6 实测原生计量 18→36 tokens、预算受限、GUI 暂停／恢复／完成／放弃、原生 Goal 工具完成日志及 CLI↔UI 同文件继续；catalog 预览字节不变，备份失败不启动写入。完整主界面和宿主租约并发仍由集成验收覆盖。
- 输入区的 `Ctrl+P`／`Ctrl+Shift+P` 优先交给官方 `session.cycleModel` 前向／反向循环，不被全局命令面板抢占；输入区外的命令面板快捷键不变。候选范围用官方解析器及其模型匹配偏好解析，编辑区显示实际原生 `provider/id`、路由与可选思考档位，而不是对象字符串。循环后模型与可选思考等级读回原生状态；失败在当前服务器／会话输入区显示原始错误，无可循环候选遵循原生空结果。候选范围保持官方 session-only 生命周期：不写全局模型角色、不向会话添加自定义持久化协议，恢复／更换运行时按官方范围行为处理。
- 原生 ask 只按实际注册／活动工具集和已就绪的应答桥广告；不会硬加入工具名或改写 `ask.enabled`／`ask.timeout`。OMP 18.12.6 及以上托管进程通过真实 `set_ask_dialog` 协议 opt-in，以 `method: ask` 的问题顺序和原请求身份发送 `answers`，不是普通聊天消息。基础 `select/editor` 路线保留用于官方普通扩展对话框。

官方设置页编辑全局覆盖，项目覆盖仍按官方优先级生效；保存保留未编辑键、准确备份与独立原生落盘读回。包管理的安装／更新等待官方操作结果，资源检查只读，不执行扩展或 MCP。
首页与新会话在官方候选只有 `off` 时显示禁用的 **Off**，即使没有保存的偏好或旧偏好为 `max`；多档模型未选择时仍显示 Default，未知能力不补造档位。
切换服务器时，首页模型与思考偏好从目标服务器的存储重新读取；不携带上一服务器的模型／Max 显示，再让首次发送悄悄采用另一组原生默认。

Windows／官方 OMP 18.12.6 的设置验收使用实际 Management 设置页、独立 `Settings.loadReadOnly` 与 `omp config list --json` 交叉读回：表单和 nested/dotted JSON patch、项目优先级、null reset、保留其它角色与扩展命名空间、精确写前备份，以及错误后可编辑草稿均已验证。页面保存成功只声明原生持久化；已有会话是否即时应用，仍按各设置的官方 reload／订阅语义，不通过停止或重启用户会话验收。

原生 YAML 序列化不保证末尾换行；外部追加 sibling 的验收样本必须显式加入换行分隔。缺少分隔会把 `false` 与下一行键拼成畸形 YAML，不是设置 helper 损坏配置的证据；不得为此放宽官方解析或把错误配置当空对象。原始文件（包括原有换行字节）的 `.bak` 必须在有效 patch 写入前精确保留，拒绝的 patch 不改配置或备份。

会话资源检查只使用当前运行时实际加载的扩展、工具与处理器；斜杠菜单使用官方 RPC `get_available_commands`／`available_commands_update` 的完整命令列表，而不是会排除内置／文件命令的 `ExtensionAPI.getCommands()`。菜单与手输保留原生注册名称、参数及同一 `sendUserMessage` 分派；命令元数据事件会刷新已打开菜单，查询失败不会冒充空命令列表。
原生 OMP 18.12.6 的 RPC `/reload-plugins` 清理插件发现缓存，并通过 `refreshSkillsAndCommands` 重发现技能／文件命令和刷新系统提示词；它不是 TUI 的 hooks/tools/agents/MCP 全重载，也不重新加载扩展工厂、提示词模板或模型设置。资源页的显式 Reload 另行重读当前会话；只读 Refresh 不执行上述操作。裸 `/reload` 未注册时仍由官方按普通提示词处理，不是 `/reload-plugins` 别名，不产生本地重载成功。
隔离 18.12.6／OMPiUI 0.6.41 源码实测（独立 Chrome、直接 CDP）：菜单／手输 `/reload-plugins` 均得到原生 `Plugins reloaded.`；编辑技能与文件命令后原生列表及再次打开的菜单元数据从 v4 更新到 v5／v6，执行文件命令确实将 v6 内容写入原生日志。重发现期间会话 ID、文件、叶节点与历史条目数保持不变。无效 `skills.customDirectories: [null]` 由原生处理器返回错误；GUI 保留真实错误通知及命令反馈，不添加成功。设置页模型重载仍为独立能力。

### 原生 ask 与扩展 UI 模式

| 模式 | 原生 ask | 扩展 UI |
| --- | --- | --- |
| 普通 `rpc` | 18.12.6 实测不注册 ask，不声称可交互 | 基础 select/confirm/input/editor/notify/status/字符串 widget |
| 托管 `rpc-ui` | 以实际活动工具为准；新接口 opt-in 问卷，旧版本基础 select/editor | 基础扩展 UI，不运行 TUI 自定义组件 |
| `rpc-ui --no-ui` | 官方工具 UI 仍启用；不能为 `--no-ui` 偷换成普通 rpc | 扩展 hasUI=false，基础扩展弹窗不发出 |
| 官方 `ask.enabled: false`／工具集排除 ask | 明确显示未活动原因，不强制开启 | 不改变其他扩展 UI |
| 官方 TUI | 原生富组件及 TUI ask 能力 | 不等同于 RPC 能力；GUI 不启动／接管终端 |

18.12.6 原生问卷 wire format 支持单选、多选、Other 自定义文本、多问题返回／修改／检查及一次最终提交；多选可附带 `customInput` 文本。单选的选项加独立附注仍是上游边界：RPC `answers` 只有 `id/selectedOptions/customInput`，不提供独立 `note` 字段，且单选不能同时携带选项和非空 `customInput`。不把附注拼接为普通 prompt，不伪造 TUI `note`、`chatRedirect` 或图片应答。

本次隔离验证使用官方 OMP 18.12.6、同版本公开源码、Bun 1.3.14、一次性配置／会话和本地脚本化 OpenAI 协议 provider（不是外部真实模型服务）。实际模型协议 tool_calls 触发原生 AskTool，真实 Chrome 消费产品问卷组件，经原请求 `extension_ui_response` 产生正确 `selectedOptions/customInput` 和后续模型协议继续；同时验证单选、多选／自定义文本、三问题返回修改／最终提交、重复拒绝、刷新不复活、重连恢复、用户取消、原生 abort、官方超时答案与 Plan 禁用超时，以及普通扩展 UI 和各模式实际工具集。集成宿主／完整应用验证仍由集成轮执行。

超时只由官方 ask 策略选推荐项并产生 `timedOut`；问卷回答及超时自动选择均不是另一个危险操作的审批。Plan 模式保持官方无 ask 超时。断线只恢复 worker 仍未结算的请求，不重放答案；没有用户答案时遵循官方待决／取消语义，`ask.timeout: 0` 不存在可冒充用户批准的自动答案。

### Git worktree 网页管理

“变更”面板的 **Git worktrees**（新对话时也显示在侧栏）列出 Git 实际登记的路径、分支、HEAD、锁定及失效状态；不以已知文件夹分组冒充 worktree 管理。`git.worktrees` 只读，`git.worktreeCreate` 在当前 HEAD 创建新分支／linked worktree，`git.worktreeRemove` 仅在用户确认后移除干净、未占用、未锁定的 linked worktree，保留分支；不使用 `--force`、自动 clean/prune 或关闭用户 shell。占用路径／脏目录返回 `FILE_CONFLICT`，原生会话／GUI shell／正在打开的会话占用返回 `WORKSPACE_BUSY`。

移除占用检查只枚举本服务 TerminalManager 的运行中 GUI shell 记录，分别比较所属 workspace 和记录 cwd 是否在目标 worktree 内（含子目录），不扫描外部终端／OMP 或关闭 shell。隔离 OMP 18.12.6 / Bun 1.3.14、真实 Git 和专属物理 Chrome 的实际 host HTTP／终端 WebSocket 验证了子目录 workspace／祖先 workspace 下的目标 cwd shell 返回 `WORKSPACE_BUSY` 且目录与 shell 不变；fixture shell 自行 `exit` 后，干净 checkout 移除成功、分支保留，相邻路径的 shell 仍运行。集成 GUI 和完整测试套件由主集成流程验收。

选择 **Switch native session here** 是明确的原生写入操作：以原生 `isSessionOnDisk()` 和当前 journal 路径确认持久化状态，备份已落盘的最新日志，再通过同一 RPC UI AgentSession 的公开 `reload()`／`moveSession()` 迁移官方日志及 artifacts，并重载目标 cwd 的设置、记忆与技能／命令。尚未落盘的会话不伪造日志或私有副本，第一次原生写入仍使用迁移后的 cwd；新对话尚无原生会话时，**Use this workspace** 仅切换 GUI 工作区。sessionId 不变，sessionFile 和 cwd 以原生回执为准；同身份迁移不清空任务、队列、Goal 或会话资源，所有显示该身份的 pane 继续跟随它。取消、浏览和刷新不启动 Agent 或保存历史；不静默复制成另一份私有会话。

迁移从首次异步读取前到原生 reload／flush／move／cwd 重载及回执投影结束，按当前会话事件身份关闭消息受理；`sendUserMessage`（含斜杠命令）、Steer、Follow-up、队列立即发送和“中断并提交”返回 `SESSION_BUSY`，不投递到正在迁移的源会话。迁移前已受理但尚未开始／入队的提交，以及 `AgentSession.hasPendingAsyncWork()` 所报告的已完成但仍等待投递的后台结果，也禁止迁移；不能仅以 running jobs 为空判断空闲。显式 Stop 不经过消息受理门禁，仍由官方取消接口处理，不关闭其他会话／CLI 或扫描全局锁。

本次受理门禁修复已在官方 OMP 18.12.6／Bun 1.3.14 的专属 HOME、两棵真实 Git worktree 及真实 HTTP worker 中验证：锁住原生 settings.flush 时三种即时提交均返回 409 `SESSION_BUSY`，显式 Stop 返回 200；真实异步 bash 已完成且 running 为空、delivery 仍在途时，迁移拒绝且 cwd／文件／ID／日志字节不变，释放后仅有一条原生 async-result 回到源会话；公开扩展命令已受理但未启动回合时同样拒绝。空闲迁移与关闭己方 writer 后 CLI 同文件续写／GUI 再续写保留同一 ID。独占物理 Chrome 的两个同身份分屏窗格经真实事件 WebSocket 跟随迁移，分别从左右窗格提交的新回合均写入同一原生日志并在两边可见。

本功能已使用官方 OMP 18.12.6、Bun 1.3.14、隔离 Git／HOME／模型配置及仅本机离线协议服务实测：网页列举、取消／确认创建、切换后原生写文件、CLI 同文件继续及真实 task 结果回到 GUI、切换回原目录、只读刷新日志字节与 mtime 不变、脏／占用错误、取消／确认干净移除，以及无 Agent 的新对话工作区选择和未落盘原生会话的同身份迁移／首次写入。网页验收使用专属物理 Chrome CDP；未依赖终端 TUI 或 mock Agent。集成后的全量构建／测试及多 pane 组合验收由主集成流程执行。



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

模型工具同次调用的网页 PTY 使用公开扩展执行器与受认证私有 socket/pipe：原命令只启动一次，网页在 Bash 正文中交互，真实结果回原调用；普通 Bash/async/name 服务不改为第二 shell。能力边界、控制权、恢复和隔离验收见 [工具 PTY](tool-interaction.md)。

受管写入会话使用官方 `rpc-ui` 与公共扩展桥；普通 `rpc`（含 `--no-ui`）不提供该桥，也不承诺相同扩展 UI 能力。浏览、刷新与草稿同步仍走只读历史路径，不应为了查看后台状态启动写入 runtime。

启动已停止读取遗留 `~/.ompiui/omp-compat.yml`。UI 的进程级配置仅设置 `autoResume: false`，不覆盖官方全局／项目的 `async.enabled`、`launch.enabled` 或子代理递归深度，也不修改这些原生配置文件。普通异步 bash 与命名服务分别遵守原生 async／launch 开关；task／eval 沿用官方各自的后台执行规则，不能把所有工作强制转为同步。个别 OpenAI 兼容网关曾对 `wait` 返回 0-token 空响应；遗留兼容文件不是现行解决方案，网关是否支持连续工具调用仍须用其实际 provider 验证。

#384 的隔离官方 OMP 18.12.6 实跑已观察：无兼容文件和旧 false 文件均可返回真实 bash job 身份；全局／项目显式 false 移除 bash schema 的 `async` 字段并返回官方禁用错误。成功、exit 7、超时及目标取消保留原生结果，async 父回合 yield 后仍 pending，最终结果只回灌一次再 settled。原生 task 在 async 开启时返回后台身份并回灌，关闭时直接返回真实结果；eval 的后台开关是独立的 `eval.autoBackground.enabled`，启用和关闭路径均实跑，未增加不存在的 `async` 输入字段。

命名服务的 log＋port readiness、真实超时、stdin（含空内容 Enter）、persist／detached 跨原生进程退出恢复、session 模式最后客户端退出后的清理及目标 kill 已观察。普通 job 与同名服务冲突时，官方 read／kill 均返回歧义错误；其它 workspace 的 service 不能被此 workspace 的同名 proc 请求解析或停止。同名 bash 显式再次调用遵守官方 `replace:true` 策略，可能重新启动／换身份，不把它当作 UI 重连自动复用。配置字节／mtime 未变；独立普通 `rpc` 进程仍保留全局 false 的官方禁用错误。

Windows 验收使用隔离原生 `shellPath`（PowerShell），Git Bash 的 MSYS 权限失败及 cmd 的命令解析失败单独记录，不以 PID 冒充 ready。实际网页切页／重连、GUI pending／reaper 状态及同 workspace 外来 CLI owner 的批准边界仍需集成验收；不将 RPC fixture、listener 重绑或只渲染录制结果当作 GUI 端到端证明。

## Windows 后台生命周期

Windows 官方安装包的桌面应用可以按用户明确开启的选项管理后端,两个开关默认均关闭,由原生层持久化保存:

- **登录后仅后台启动后端**:登录系统后以 headless 模式启动安装目录内的官方 `omp-worker.exe`,不打开桌面窗口。同一后端不会被桌面窗口重复创建。
- **异常退出后自动恢复**:仅在后端异常退出时按退避间隔重启。用户主动停止、退出并停止服务、禁用、升级暂停时保持停止,不会被恢复。

状态分为:后台已禁用、后端在后台运行、已由用户停止、升级暂停、异常退出等待恢复。设置页显示当前 PID 与脱敏后的最近错误,并提供停止入口。桌面端与后台启动共用同一份 `envVars` 配置;界面只在原生层保存成功返回后才更新开关,不以 localStorage 代表后台是否已生效。

原生配置保存在 `~/.ompiui/background.json`；`OMPIUI_BACKGROUND_DIR` 仅用于隔离运行验收。当前运行进程的有效环境与下次启动配置分开记录，防止修改端口/令牌后向错误地址发送关闭请求。Windows 登录项为当前官方桌面 exe 的 `--background`，监督进程先于 GUI 初始化启动，不创建 WebView。

安装器在安装或升级前会先暂停恢复并优雅停止本应用的后端与 supervisor；失败阻止替换文件，重复维护调用保持幂等。安装完成后按原有设置恢复新的 worker。卸载清理本应用的后台进程与登录登记，只保留不会自行启动的用户偏好，以兼容 NSIS 的卸载后重装升级路径。独立终端中的 OMP 会话不受影响。

Windows 安装器固定使用当前 Tauri NSIS 模板，在旧卸载器删除快捷方式之前保存完整 `.lnk`，安装后恢复起始位置、参数、图标和显示方式；仅在安装路径改变时更新目标。安装取消且原安装文件身份未变时恢复暂停前状态，开始替换文件后拒绝自动回滚。维护命令与 supervisor 串行协调关闭，并持有已核对安装路径的进程句柄等待退出，不以 HTTP 端口关闭代替进程退出，也不按可复用 PID 终止独立 OMP。

本轮实际编译 Windows 原生 exe，并在隔离配置目录运行 supervisor 与两个并发维护 CLI：关闭请求仅发一次，监听器关闭后仍等待 worker 退出；取消恢复原停止状态，旧配置格式重写后仍恢复原运行意图，开始替换后拒绝回滚，卸载完成后保持停止。独立浏览器已验证模型持久化、刷新保留草稿及新会话使用原项目；官方会话互通与只读浏览验收通过。完整 Windows 安装升级另由下面的可弃置 runner 真实路径验收，不能以隔离 supervisor 或单测替代。

真实 Windows 升级验收可手动派发 `Windows installed upgrade smoke` 工作流；它只接受 GitHub 托管的可弃置 Windows runner，本地和 self-hosted 主机被脚本拒绝。提供完整候选 commit SHA、该 SHA 成功的 `Desktop And Mobile Release` run ID 和旧版本 tag；工作流核对源树对应的 Windows lite artifact，校验旧安装器的发布 SHA-256，并单独装配官方 OMP 18.12.6 公共源码／二进制与 Bun 1.3.14。它实际安装旧版，经原生 WebView CDP 操作保存项目，定制桌面／开始菜单 `.lnk` 后用 `/P` 执行包含旧卸载的真实升级（不使用绕过卸载的 `/UPDATE`），比较目标、起始目录、参数及完整文件 SHA-256，再经保留的桌面快捷方式启动新 GUI。开始菜单参数使用受支持的显式原项目路径；桌面参数留空，快捷方式 cwd 特意使用另一目录，以证明保存项目没有被隐式 cwd 覆盖。独立、确定性的本地 HTTP 测试 provider 配合原生 `models.yml`／`modelRoles.default` 配置，让官方 OMP 无需任何真实账号凭据即可启动；其用途仅为持久化升级验收对话，不代表真实厂商模型或账号能力。GUI 先发送官方 `/changelog`，再发送真实普通文本，只有 GUI 选中会话 ID 与新 JSONL 原生 header ID 一致、cwd 为升级前项目且真实 user／assistant 条目均落盘才通过。

新会话的首轮原生文件验证后，工作流还从同一实际 GUI 会话再发普通文本；要求 native session ID／文件路径保持不变、两轮 user／assistant 均落盘、原文件字节作为前缀完整保留，并记录前后 SHA-256。它不另建影子会话，也不通过脚本直接写 native 历史。

升级前等待旧版实际后端进入 Running，经原生标题栏关闭按钮与“Close and stop backend”确认正常停止并退出，再运行 NSIS 升级；不在后端尚 Preparing 时强杀 GUI 造成无人值守维护提示。候选 GUI 完成原生两轮写入后也通过同一真实确认退出。若安装器超时，保存当前物理桌面与该安装器进程身份，保留保护提示的原始失败，不改用绕过旧卸载的 `/UPDATE`。

验收 artifact 保存候选源码／构建 run／安装器哈希、安装退出码、升级前后快捷方式字段、原生 WebView 截图、只读存储快照及真实 session JSONL。若托管环境缺 WebView/CDP、安装器受无人值守弹窗阻止或 GUI／原生会话路径未完成，job 失败并保留准确阻塞证据，不以 supervisor、单测或独立浏览器页代替升级通过。候选预构建不等于发布，不会由此工作流创建 tag 或 release。

经授权的托管 runner 使用 WebView2 官方支持的 HKLM `Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`／`UserDataFolder` 精确 `ompiui.exe` 值；只保存／修改／恢复该应用值，不设通配符，finally 恢复原值。工作流通过 Windows `GetTokenInformation(TokenElevation)` 记录实际提升状态；Microsoft 明确规定提升的 WebView2 host 忽略环境变量与 HKCU 调试参数，而接受 HKLM 配置，因此不重复无效的用户级调试等待。依据：[Environment overrides](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.4022.49)／[Elevated-host overrides](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags)。这些动作严格只在可弃置 GitHub 托管 runner 执行，不作用于真实工作站。诊断仅记录该 runner 自有安装 GUI 的子进程和物理桌面截图。GUI 仍受阻时可独立完成真实升级与快捷方式字段比较，但只标 `SHORTCUT_ONLY`，job 保持失败，完整项目／原生 GUI 会话验收仍不通过。

原生 GUI 若在 CDP 前退出，工作流不重复等待已不存在的页面；改用 Microsoft 官方签名的 Evergreen WebView2 bootstrapper（官方地址 `https://go.microsoft.com/fwlink/p/?LinkId=2124703`，执行前校验有效 Authenticode／Microsoft Corporation 签名并记录 SHA-256）显式准备运行前提。失败诊断只查询本 run 时间内、EventData 含自有安装 exe 完整路径的 Application crash 事件，并以诊断专用的直接原生 GUI 启动采集 stdout／stderr／退出码；该直接启动不计为快捷方式或 GUI 验收。不调用系统重启，仍保持 `SHORTCUT_ONLY` 与完整验收阻塞之间的区别。

隔离 Windows `USERPROFILE` 不能只是空目录：工作流预建自有 `AppData/Local` 与 `AppData/Roaming` 并设置进程级 `LOCALAPPDATA`／`APPDATA`。Tauri HTTP plugin 的 cookie cache 使用 `app_cache_dir()`，底层 `SHGetKnownFolderPath(flags=0)` 会验证展开后的目录存在；缺失真实 LocalAppData 时曾实测两版 GUI 在 WebView 创建前报 `PluginInitialization("http", "unknown path")` 并退出（Event 1000／`0xc0000409`）。这属于验收 profile 前提，不能用捕获／忽略该异常冒充 GUI 可用。

实际通过记录：[Windows installed upgrade smoke run 40237794673](https://github.com/chenming0v0/OMPiUI/actions/runs/40237794673)。候选为源码 `69649f46a332019f171f69e8f8240001f4578d1a`／预构建 run `40225030721` 的 `OMPiUI_0.6.42_x64-setup-lite.exe`，SHA-256 `B421C8409567D65BC0A02FA31135B2069F542B057C8BA92D4EB4CC86F6396808`；旧版为已发布 0.6.41，两次真实 `/P` 安装／升级均 exit 0。原生 GUI 经实际项目对话框保存 original-project 并正常关闭停止后端；桌面与开始菜单 `.lnk` 的 TargetPath／WorkingDirectory／Arguments／IconLocation／WindowStyle 及完整文件 SHA-256 均保留。升级后经参数为空、起始目录为另一个目录的保留桌面快捷方式启动，保存的 original-project 仍生效；新原生会话 `01a17512-3878-7638-84bd-00937415c8a5` 的 GUI 路由与 JSONL header ID 一致、cwd 为原项目，实际 GUI 两轮 user／assistant 同文件落盘、原历史字节前缀保留。官方 OMP 为 18.12.6／Bun 1.3.14，模型输出来自明确标注的自有确定性 HTTP 测试 provider，不宣称厂商账号／模型验收。该记录只覆盖此候选安装器，不等于后续集成源码已发布；最终重建安装器须按自身源码／artifact 身份再次验收。

## 会话树、Fork 与替换隔离验收

#356 的双窗格 Fork 身份／图片草稿迁移、切换其它子分支、Undo 后新发同身份分支已在隔离官方 OMP 18.12.6／Bun 1.3.14 和生产网页实跑补齐；持久化草稿／Redo 刷新恢复及双向原生会话继续也通过。新增 `scripts/verify-session-transitions.mjs --history-only` 可重复运行历史矩阵，`scripts/preview-session-transitions.mjs` 提供实际 GUI 验收服务。

#361 的本地错误隔离已补齐并经维护者确认按原不污染范围结案：无来源的原始 `extension_error` 走无 sessionId 的宿主诊断通道，扩展面板保留原文和独立 runtime 标识，不落入新会话事件流；原生命令拒绝／草稿处理不变，不虚构会话或通知目标。默认 `scripts/verify-session-transitions.mjs` 及兼容的 `--local-isolation` 验证历史／宿主隔离后 exit 0；`--history-only` 只验历史子集。官方仍缺 source session／prompt／generation，不能精确路由回源会话；显式 `--require-source-attribution` 保留这一额外未提供能力的 exit 2，不代表发现新的目标污染。详见 [专项步骤与真实证据](session-transition-acceptance.md)。

#367 的本地 stream/frame 错误从实际官方分片故障到生产网页反馈已补齐，重复入口、原生／GUI 证据与共享限流边界见 [RPC 分片故障验收](rpc-stream-error-acceptance.md)。#373/#374 的完整官方运行身份、历史 endcap 和 typed root/nested 合并结算在正式 18.14.0 源码中仍缺失；这不排除客户端通过公开运行观察与保守状态显示修正自身界面。维护者要求不改 OMP，客户端兼容方案另待实施验收，不以私改 runner 或文本猜测替代。原生契约缺口、兼容范围澄清和待验矩阵见 [子代理原生契约提案](subagent-native-contract.md)。

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

### 原生 `/compact` 验收

`/compact` 原文交给官方 parser；`soft`、`remote`、`snapcompact` 和完整 focus 不由 GUI 拆解或改写。菜单和参数提示使用官方 RPC 注册表（包括 builtin 描述）；只读磁盘预览不能为取得菜单而启动 runtime。手动压缩不一定发出 `auto_compaction_*`，因此 GUI 从官方状态读取 `isCompacting`，完成与失败保留 `command_output` 原文。压缩期间扩展命令会排队，此时读取官方 `get_state.queuedMessages`，不能为读取队列提交 `/ompiui-runtime` 控制 prompt。

2026-10-26 在隔离 home／会话与独立 Chrome 中，以官方 OMP 18.12.6、Bun 1.3.14 和本地确定性 OpenAI 兼容服务实测菜单／手输模式、完整 focus、混合大小写与制表空白、snapcompact 尾参拒绝、摘要与原生位图压缩、provider 拒绝及 Already compacted。模式没有改写 `compaction.enabled` 或 `methodOrder`；取消通过 GUI Stop 调用原生 abort，恢复空闲而不生成压缩成功反馈。token 反馈和上下文来自原生运行时，本地夹具的 usage 是估算值，不代表外部模型计费精度；remote 在该模型上按官方顺序跳过不可用远端方法并采用 soft，未验证外部 provider 的远端压缩端点。

同一原生 JSONL 已由独立官方 RPC 进程恢复并继续，历史请求包含 snapcompact 图片；GUI 只读重开后看见该续写，文件 SHA-256 不变，显式 GUI 续写读取最新历史并生成相同 SHA-256 的写前备份。隔离 Windows 夹具使用原安装位置的同版本 Bun，并显式指定原生库目录；这不等于重定位 Bun 的 Windows 临时文件问题已解决。

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
