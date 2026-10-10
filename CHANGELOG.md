## [v0.6.2] - 2026-10-10

修复刷新恢复与运行时生命周期问题，并整合代理来信和后台任务结果展示。

- fix: 兼容 OMP 扩展 UI 的数组快照；已结算权限弹窗不再被迟到快照重新打开，新 worker generation 的请求仍可正常显示（#36）。
- fix: 为聊天历史读取增加独立版本校验，防止迟到预览和旧刷新响应覆盖较新的历史及实时消息。
- fix: OMP 子进程崩溃后按原会话身份自动重新挂接；恢复失败仍可重试，不重放结果未知的命令（#40）。
- fix: 取消打开会话后先清理后台创建的 runtime，再释放租约；重试等待清理完成，避免重复 runtime。
- fix: 配对错误码 `PAIR_INVALID`、`PAIR_USED`、`PAIR_RATE_LIMITED` 不再被协议层降级为 `INTERNAL`（#39）。
- ui: 代理来信展示原始正文；后台任务分别展示和展开结果，保留结构化输出、错误、元数据及补充说明。
- test: 补齐快照竞态、取消清理、跨会话崩溃隔离与真实 IPC 恢复测试；桌面和手机宽度视觉检查通过。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.2`。

## [v0.6.1] - 2026-10-09

修复任务暂停不生效，以及切换会话后模型、思考强度和运行状态显示不准确的问题。

- fix: 暂停目标时中止当前执行，并使过期的自动续跑与待发消息失效，避免任务在暂停后重新启动。
- fix: 从当前分支恢复磁盘会话的默认模型和思考强度，不再用首页偏好替代会话配置；辅助角色与临时回退回复不会覆盖显式选择。
- fix: 会话状态请求增加版本校验，隔离跨会话的临时选择，防止迟到响应覆盖新配置或将已停止任务重新显示为运行中。
- fix: 补齐模型变更与原生配置更新事件，任务结束和全局空闲状态立即同步界面，同时保留尚未结束的后台工作状态。
- fix: 模型和思考强度设置检查原生 RPC 失败结果，模型列表缓存尚未更新时保留运行时模型元数据。
- test: 补齐暂停恢复、配置恢复、响应乱序及停止状态回归测试。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.1`。

## [v0.6.0] - 2026-10-09

完善目标栏与待处理消息交互，补齐立即投递、运行诊断与会话恢复。

- ui: 目标卡片移到输入框外侧，由前景输入框遮住下沿；待处理消息逐行排列在目标栏上方，目标栏固定为最后一行，保留编辑、清除和侧边聊天操作。
- fix: 队列上箭头立即提交选中消息给当前 OMP 回合，受理后显示到聊天记录并进入下一次模型请求；保留图片附件，失败不丢消息，原生历史落盘后不重复显示。
- feat: 新增浏览器重连、状态恢复、命令中止、空闲回收及服务端和 worker 生命周期诊断；支持按会话查询、日志轮转、敏感字段过滤和 JSONL 导出。
- fix: 后台历史同步异常不再成为未处理的 Promise 拒绝；默认开发后端不随源码或编译产物变化自动重启，显式 `dev:watch` 保留热重启入口。
- fix: 子代理会话查找与转录读取同时覆盖原生 OMP 和 WebUI 托管目录，修复侧栏可见但无法打开的历史子会话。
- chore: Android 开发脚本改为跨平台 Node 入口，统一文本行尾；修复 Windows 版本脚本重定向，并完善发版记录基线选择。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.0`。

## [v0.5.1] - 2026-10-09

修复正在工作的会话被宿主回收，导致长命令跑到一半整条回合被截断的问题。

- fix: 空闲回收在无法确认工作状态时一律保留 runtime，不再把「问不到 state.get」当作空闲直接 dispose；判据同时纳入后台 bash 与异步子任务尚未回灌的信号，模型执行 build 一类长命令时不再出现界面整体重置、工具被写成 Command aborted 且回合不再继续（#40 相关）。
- fix: 队列的模式切换与回到输入框在条目索引意外失效时，仍把已经清空的队列原样重放；仅有图片没有文本的条目不再被回填成空文本后入队。
- refactor: 工具结果的文本与图片提取收敛到统一入口，四处渲染代码不再各自解析 content。
- chore: 根包、全部 workspace、Tauri 与 lockfile 统一为 0.5.1。

## [v0.5.0] - 2026-10-08

本轮集中处理 #33 汇总的审查结论，覆盖导航、聊天渲染、状态一致性、文件与终端、访问控制、OMP 运行时以及中转与管理部署。

- fix: 会话列表与项目列表按所选服务器隔离，切换服务器不再残留上一台的项目和后台子代理；会话刷新收敛到单一 canonical 事件，两份最近会话列表不再各自漂移。
- fix: 服务端复用空闲 runtime 造成的静默身份切换只刷新列表，不再触发 pane 跟随，分屏不会再被整体切到别的会话。
- fix: 折叠时间线不再把系统条目排到更早的用户与助手回合之前；只有思考或工具内容的失败回合现在会给出中断与错误提示。
- fix: 网络错误不再重放写请求，有副作用的读取（如生成配对邀请）也显式关闭重试，避免同一操作被执行两次。
- fix: 迟到的快照不再覆盖更新的会话状态；已应答或已关闭的授权弹窗不会被旧快照重新弹出，恢复流程只处理快照期间未变更的 flow。
- fix: 设置备份纳入按服务器保存的数据；文件树切换不再丢弃未保存草稿，保存期间的继续输入也不会被保存回包覆盖。
- fix: 终端游标过期后不再固定回退到 0，改为省略游标让服务端从最早保留的输出重放，消除无法恢复的重连循环；本地没有缓冲时不再跳过已有输出。
- fix: Git 补丁懒加载期间的刷新不再让当前 diff 长期空白。
- fix: 中转模式下的配对限速改按访客的真实来源身份计数，单个访客无法再阻断所有人配对；转发前剥离公网伪造的内部隧道标记，该标记改用每次启动生成的一次性令牌。
- fix: 网络信息接口报告实际监听端口，不再被 Host 与转发头带偏；远程配对二维码使用服务端上报的端口。
- fix: 隧道鉴权失败原因跨 1006 与重连保留，不再被无信息的通用断开清空。
- fix: OMP 扩展界面在会话替换后重新绑定新会话身份，新会话的弹窗可以正常应答；空闲回收尊重仍在等待 detached 子任务的父 RPC。
- fix: 中转响应方向实现回压，慢速访客不再让桌面端无界堆积数据；连接在排队字节排空前保持计数，中断时统一回收收发资源。
- fix: 配置 domain 后对外公布正确的公网协议与端口，只替换主机名，不再宣传错误的公网地址。
- fix: 管理 CLI 的后端入口与工作目录改由安装位置推导；独立 stop 能停止其他管理进程启动的后端；并发启动不再产生两个后端；清空管理页面字段现在可以覆盖环境变量中的隧道配置；根目录 `npm run admin` 可用。
- fix: 浏览器端的中转配置不再把 localStorage 当作服务器持久化，改为如实显示远端状态并指向管理入口。
- fix: 队列的撤销、改投递模式与移除统一按带附件的条目重建，图片不再于重建时丢失；条目越界时重放原队列，不再出现清空后静默丢消息。
- chore: 根包、全部 workspace、Tauri 与 lockfile 统一为 0.5.0。

## [v0.4.2] - 2026-10-07

- fix: 合入 PR #30，运行中的回合里发送的消息进入 worker 侧可编辑队列，回合结束后逐条以普通 prompt 排出；编辑和删除不会再留下已经提交给 OMP 的幽灵消息。
- fix: 空闲会话上残留的 follow-up/steer 提示改按普通 prompt 发送，消息不再滞留队列被吞掉。
- fix: 排队消息按 kind+index 重建编辑、删除与移动目标，重复文本不再误删错误的条目。
- ui: 排队消息行改为紧凑样式并带 kebab 菜单：回到输入框编辑、在侧边聊天中打开、移除该条。
- fix: 导出会话的路径基于当前工作区解析，导出前等待会话 settle 并加长超时；补齐消息队列回归测试。

## [v0.4.1] - 2026-10-06

- fix: 合入 PR #27，Goal 可作为新会话的第一步直接启动；调整目标编辑器与输入框布局，等待目标命令完成后刷新状态。
- fix: 外部 OMP TUI 历史改为只读磁盘预览，查看和刷新不会启动第二个写入进程；继续对话时显式复制为独立的 WebUI 托管会话。
- fix: 补齐运行、结束与停止事件的状态更新；发送等待后端接受，失败保留文本与附件，停止中的后续发送等待停止完成。
- fix: 释放消息入场动画保留的高度，允许图片附件加载后自然撑开，避免覆盖后续消息。
- fix: OMP Todo 的权威空快照显示实际清空结果；`xd://` 等虚拟工具写入不再伪装为文件 diff。
- fix: 无正文或思考分隔的连续工具调用合并到同一步骤线，失败的 Eval 也计入已结束数量，完成后显示 6/6。
- fix: 运行时分支补齐刷新恢复；默认 Local 可编辑名称、地址与 token，健康检查、会话和重连使用保存的地址（#24）。
- feat: 新增无桌面部署管理平面，提供管理 TUI、独立 Web 控制台和 VPS 安装、Docker 部署入口。
- chore: 根包、全部 workspace、Tauri 与 lockfile 统一为 0.4.1，补齐版本脚本对 admin 和根 lockfile 条目的更新。
- docs: OMP 历史备份、恢复证据及外部 TUI 控制限制记录于 #28；未找到的历史最终回复不作补造。

## [Unreleased]

- ui: 目标栏移到输入框外侧，改为较窄的上层圆角目标卡片，由前景输入框遮住下沿，避免目标控件嵌入输入区。
- ui: 工作中发送的本轮追加与下一轮消息移入目标卡片上方，逐条单行显示并省略长文本，目标栏始终位于最后一行；保留队列编辑、立即发送、清除与侧边聊天操作。
- fix: 队列上箭头通过原生 OMP `steer` 立即提交选中消息，受理后显示到时间线并进入下一次模型请求；保留附件与相邻队列项，发送失败不丢消息，原生落盘后移除临时展示条目。
- fix: 后台历史同步异常不再成为未处理的 Promise 拒绝；默认开发后端不随源码或编译产物变化自动重启，显式 `dev:watch` 保留热重启入口，避免 Agent 修改自身服务代码时中断会话。

- feat: 新增会话运行诊断日志，关联浏览器刷新重连、状态恢复、命令中止、空闲回收及服务端/worker 生命周期；提供敏感数据白名单、容量轮转、按会话查询与 JSONL 导出。

- fix: 按 ID 查找子代理会话时同时扫描原生 OMP 与 WebUI 托管会话目录，修复侧栏可见但打开提示「会话不可用」的问题；补齐重载后预览与磁盘读取的回归覆盖，顶层列表仍不混入子会话。
- feat: 无桌面部署管理平面 `@ompiui/admin`——SSH 友好的 TUI 与独立管理 Web UI（默认 `127.0.0.1:9898`，独立管理令牌），管理后端进程生命周期、凭证与分享链接、监听/公网/中转配置；配置持久化到 `~/.ompiui/admin.json`。
- feat: VPS 一键安装脚本支持裸机引导克隆、精确 Node >=22.19 检查与 systemd linger；新增 `deploy/docker-compose.yml`、Dockerfile HEALTHCHECK、根 `.dockerignore` 与 `deploy/README.md`。
- fix: 设置 → 服务器里内置 Local 条目开放编辑名称/地址/token（仍不可删除），保存后健康检查、会话请求、SSE 重连与终端 WebSocket 都改走新地址 (#24)。
- fix: 选中的远程服务器不再被构建期 `VITE_OMPIUI_API` 钉死，浏览器与 Tauri 的 base 解析一致；管理器探测失败不再污染服务错误状态，主动停止不再显示为异常退出，检测到外部已运行的后端时给出可行动的错误。

## [v0.3.1] - 2026-10-04

- ui: 设置页改为有边界的分组面板和独立导航；模型可见性支持折叠。Agent 模型配置改为 Slim 式表单：右对齐角色名、主模型与思考强度同一行、底部取消/保存，不再逐项立即写入。
- fix: 折叠设置内容不再接受键盘焦点；搜索定位会自动展开目标设置面板。
- feat: 后台任务完成消息渲染为结构化卡片，保留原始输出。
- fix: 嵌套子代理会话不再显示成 fork。
- fix: 多个子代理同时推进时 UI 卡死——TaskRenderer 改为按 toolCallId 分片订阅、store 通知合到下一帧；历史转录按需拉取，打开子会话改为直查单文件。
- fix: 子代理跳转失败时不再静默；侧栏和任务卡标题优先用任务名，丢掉 OMP 注入的包装提示词。
- fix: 同一 task 下并发子代理不再互相覆盖；迟到的 lifecycle/progress 帧不能把已完成状态闪回运行中。
- fix: 工作中发送的消息进入 follow-up 队列，不再因 isStreaming 滞后被当成新 prompt 丢掉。
- ui: put Agent model thinking beside the primary selector (ebeb694)
- fix: lock concurrent subagent status, queue busy follow-ups, restyle Agent models (6b73a09)
- fix: make subagent jump failures visible and stop using wrapping prompts as names (8b484d9)
- fix: stop the UI freeze when many subagents stream at once (7be9ccb)
- feat: render native async-result custom messages as job cards (069b057)
- fix: stop labeling nested subagent sessions as forks (a153d32)
- ui: restyle settings into bounded panels with independent navigation (0ab82f4)
- fix: render OMP native phases[].tasks[] todo snapshots (045d3b9)

## [v0.3.0] - 2026-10-03

- chore: ignore the local .zcode workspace directory (691904c)
- docs: changelog entries for the relay tunnel and phone remote features (8e6713d)
- feat: phone remote settings card with QR pairing and built-in Tailscale (c4073d3)
- feat: one-time pairing invites, NIC list, and embedded Tailscale manager (a05957f)
- feat: tunnel settings UI, share entry badge, and deployment docs (2a057f0)
- feat: embedded relay tunnel client with dynamic public origin (2cdbf59)
- feat: self-hosted relay server for reverse-tunnel NAT traversal (4d8a022)
- feat: structured result card for the subagent yield tool (5cd3d85)
- feat: session goal bar with worker-side goal registry and continuation loop (bb3014a)
- ci: skip the Android APK when signing secrets are not configured (e0e0b9a)
- chore: release 0.2.0 (82b3cbd)
- fix: export MoreVerticalIcon used by ModelRolesSettings (c2ba091)
- docs: changelog entries for unreleased subagent sessions, model roles, tree.get fixes (2e58cda)
- feat: surface OMP subagent sessions (sidebar children + persisted task transcripts) (804ce77)
- refactor: drop model quick config in favor of OMP model roles (5236bcb)
- feat: public sharing — configurable public base URL for share links (#8) (e7047ec)
- fix: align worker tree.get with SDK nested shape (#10) (4939ba9)
- fix: refresh web model list when ~/.omp/agent/models.yml changes (#11) (5977403)
- fix: override setup-android default packages to drop obsolete tools (40660fe)
- fix: release build blockers — missing bundler icons and android license step (dfd5971)
- fix: desktop service test expects the omp driver value after rebrand (51144a4)
- chore: release 0.1.1 (2176ce7)
- feat!: finish PiUI to OMPiUI rebrand across folders, service and protocol names (a53b453)
- fix: OMP version precheck (#5) and subagent session-header noise (#6) (e133351)
- fix: close out upstream leftovers — state dirs, root LICENSE, app README (38f41d5)
- docs: changelog for the settings model selector z-index fix (3eb4efc)
- fix: lift model selector dropdown above the settings dialog (a5d52ed)
- feat: quick model config with OMP model roles in settings (636cba0)
- fix: settings management tab white-screens on OMP worker (1d3e881)
- fix: ignore cached PiUI releases in the about-page update check (9b4e3f5)
- feat: replace Pi app icons with the OMPiUI gradient mark (a0ee963)
- fix: render glob/grep path lists as text, not file cards (83d7bf3)
- docs: move branch and release rules out of the README (456a39f)
- docs: require work and pull requests to stay on dev (093a559)
- docs: credit PiUI and OpenCodeUI at the top of the README (b433058)
- chore: release 0.1.0 (b9831a9)
- ci: add validate, desktop release, and main-from-dev policy (f659469)
- fix: point release checks and version bump at OMPiUI (667ee6f)
- chore: update piui → ompiui references in service checks and tests (f3c4b1c)
- chore: ignore detached server logs (636d43c)
- fix: fail fast on missing session cwd, include omp stderr in crash logs (3a88fac)
- refactor(app): drop @earendil-works SDK dependency, vendor Pi SDK types (3d95604)
- refactor: rename workspace scope @piui/* to @ompiui/* (b7a6cdd)
- fix: regenerate node-pty patch for 1.2.0-beta.15 (3a510ad)
- feat: replace sidebar logo with OMPiUI gradient mark (7ea8e9b)
- fix: dynamic document title brand (a3219f7)
- docs: README + PLAN results; rebrand user-visible strings to OMPiUI (689cd5b)
- fix: subagent store snapshot caching (React #185), toolSteps i18n keys (03a3c8c)
- feat: OMP RPC worker runtime (omp --mode rpc), subagent channel, OMP catalog (b0f29cb)
- docs: add project plan (5ad6e47)
- chore: init repo with gitignore (91c4087)

## [Unreleased]

- fix: Todo 工具适配 OMP 原生 `phases[].tasks[]` 快照，按 OpenCodeUI 的任务卡片显示阶段分组、进度、状态图标和阻塞原因，不再回退为 Input/Output；输入框 Todo 入口共用数据适配，空快照可清除旧任务，失败操作保留错误提示，历史 TodoWrite 清单仍可显示。
- fix: 刷新页面时不再把正在运行的模型显示成已停止：重连后的实时消息先暂存，分支状态恢复后再合并；无游标的整页刷新会在磁盘预览后重新读取运行时分支，保留工具调用中的 live turn。

- feat: 自建中转（内网穿透）—— 新包 `@ompiui/relay`（bin `omp-relay`）实现 Pebrel 式反向隧道中转：电脑端主动拨号到自己的 VPS（NAT/防火墙后可用，无需公网 IP/端口转发），公网访客走普通 HTTP(S) 入口，每个请求被翻译成控制连接上的一条虚拟连接（open → body 流 → head/响应体/end），WS upgrade（事件流/终端流）101 头保真后两侧 socket 纯字节拼接。安全语义沿用 Pebrel：接入密钥只存 SHA-256 摘要（timing-safe 比较）、重复接入拒绝（先到先得）、30s 心跳、断线指数退避、无存储转发（离线 502 `TUNNEL_OFFLINE`）；限流 100 msg/s、每隧道 64 并发、帧 ≤64KiB，背压按 bufferedAmount 高水位暂停源流。路由支持 `host` 绑定与 `<id>.<domain>` 子域名，未配置任何显式路由时单隧道兜底（配了就不兜底，未匹配 Host 拒绝）；`omp-relay init` 一条命令生成配置 + 43 字符密钥并打印可直接粘贴的 `OMPIUI_TUNNEL_*`，支持内置 TLS 或 Caddy 反代。19 个单测 + 全链路集成测试
- feat: server 内嵌隧道客户端与动态公网入口 —— 配置 `OMPIUI_TUNNEL_URL/KEY/ID`（或 `--tunnel-*`）后 server 主动拨号到中转并保活（500ms×2ⁿ 上限 15s + 抖动重连），公网请求被重放到本机 `127.0.0.1:port`；有效公网入口 = 显式 `OMPIUI_PUBLIC_BASE_URL` ?? 中转上报地址，Origin 白名单（HTTP + WS 两处）改为动态取值自动纳入隧道公网 origin，share 链接/启动日志同步切换；新增 `GET /api/v1/host/tunnel` 状态端点，`ShareInfo` 附带 tunnel 信息。集成测试覆盖 HTTP/WS 透传、干净停止与中转重启后重连
- feat: 内网穿透设置区与部署文档 —— 设置 → 服务新增「内网穿透（自建中转）」区（中转地址/接入密钥/隧道 ID 走 `OMPIUI_TUNNEL_*` 环境变量持久化、重启生效提示、状态轮询、信任模型警示），分享面板显示隧道公网入口；`docs/tunnel.md` 覆盖 VPS 部署（裸 Node/Docker、Caddy 自动 HTTPS 与内置 TLS 两条路径）、`init → 粘贴配置 → 重启 → 手机打开分享链接` 全流程与安全模型（中转可信级同反代，token 仍必需），README 增补指引
- feat: 手机远程一次性配对与内置 Tailscale（服务端）—— `PairingStore` 铸造 10 分钟单次邀请（8 位展示码 + `<id>.<secret>` 兑换凭据，拒绝采样避免模偏差；按客户端 IP 频控，10 分钟窗口 5 次失败即拉黑）；`POST /api/v1/host/pair/redeem` 是全服务唯一免鉴权端点（Origin 校验 + 频控把守），成功一次性交出访问令牌；`GET /api/v1/host/network` 输出可达 IPv4 网卡并识别 Tailscale 接口（接口名或 100.64.0.0/10 段）；`TailscaleManager` 一键安装官方发行版（Windows MSI + `msiexec /passive` 弹 UAC，Linux tgz 解压 + userspace 免 root daemon），捕获 `tailscale login` 的授权链接供二维码登录，`GET /api/v1/host/tailscale` 汇报安装进度/后端状态/IP，安装与登录走鉴权端点
- feat: 手机远程设置卡片与扫码配对（前端）—— 设置 → 服务新增 Pebrel 式「手机远程」卡片：「局域网 / Tailscale」与「自建中转」双 tab（中转 tab 二维码自动切到公网入口）、本地 uqr 渲染的一次性二维码、10 分钟倒计时 + 换一个、分组 8 位码兜底、复制完整配对信息、网卡下拉、三步指引；状态行「等待手机连接 · <配对链接>」在手机兑换后自动翻转为「已批准，手机已连接」；内置 Tailscale 子面板含安装进度、登录二维码与运行状态。手机扫码落在 `/?pair=…`，SPA 先向同源兑换再渲染，令牌落地后地址栏参数即被清除
- feat: 子代理 Yield 工具（提交最终结果的收尾调用）专属渲染，不再落到通用 Input/Output 块 — 工具行按状态显示"提交结果（shimmer）/任务完成（绿色）/提交失败"，完成态图标同步变绿，副标题优先取 summary/result/message/report 类可读字段做预览；展开后结果负载渲染成带标签的结果卡片：字符串字段走 MarkdownRenderer（与助手消息一致），`files` 数组按 path/file 字段识别成"文件名 + 描述"文件行，嵌套对象平铺成键值行，未知字段兜底"标签 + 内容"段落（summary/files/architecture/report 等 21 个常见字段标签走 i18n），卡片限高 420px 内部滚动；描述型 steps 汇总把 yield 归入独立类别（"提交了最终结果"）
- feat: session goal bar（会话目标栏）— 输入框上方常驻目标状态入口：无目标时显示"设定目标"，点击弹出编辑器（桌面为锚在输入框上方的浮层卡片，移动端为底部弹层 sheet + 文本域），保存即设定；有目标时显示状态（进行中/已暂停/预算受限/已完成）+ 目标内容 + 已用时长，并提供暂停/恢复、编辑、放弃三个操作。因为 OMP 的 `--mode rpc` 不注册 goal 隐藏工具、也没有 goal RPC 命令（实测 18.3.x，`/goal` 走 prompt 只会变成普通消息发给模型），目标注册表由 OMPiUI worker 自己维护：新增 `goal` 会话命令（set/pause/resume/drop，确定性变更、不经过模型），worker 在 active 目标下每次会话 settle 后自动发送一条续跑 prompt（上限 50 轮，模型以行尾 `GOAL_COMPLETE` 标记完成），abort 自动暂停目标（对齐 OMP goal 模式语义）；状态经 `state.get` 的 `goal` 字段 + 合成 `goal_updated` 事件到达前端，前端目标栏经 piSessionStateStore 订阅渲染。目标只随 worker 进程存活（RPC 无自定义条目可持久化），worker 重启后等下一次目标操作恢复
- fix: chat virtualizer 偶发崩溃（"Cannot read properties of undefined (reading 'index'/'start')"）— virtual-core 3.17 的 `getVirtualItems()` 在 measurementsCache 有空洞时会产出 undefined 项（ChatArea 的 overrides 用到 `measurementsCache: (VirtualItem | undefined)[]`），渲染 map 与 Outline 视口行扫描现在跳过空洞项，不再让整个聊天区撞上错误边界
- fix: OMP 会话时间线不再显示"未支持的条目：mode_change" — OMP 18.x 在 Pi 条目联合之外扩展的 agent 模式切换标记（goal/plan，`mode: "none"` 表示退出；目标栏设定目标时会写入该条目）现渲染为一条模式分隔条（如"已切换到目标模式"）；同时把同批扩展的记账/元数据条目（`title_change` 自动标题、`service_tier_change`/`ttsr_injection`/`credential_pin`/`reset_boundary`）与 `model_change` 等元数据一致处理：`title_change` 在 worker 两条路径（RPC adaptEntry + 磁盘预览）丢弃为 `omp.dropped` 占位，其余在时间线静默跳过、session 树过滤并补齐展示名，时间线与树都不再出现"未支持的条目"

## [v0.2.0] - 2026-10-01

- feat: OMP subagent (child) sessions now nest under their parent session in the sidebar — selecting a session lists its `session.children` (OMP writes subagent transcripts to `<parent>.jsonl/<agentId>.jsonl`), child rows render indented like OpenCodeUI children, clicking opens the child session (resolved by id through the catalog deep scan), the rows stay put while a child session itself is selected, and the list refetches when the sessions-changed event fires so freshly landed child sessions appear on their own. Disk session preview also replaces `session_init`/`title`/`session`/`model_usage` metadata entries with `omp.dropped` placeholders like the RPC path already did, so opening a child session no longer shows an "Unsupported entry: session_init" divider at the top of its timeline
- feat: the Task tool's inline Subtask view survives reopens — OMP's RPC subagent registry is in-process and drops terminal runs, so after a worker restart / page reload / opening the session from another instance the panel used to show an eternal "waiting for response"; the renderer now rebuilds a read-only completed run from the persisted task result `details.results[]` (id/agent/task/exit code), derives the child transcript file (`<outputPath 目录>/<id>.jsonl`, falling back to the parent session's sibling directory), and the worker's `subagent.messages` command falls back to reading the child session jsonl from disk (realpath-locked to `~/.omp/agent/sessions`) when a fresh omp process rejects the session file — transcripts are fully disk-backed
- feat: public sharing for the web panel (#8) — a configurable public base URL (`OMPIUI_PUBLIC_BASE_URL` env / `--public-base-url` flag / 设置 → 服务 → 网络监听 input) becomes the source of truth for share links, the startup log and the Origin allowlist once set, instead of guessing the first non-loopback IPv4 which is unreachable from the public internet; the share panel now shows a browser-openable URL (with an open-in-tab action) next to the `ompiui://connect` deep link, picks its hint by exposure mode (loopback / LAN / public), and the public path documents the reverse-proxy/tunnel requirement with HTTPS advice plus an explicit warning that anyone holding the link can read the workspace, open terminals, run commands and drive the agent. The Origin check accepts the configured public origin even when the proxy rewrites the Host header; invalid public base URLs are ignored with a warning at startup
- fix: the web model list now picks up `~/.omp/agent/models.yml` edits without a restart (#11) — the worker watches the file (directory watch + content-hash dedupe, so atomic editor saves are caught) and on change recycles the provider-auth bound client, because the long-lived `omp --mode rpc` control process only reads models.yml at startup and `modelRuntime.refresh`/`reload` were just re-querying the same stale process; the worker also broadcasts a new `models.updated` event over the server stream, and the web app responds by refetching the model selector list and bumping the provider revision for the settings page. Settings 刷新/重新加载 now recycle the process too, and an in-flight OAuth login flow defers the recycle so it is not killed mid-flow
- refactor: drop the model quick-config section in favor of OMP model roles — the roles list with its DEFAULT role is now the single place to assign models (`ModelQuickConfig` → `ModelRolesSettings`), the preferred-model-changed listener goes away with it, and the composer keeps remembering the last model picked in chat; also exports the `MoreVerticalIcon` the roles section uses
- fix: worker `tree.get` returns the SDK's nested `{ entry, children, label }` shape instead of a flat `{ id, parentId }` array, so the session tree panel no longer crashes on `node.entry.id` (#10)
- ci: the release workflow skips the Android APK when the `ANDROID_KEYSTORE_*` signing secrets are not configured (they never were, which is why v0.1.1 published nothing) — desktop/portable assets ship without Android until the keystore secrets are set, and the release body only advertises the Mobile line when APKs are actually attached

## [0.1.1] - 2026-09-30

- chore: finish the PiUI → OMPiUI rebrand across the desktop shell, service and protocol names. Desktop/mobile identity becomes `OMPiUI` with Tauri identifier `com.ompiui.app` (was `com.piui.app`), Rust crate/binary `ompiui`/`ompiui_lib` (was `piui`/`piui_lib`), Android package `com.ompiui.app` with the Java package moved to `com/ompiui`, and the Windows right-click "Open with OMPiUI" registry keys (uninstall also removes the legacy PiUI keys). The bundled server binary is renamed `pi-worker.exe` → `omp-worker.exe` with the `--omp-worker` flag and `@ompiui/omp-worker` package name, and `packages/server/src/pi` / `packages/app/src/pi` move to `src/omp` (`dev-server-pi.mjs` → `dev-server-omp.mjs`)
- chore: rename the service protocol identifiers — WS subprotocol `piui.events.v1` → `ompiui.events.v1`, share links generate `ompiui://connect` (parser still accepts legacy `piui://connect`), `piui-service.json` service marker → `ompiui-service.json`, server logs and temp/backup file prefixes → `ompiui-*`, and every `PIUI_*` environment variable (`PIUI_DRIVER`, `PIUI_PORT`, `PIUI_HOST`, `PIUI_AUTH_TOKEN`, `PIUI_DATA_DIR`, `PIUI_SDK_PATH`, `PIUI_NATIVE_MODULES`, `PIUI_SERVER_BIN`, `PIUI_CURSOR_SECRET`, `PIUI_FIXTURE_*`…) → `OMPIUI_*`; `PIUI_EMBEDDED` is untouched because it is part of the contract with the external `omp` CLI
- feat: one-time local data migration on boot — localStorage keys `piui:`/`piui-` (including per-server `srv:{id}:piui-*`) rename to their `ompiui` equivalents, the custom-sound IndexedDB database `piui-sounds` copies over to `ompiui-sounds`, stored service env var names get the same `PIUI_` → `OMPIUI_` rename, server settings and update-check caches keep read-once legacy fallbacks, and settings backup files exported by the old version still import (new exports use `ompiui-settings-backup-*.json`)
- breaking: the Tauri identifier change moves the WebView profile and app-data directory (`%APPDATA%\com.piui.app` → `com.ompiui.app`), so browser-view settings do not carry over between old and new installs; server-side data in `~/.ompiui` and legacy `~/.piui` tokens still migrate automatically
- fix: OMP sessions no longer hang ~150s on old OMP CLIs — the worker probes `omp --version` at startup and fails session open fast below 18.2.11 with an upgrade hint (`OMP_TOO_OLD`); id-less error responses from older omp are matched to in-flight requests by command name and rejected immediately; about/registry now show the detected real version instead of the hardcoded 18.3.1, and the README documents the minimum OMP version (#5)
- fix: subagent transcripts no longer render the session header as "Unsupported entry" — the OMP worker drops `session`/`session_init` metadata entries like `title`/`model_usage`, and the timeline selector skips the `omp.dropped` placeholders those drops leave behind to keep the branch chain intact (#6)

- fix: unify on-disk state under `~/.ompiui` — auth token/cursor secret/workspace locks move from `~/.piui`, server file logs leave `%APPDATA%\com.piui.desktop` for `com.ompiui.desktop`, and the standalone exe native-module fallback prefers `com.ompiui.desktop`; the PiUI-era locations get a one-time read migration so existing tokens stay valid and the legacy dir is never written
- chore: GPL-3.0 `LICENSE` now sits at the repo root (text inherited from packages/app) so GitHub's license API detects it
- docs: replace the leftover upstream OpenCodeUI README in packages/app with an OMPiUI package readme pointing at the root README
- fix: model selector dropdowns in settings now render above the dialog — ModelSelector forwards a zIndex prop, quick config passes 400 like SettingsSelect
- feat: quick model config in settings — default model + thinking level (client prefs, applied to new sessions) and OMP model-role assignments (all 15 roles, persisted via `omp config` CLI into modelRoles, hot-reloaded by running OMP processes)
- fix: settings 管理 tab no longer white-screens — OMP worker returns contract-complete provider/runtime snapshots, UI reads optional fields defensively, and error boundaries now contain panel crashes
- fix: about-page update check ignores cached PiUI releases

## [v0.1.0] - 2026-09-26

- ci: add validate, desktop release, and main-from-dev policy (f659469)
- fix: point release checks and version bump at OMPiUI (667ee6f)
- chore: update piui → ompiui references in service checks and tests (f3c4b1c)
- chore: ignore detached server logs (636d43c)
- fix: fail fast on missing session cwd, include omp stderr in crash logs (3a88fac)
- refactor(app): drop @earendil-works SDK dependency, vendor Pi SDK types (3d95604)
- refactor: rename workspace scope @piui/* to @ompiui/* (b7a6cdd)
- fix: regenerate node-pty patch for 1.2.0-beta.15 (3a510ad)
- feat: replace sidebar logo with OMPiUI gradient mark (7ea8e9b)
- fix: dynamic document title brand (a3219f7)
- docs: README + PLAN results; rebrand user-visible strings to OMPiUI (689cd5b)
- fix: subagent store snapshot caching (React #185), toolSteps i18n keys (03a3c8c)
- feat: OMP RPC worker runtime (omp --mode rpc), subagent channel, OMP catalog (b0f29cb)
- docs: add project plan (5ad6e47)
- chore: init repo with gitignore (91c4087)
