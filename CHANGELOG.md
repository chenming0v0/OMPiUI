## [v0.6.38] - 2026-10-23

- fix(omp): align native sessions queues resources and terminal feedback (b99efce)
- fix(packages): complete scoped native lifecycle and update acceptance (#340) (21c8be2)
- fix(settings): persist native scopes and preserve failed-save drafts (#339) (5ab9761)

- fix: #339 官方设置保存保持全局／项目／有效配置边界，拒绝错误类型与冲突补丁，保留未编辑字段、备份及原生落盘读回；备份目标是目录时明确失败，不搬走目录或伪报保存成功。
- fix: #340 包管理等待官方操作完成再更新列表；按所选作用域更新并隔离无关源失败，明确只读项目依赖与空作用域，修复 marketplace 资源目录发现遗漏；不以兼容回退掩盖 Windows 原生链接权限错误。
- fix: #341 会话资源来自当前官方运行时的实际加载状态，区分未知／失败与空列表，显示发现警告；只读刷新不重执行扩展，显式 Reload 不再暗示完整扩展与模板热加载。
- fix: #355 保留原生多行命令输出与独立来源信息，真实错误保持失败；官方扩展命令抛错的 `extension_error` 不再被本地完成回执当作成功。
- fix: #356 同文件导航／Undo／Redo 与新文件 Fork 使用官方原生接口，保留取消时的历史、身份与图片草稿；总结取消调用专用原生控制器，节点标签写入官方日志。已提交原生变更后读回失败保留真实目标与草稿，并明确提示部分刷新失败。
- fix: #357 发送按原生准入保留失败草稿，队列使用稳定条目标识并保留图片与隐藏上下文；取回响应迟到仍保存到原服务器／会话草稿。状态读取不再生成队列更新事件导致循环刷新。
- fix: #359 Stop 对齐官方 ACK 与实际结束边界，不清空或重放原生队列；串行等待停止与后续提交，保留官方 steering 继续执行、follow-up 保留及异步工作语义，不把 ACK 伪报为完全空闲。
- fix: #365 已开始但未返回结果的工具依据真实退出／取消／未知结果显示终态，保留部分输出及原始原因；重连、刷新不复活旧运行状态，后到的真实结果优先。
- fix: #369 扩展取消只按原生 `targetId` 结算目标请求，旧会话应答不写入新运行时；保留其他弹窗、超时与正常应答，重复／迟到应答不重复发送。
- fix(dependencies): 桌面发布、服务器显式安装与 Docker 构建准备完整 `omp-runtime/`，交付官方 OMP binary、Bun 1.3.14、与 binary 完全同版本的官方 npm 源码及当前平台生产／原生依赖；默认使用预装运行时，不要求全局 OMP npm 包或全局 Bun，启动与只读浏览不隐式下载。外部 CLI／源码选择保留精确版本门禁，Android 只连接主机、不打包本地引擎。
- fix(omp): 受管扩展桥接的队列、模型范围和扩展设置 imports 改用官方公开 canonical host subpaths，避免绝对 `file://` 源码入口绕过官方 loader graph；移除跨模块设置 cache 代理，继续使用当前官方会话和同一设置注册表。
- test: 删除 HTML 源码按钮触摸状态的单个 CSS class／生成源码文本固定断言，保留相邻预览高度与主题行为测试；仅测试维护，不修改生产界面或重新固定样式实现。
- verification: 官方 OMP 18.3.1 的设置、包、资源、命令反馈、扩展取消语义验收通过；完整候选原生导航／总结取消／日志标签／before-at-first Fork、源文件保护、官方按 ID 双向继续与最新历史备份失败阻断通过；队列／准入完整 smoke、Stop 七场景原生对照、真实 code 23 退出／取消及工具卡片终态已验证。最新候选整体构建通过，worker 全套 244 项中 231 通过、13 跳过、0 失败，lint 为 0 error、14 条 warning；此前受影响 app 消费者 18 文件／182 项通过（35.65 秒）。这些结果不等同于最新候选完整 app 测试套件通过，不代表 #361、完整安装升级或全部平台发布产物已验收。
- verification: 实际设置页、多行命令反馈面板、工具卡片终态，以及原生 A／B 扩展弹窗的取消目标、迟到应答拒绝、保留弹窗真实提交与清理均已验证；设置写入只使用隔离临时后端与配置，不触及用户运行中的服务或原生配置。
- verification: Windows 实际桌面打包成功，产物包含编译后的 OMPiUI server、Tailscale bridge，以及官方 OMP 18.3.1、Bun 1.3.14 和同版本完整公开源码／生产／原生依赖。官方 18.3.1 与最新 18.12.6 的完整运行时分别移到含空格的隔离目录后，在无全局 OMP／npm／Bun 查找的 Node 与 compiled Bun 下，真实设置／包 API、精确版本及 UI→官方 CLI→UI 同一原生文件继续写入均通过（分别 239.15／248.49 秒，含完整运行时复制）。Tauri 资源准备在清理本轮临时产物后实际成功（115.10 秒），完整复制运行时、server、原生 PTY、Web 与 Tailscale 资源；此前磁盘空间耗尽（errno 112）不再是该步骤阻断。跨平台 CI 仍待完成，Linux 安装步骤已定位 Bun npm 包可执行文件布局差异，不能据 Windows 本机通过声明所有平台 CI、安装器构建或完整安装升级通过。
- verification: 官方 canonical host loader 的受管扩展已通过真实加载命令元数据、会话 ID／文件身份与资源检查验证；实际包含 bash 工具，context discovery 无错误。非默认 fast role 精确解析到 offline-fast 模型范围，再完成 UI→官方→UI 三回合同文件继续写入（22 秒）；未以独立源码模块图或设置 cache 代理替代官方运行时。
- verification: 依赖 CI 39898893796 已完成，Windows supported／latest 两项官方会话迁移、模型角色与 compiled relocation 验收均通过；Ubuntu 两项失败在运行时安装的 Bun npm 可执行文件布局，Windows app shard 1 失败在上述样式实现固定测试，其它检查通过。移除该单项实现固定测试后，实际 MarkdownRenderer 98 项通过（8.76 秒），相邻预览高度与主题行为测试保留且通过；Unix 安装路径修复与后续完整 CI 仍待结果，此轮不声明完整 CI 通过。
- ci(release): 完整官方运行时加入后，五平台预构建附件共约 4.8 GB；标签发布首次在 10 分钟期限内未完成 Linux 附件下载。发布任务期限改为 45 分钟，保留完整附件、SHA-256 校验和原标签；手动复用同源码树预构建的发布运行 39935995841 实际成功，发布步骤耗时 10 分 23 秒。
- verification: 发布收尾的 PR CI 39909161949 全部通过，Ubuntu 服务端 230 通过、3 跳过、0 失败；实际隔离 OMP 18.3.1 的 Node／compiled Bun 公共 API 和 UI→官方→UI 同文件续写再次通过（175.42 秒），真实 Node PTY 输出、回放及退出码 0 通过。独立 dev 验证中出现过 staging rename EPERM 和官方 RPC ready 超时，原因未证实，不宣称修复；#361 与原有未提交工作不纳入本版。

## [v0.6.37] - 2026-10-22

- fix: 保留 Windows 升级项目与快捷方式并修复模型保存竞态 (f24ae64)
- ui: 优化手机供应商详情与模型获取面板 (0d70098)
- fix: 默认新对话恢复当前服务器保存的项目，其次使用已打开工作区，最后兜底用户主目录；不再静默使用安装目录。桌面显式打开文件夹优先，快捷方式起始位置不覆盖保存的项目。
- fix: 供应商模型改名后按已保存身份重基后续草稿，连续改名和再次保存保留 `cost`、`compat` 等隐藏字段；复用旧模型 ID 新建模型时不复制旧模型隐藏配置。
- fix: 供应商保存和删除绑定原服务器及连接代次；模型更新通知和手动刷新合并干净配置，保留待保存与在途编辑。
- fix: Windows 安装器在旧卸载前保存完整快捷方式，避免重装升级丢失起始位置和参数；维护事务保留暂停前意图，取消且原安装完整时恢复，开始替换后禁止自动回滚。并发维护与 supervisor 使用串行生命周期锁及已核对进程句柄，等待 worker 真正退出。
- verification: Windows 原生 release 编译成功，隔离 supervisor/双维护 CLI 验证只发送一次关闭、监听关闭后等待进程退出、停止状态取消恢复、旧配置格式重写后恢复运行意图、替换后拒绝回滚及卸载后停止。完整安装／升级未在本机验收，按用户要求由用户下载新版本验证。
- verification: 供应商持久化集成回归 15 项、目录优先级 9 项、服务端目录及模型配置 15 项通过；独立浏览器验证改名后再次保存保留隐藏字段、刷新保留草稿与新会话使用原项目。官方 OMP 会话双向继续写入、只读浏览验收通过，app/server 类型检查通过。

## [v0.6.36] - 2026-10-20

- fix: 修复模型配置变更或控制进程退出后，模型同步持续报 `omp RPC process has exited`、设置页状态一直为红色的问题。控制通道只合并启动中的请求，后续查询会重新启动已退出的进程；启动或协议协商失败后允许再次重试。
- fix: 打开、刷新模型供应商设置及切换服务器时同步查询实时模型，避免刷新只重读配置而无法恢复模型同步。
- test: 新增真实子进程回归覆盖，验证配置变更、意外退出、启动失败和并发查询；补充供应商设置页刷新及服务器切换测试。真实 OMP 查询验证首次及控制进程重建后均返回 19 个模型。
- fix: 包含尚未正式发布的 0.6.35 设置页模型同步状态显示及供应商列表操作调整。

## [v0.6.35] - 2026-10-19

- fix: 设置页显示模型同步状态并移除供应商行拉取按钮 (dbf9542)

## [v0.6.34] - 2026-10-19

- feat: 供应商模型编辑弹窗新增「智能配置」并默认开启：新建模型时按模型 ID 自动查询 models.dev，填入显示名、上下文窗口、输出上限、输入类型、推理能力与推理等级，并显示「正在查询…／已应用 models.dev 数据／已使用本地默认值」；查不到或请求失败时回退本地启发式。编辑已有模型默认不自动改写、需手动开启；关闭开关即取消在途查询，迟到的查询结果不会覆盖已手工修改或已切换的模型。
- feat: 新增只读 host 命令 `models.dev.lookup`（`models` 域、幂等）：服务端拉取 `https://models.dev/api.json`，进程内缓存 10 分钟并合并并发查询，请求超时 10 秒、响应体上限 12 MiB；模型 ID 归一化后支持 `vendor/` 前缀、`[...]` 标签与标点差异，精确命中优先于长度不小于 5 的片段命中，跨供应商按「显式指定供应商 > 模型家族对应供应商 > 其他」排序。
- feat: 供应商 API 格式新增 `google-generative-ai`：`models.yml` 读写接受该值，上游模型列表改走 `/v1beta/models`（必要时回退 `/models`），以 `x-goog-api-key` 鉴权并去掉返回 id 的 `models/` 前缀；界面 API 格式选项与提示同步补齐。
- fix: 保留「模型声明支持推理、但目录没有可配置等级」的真实状态，不再编造 low/medium/high：弹窗显示「模型支持推理，但目录未提供可配置的推理等级」并提供「手动配置」入口，保存时以 `thinking: null` 显式清除旧 thinking 段；推理模式按供应商 API 推断（`anthropic-messages` → anthropic-adaptive、`google-generative-ai` → google-level、其余 effort），仅在该模型尚无等级配置时套用，不覆盖手工配置；清空「推理参数映射」后提交空映射并由服务端删除旧 `thinking.effortMap`，改模型 ID 时仍按原 ID 合并保留未暴露字段。
- fix: 停止生成期间停止按钮显示进行中状态并禁用重复点击；流式、压缩或提交中的会话始终保留停止入口，输入框有内容时发送与停止可同时使用；worker 的 `abort` 先发出 `agent_settled` 让界面先确认已停止，再在后台补齐历史落盘同步（`syncEntriesNow`），历史同步不再阻塞停止反馈。
- fix: 新增会话活动看门狗：会话流订阅期间按 1 秒周期读取一次会话状态（每会话最多一个在途请求、3 秒超时，停止、关闭或断开订阅时取消），把刷新或断连后遗漏的 busy/compacting/idle 状态校准回来；`agent_settled` 到达时立即按 idle 处理并取消在途校准。
- test: 补充 models.dev 查询映射与匹配优先级、Google 上游模型列表拉取、models.yml 保存时清除 thinking/effortMap、推理模式推断、智能配置开关/迟到结果/取消、停止按钮进行中状态与看门狗单飞取消、`abort` 先确认后同步历史的回归覆盖。
- verification: `npm run typecheck` 通过（protocol / omp-worker / tui / relay 构建及 server / admin / app 类型检查）；本机受限环境无法执行完整 `npm run validate`（测试子进程被沙箱拒绝 spawn），lint、后端测试、前端全量测试与生产构建以 CI 与发布工作流结果为准。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.34`；官方 OMP 会话目录与格式不变。

## [v0.6.33] - 2026-10-18

- feat: 设置新增「供应商」页（位于「模型」与「Agent」之间），直接读写官方 `~/.omp/agent/models.yml` 的自定义供应商与模型；支持按上游 `/models` 拉取并区分新获取/上游已删除、编辑上下文窗口/输入类型/推理等级与参数映射、新增/编辑/删除供应商和模型。保存走 server host 命令，原子写入并保留 `.bak` 备份，未知字段原样保留；界面沿用 OMPiUI 设计系统。
- feat: host 命令新增 `models` 域（`models.providers.get/save/delete/fetch`）：读取失败以错误字段返回而不抛错，写入串行化并原子替换；上游拉取带 15 秒超时与 2MB 上限，读取与拉取都不修改配置。
- fix: 供应商里改模型 ID 时把原 ID 一并提交，服务端按原 ID 合并，保留界面上没有暴露的 `cost`/`compat` 等字段；设置页订阅 `models.updated`，`models.yml` 被 omp CLI 改写后重读并取消待执行的防抖保存，避免过期草稿覆盖外部改动。
- test: 补充 models.yml 读取/合并/改 id/删除/备份/上游拉取与失败回退，以及供应商设置、模型选择、模型配置弹窗的回归覆盖。
- verification: `npm run validate` 通过：typecheck、lint、后端测试、前端全量测试与生产构建均成功；修复追加供应商映射、外部变更重读与测试隔离的定向回归；安装包与实机升级以发布工作流和设备验收为准。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.33`；官方 OMP 会话目录与格式不变。

## [v0.6.32] - 2026-10-17

- fix: Windows 下配置命令与 RPC 客户端共用 OMP 入口解析；npm shim 只用于定位入口脚本，脚本交给 shebang 指定的 Bun/Node 解释器执行，含空格和 `&` 的会话路径保持单个 argv，JSON 参数不再经过 cmd.exe 重解析。Windows 环境键统一大写，PATH 只剩 POSIX shim 时明确报错。
- fix: OMP 版本探测改为与 RPC 客户端共用入口解析并按 argv 直接拉起，不再由 cmd.exe 拼行；`OMPI_OMP_BIN` 指向带空格的 npm shim（如安装路径含空格）时能正确读出 `omp --version`，会话迁移和会话打开不再因「无法确定 OMP 版本」中止。
- fix: 聊天虚拟列表在生成测量行前按当前行数和测量缓存校验索引，阻止过期范围把空项送入 directDomUpdates 后触发 `Cannot read properties of undefined (reading 'start')`；正常范围保留缓存引用，不增加数组复制。补充缩短、清空和恢复的回归覆盖，并在真实聊天组件中注入过期索引验证 todo 更新、折叠和滚动。
- fix: 对齐官方 OMP 扩展 UI 的 widget/status 字段，按稳定组件标识更新并正确移除，修复扩展面板出现请求 ID、空白卡片堆积和状态文字丢失；面板只显示可读内容，过滤终端颜色控制码和空输出，补齐中英文提示。
- ui: 模型 Read 等工具返回的图片改为紧凑缩略图，点击即可在遮罩层放大查看；保留原图清晰度，支持缩放、拖动和关闭，不增加标注或编辑功能。统一内嵌、历史和需认证图片的预览入口，查看期间阻止工具自动收起，非图片附件行为不变。
- ui: 重整管理页的运行环境与项目信任，使用明确的状态和策略说明；运行时设置按用途分组，高级选项默认折叠，未配置项明确沿用运行时默认值。
- ui: 保留并重排会话资源与会话命令，资源按能力与上下文分类，命令按用途展开并说明作用；改善长会话名称和窄屏布局。移除管理页的“模型与提供商”调试面板，独立模型设置入口不变。
- fix: 修复手机窄屏下长目标文本撑破截断范围的问题；目标内容可收缩并显示省略号，紧凑模式收起状态长标签，保留计时、操作按钮和完整目标编辑。
- fix: 故障诊断弹窗新增“不再提示本次报错”，持久化隐藏弹窗及右下角入口，刷新和新故障不再打扰；保留本地报告与原有诊断收集逻辑。
- fix: 移除失效的“使用宿主机 Pi SDK”开关及旧 SDK 环境配置，改为说明官方 `omp --mode rpc` 与 `OMPI_OMP_BIN`；保留官方 OMP 的 `PI_CODING_AGENT_*` 配置。
- refactor: 健康检查和 worker 握手统一为实际 `ompVersion`（未知为 `null`），删除伪 SDK 验证／回退元数据，能力来源统一为 OMP RPC／扩展；前后端协议升至 3、worker 协议升至 4，需配套升级，官方 OMP RPC 和会话格式不变。
- chore: 修正 OMP 开发／测试入口、扩展夹具依赖及运行时架构说明；保留 PiUI 类型溯源，不再将本地类型声明描述为正在使用 Pi SDK。
- test: Windows 入口解析断言按规范路径比较，新增 script／npm-shim／path-shim／环境变量／Bun 运行时 shim 五种入口的启动回归与真实 RPC 入口验收；临时目录为 8.3 短名（CI 的 `RUNNER~1`）时不再因路径拼写差异误报。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.32`；官方 OMP 会话目录与格式不变。

## [v0.6.31] - 2026-10-17

- fix: 修复 #319，隧道 pong 准入不再把数据面背压误判为硬熔断。
- fix: 修复 #320，父会话保留已有子代理消息块缓存，避免同步时退化为整段历史重下。
- fix: 修复 #321、#323，目标附图和异步合并遵守 16 MiB 附件总量限制，省略态图片不再被错误复用为编辑附件。
- fix: 修复 #322，删除排队图片时不再先下载完整原图；保留编辑操作所需的图片数据。
- fix: 修复 #324，终端输入负确认采用退避重试，避免背压期间反复重传同一输入片。
- fix: 修复 #325，终端退出后仍可回放尚未读取的尾部输出。
- fix: 修复 #326，原生 HTTP 客户端对 GET/HEAD 字符串拒绝值正确执行网络重试。
- fix: 修复 #327、#328，Tailnet 网桥的空闲与响应头期限不再中断持续单向下载或早于 packages 命令预算。
- test: 补充 pong、背压、终端输入/回放、附件和 HTTP 客户端回归覆盖；修复跨层数据流问题 (9328744)。

## [v0.6.30] - 2026-10-16

- fix: 完成剩余网络审计与状态同步修复 (453d41b)
- fix: 完成退出背压与终端隧道恢复修复 (b9b261b)
- fix: 处理 #304–#308、#310–#317 共 13 项问题；退出排空遵守 IPC 背压，大响应保留事件容量，取消作业及时归还响应预留并独立限制底层执行数量。
- fix: 终端重连等待已交付 xterm 的输出结算后再续传；隧道两端显式计量 pong 并约束积压；Go 网桥补充 HTTP 与升级连接的空闲回收期限。
- fix: 协议问题自动进入长周期恢复探测并显示中英文通知；重复 bash 补丁不再逐帧通知或作废在途快照，收敛逻辑使用合并后的状态。
- perf: 历史预取只缓存引用页，前台阅读时才还原大条目；目录请求共享缓存与在途结果、独立取消并隔离服务器 generation；配对邀请隐藏、过期或兑换后停止请求。
- fix: HTML 预览超过资源预算时显示截断提示，避免将部分加载误认为完整页面。
- verification: 类型检查、lint、全部后端测试、`go test ./...` 与生产构建通过；lint 为 0 error、6 条已有 warning，后端有 2 项按配置跳过。前端默认全量并发曾遇到未改动的设置备份测试 5 秒超时，单独复现通过，随后以 `--maxWorkers=4` 运行全部 1399 项测试通过。安装包构建与实机升级仍以发布工作流和设备验收为准。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.30`；事件协议及官方会话目录、格式不变。

## [v0.6.29] - 2026-10-16

- fix: 聊天时间线缩短时过滤过期的 resize pin，避免虚拟列表保留越界行。
- docs: 补充网络与流量审计的生产量级判断依据，避免把已受硬上限约束的边界误报为故障。

## [v0.6.28] - 2026-10-16

- fix: 锁定包含 `maxFragments` 服务端选项声明的 `@types/ws` 版本，确保 Linux/Windows CI 类型检查与运行时配置一致。
- docs: 记录第四轮网络修复验收结果 (41d803d)
- fix: 显示移动端故障报告关闭按钮 (49f37d5)
- fix: 按事件连接状态展示在线情况 (9865255)
- fix: 约束网络传输预算与连接生命周期 (c55d1db)
- fix: 收敛工作区监视与历史预取 (d20b43a)
- fix: 稳定事件流重同步与断线恢复 (1b4239b)
- fix: 有界化会话读取与恢复 (6b2323f)
- fix: 有界化 Worker 消息与 IPC 流 (0fc8780)
- fix: 限制文件浏览与 HTML 预览资源 (571e4be)
- fix: 保证终端输入输出可恢复 (7a77434)
- fix: 完善诊断报告共享与审计 (7835d81)

## [v0.6.27] - 2026-10-15

修复流式回复期间出现 `Cannot read properties of undefined (reading 'type')` 并导致聊天页面崩溃的问题。

- fix: 修复流式消息内容空位导致的页面崩溃 (84117af)
- fix: 接收端不再为尚未到达的内容块提前扩长数组；缺少前序块时保留当前消息并只读恢复完整快照。
- fix: 保留空参数工具调用的内容块，正确同步清空后的参数，避免内容下标缺口。
- test: 增加逐帧聊天渲染、缺块恢复、历史水合和真实 worker 到前端的无损往返回归。
- verification: `npm run release:prepare -- 0.6.27` 的完整校验通过，前端 1349 项测试全部通过；lint 为 0 error、6 条已有 warning，官方 OMP 环境验证有 1 项跳过。发布选择逻辑的 12 项测试通过；安装包构建及实机升级仍以发布工作流和设备验收为准。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.27`；事件协议与官方会话格式不变。

## [v0.6.26] - 2026-10-14

修复本轮开放的 #233–#257 共 25 项网络审计问题，覆盖背压与容量预算、取消回收、终端输入确认、隧道帧顺序、历史恢复及原生桥接。

- test: 限制服务端测试文件并发，避免 GitHub Actions 上的终端与跨进程测试争用导致任务超时 (b1ce21b)
- test: 显式推进目录时间戳，稳定 Linux 上的过期游标回归 (f628ef5)
- fix: 显式标注多区间流的取消信号参数，修复 Linux 冷构建类型推断 (8f4e861)
- fix: 发版记录按最新稳定版本选择基线 (531f41c)
- docs: 统一本轮新增代码注释为简体中文 (478dce1)
- fix: 子代理保留窗口刷新从窗口起点续读 (f961900)
- fix: 预览首条也遵守完整 JSON 页字节预算 (890be03)
- fix: 明确未发送会话打开的取消与租约结算 (6b65827)
- fix: 在执行 worker 命令前预留有界出站容量 (9d201e5)
- fix: 对 OMP stdin 写入实行背压与可撤销排队 (a7e0b51)
- fix: 原生 WS 桥按未消费消息实施背压 (9aac29d)
- fix: 统一 WS 流量预算与终端输入确认 (1d883c1)
- fix: 区分隧道 upgrade 正常 EOF 与异常关闭 (f1e2b9d)
- fix: 确保 relay 控制帧先于对应正文发送 (cb83d83)
- fix: 保持 relay 连接 ID 与二进制帧一致 (96d8d57)
- fix: 保持重同步期间事件游标单调前进 (71e9896)
- fix: 共享历史预取并取消无人消费的分页 (619aac0)
- fix: 在共享 host 读取无人消费时取消正文 (4e83450)
- fix: 让后端启动探测按故障类型有界重试 (22a9a86)
- fix: 服务器切换时取消旧 HTTP 响应正文 (331115a)
- fix: 限制工作区监听 IPC 积压并保留失效通知 (3130b99)
- fix: 限制文件写入排队并支持取消 (5d5631b)
- fix: 修复 HTTP 入站额度泄漏与容量拒绝响应 (c2a217f)
- fix: 约束文本搜索结果与取消后的资源占用 (23ddfaf)
- fix: 修复静态多区间响应背压与断连清理 (007f771)
- fix: 修复惯性历史滚动并加入渐进预加载 (593fece)
- fix: 修复历史同步导致的聊天白屏 (5aa7625)
- fix: 修复弱网历史加载卡顿与阅读位置闪动 (de3c156)
- verification: `npm run validate` 通过，前端 1343 项测试全通过；lint 为 0 error、6 warning。正式安装包、Android 签名产物及实机运行仍以发布工作流和设备验收为准。

## [v0.6.25] - 2026-10-14

- fix: 清理服务器切换后的重同步状态 (754b3ca)
- verification: 本地类型检查、lint、项目回归测试及生产构建通过；lint 有 5 条 warning，官方 OMP 环境验证有 1 项跳过。Windows 便携产物已构建；跨平台安装包与 Android 产物由发布工作流生成，不以构建成功代替实机安装验收。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.25`；事件协议与官方会话格式不变。

## [v0.6.24] - 2026-10-14

继续收敛跨层流量与会话状态边界：为事件恢复、搜索、Git 与静态资源读取补上并发合流和容量上限，超大帧只保留控制语义。

- fix: 事件重同步增加去抖与并发闸门，单个控制帧不再触发无上限全页重拉；超大事件只发送 `payload_omitted` 控制帧并推进游标，多订阅者扇出不再重复序列化，断线重连也不重复回放同一帧。
- fix: 子代理收到控制帧后主动拉取权威 state，工具不再永久停在旧状态；非 session 流保留专用恢复语义，session 流走合并的分支刷新。
- perf: 事件订阅增加进程级预算，超限订阅直接丢弃并保留连接，重连不会重置预算；终端 attach 重放按 TextWindow 分块读取并保持 UTF-8 边界，减少全窗口物化与重复扫描。
- perf: Tailscale 状态探测增加短窗口缓存与单飞，降低后台探测开销；恢复类请求按同查询合并。
- fix: 文件名与文本搜索、session state、磁盘会话查找按同查询单飞合并，调用方取消只影响自身等待；单文件 diff 直接按目标路径计算，不再先执行整仓 diff。
- fix: 为会话注册表、子代理转录、扩展 UI、终端输入、WebSocket 出站队列、乐观 bash 待处理项与待处理会话缓存增加容量和时效边界；`session.open` 参数校验与会话列表字段收口。
- fix: 中转增加待激活连接回收、总量约束、控制通道背压、请求中止清理与生命周期进度检查。
- fix: HTTP 增加输入与输出全局预算，合法大响应不再被过早拒绝；诊断报告的 form 编码按实际字节计量；文件写入支持不回显正文。
- fix: Tauri 入站桥消息限长；流量审计补齐生产开关、脱敏缓存、预览生命周期与 WebSocket 消息记录；终端布局持久化改为去抖写入并限制目录历史数量。
- fix: 静态资源支持受限 multipart Range 响应并保留单区间兼容；有界历史分页合并保留已加载的更早条目与 `historyWindowed` 游标，不因新到的最新页丢失分页状态。
- fix: 发版前修复本批引入的两处回归：`e6735b8` 把状态刷新挂到 branch 恢复请求之后，branch 慢或挂起时实时消息的 `streaming→persisting` 收敛会被无限推迟，现改回立即调度；`http-output` 全局预算已按 128 MiB 上调，测试改为从模块常量推导额度，不再钉死旧数值。
- verification: 类型检查、lint 与生产构建由 CI 执行；本批回归在 CI 暴露后按单文件复现并修复（app `recoveryOrdering`、server `http-output`）。安装包实机升级与线上负载不以源码验证或发布构建冒充验收。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.24`；事件协议版本仍为 2（`ompiui.events.v2`），官方会话目录与文件格式不变。

## [v0.6.23] - 2026-10-13

- test: 等待文件监听初始重扫事件 (6be9401)
- test: 释放中转交叉验证客户端的上游连接 (363b7f5)
- fix: 保持 worker 预热探测并对齐刷新验证 (20f2fb6)
- chore: 发布 0.6.22 (484ec26)
- fix: 完善网络增量传输与有界读取 (6ae72b8)
- fix: 修复二轮网络审计确认的问题 (25fd785)
- fix: 修复网络重连与传输缓冲放大 (ceb73b4)
- test: 对齐发布校验夹具与现有生命周期 (3aca3da)
- chore: 发布 v0.6.21 (988f0f3)
- chore: 隔离脚本仅使用官方目录变量 [skip ci] (2e2cbbb)
- fix: 对齐官方会话目录并保留旧别名历史发现 [skip ci] (da49de4)
- fix: 保留历史去重与子代理进度成果 [skip ci] (99ffadb)
- fix: 完成问题集成收尾与备份校验 (ddd1829)
- fix: send oversized body errors safely on both Node and Bun (0afdb58)
- fix: preserve stop intent across idempotent native update maintenance (8c4c9e0)
- fix: serialize desktop startup and background setting changes (2415be9)
- fix: close integration lifecycle framing and bounded-stream gaps (5b161ff)
- feat: manage optional native Windows background lifecycle (102ae0f)
- fix(privacy): restrict fault report server log lines to fixed lifecycle labels (43378d9)
- feat: 增加后台登录启动与异常恢复设置(#63 UI 通道) (4fd4ec7)
- fix(desktop-packaging): 打包脚本不经 shell 传参,修复含空格路径截断与桥接校验 (2c53774)
- fix(admin): graceful stop with forced-kill visibility; safe install token wait and systemd quoting; isolate admin test env (c730eed)
- fix: support explicitly trusted direct reverse proxies (0ec6ee5)
- fix: 中转 upgrade 共用每隧道令牌桶并返回 429;显式可信代理后才解析 XFF;配对键对齐规范化 (ef9ce85)
- fix(server): 修复超限 413、公网基址回退、幽灵流淘汰与 WS 子协议协商 (#68) (193446c)
- fix: 保留鉴权失败原因并在端点变更时重置健康结果 (adeaff5)
- fix: protect editor drafts and reject malformed settings backups (a9ca942)
- fix(chat): 队列条目回填保留图片附件,流式文本追加改为边界token判定 (5f9e92e)
- fix(chat): 带图片的排队消息回填不再静默清队,改为明确提示 (230f289)
- fix(chat): 修复流式列表/标题标记泄漏,本地文件链接授权与错误提示 (705d407)
- fix: 子会话解析跨服务器切换时不回填缓存也不登记索引 (78d17ec)
- fix: 修复切换服务器后的会话状态串写(#70 02-05) (c3fc8ec)
- fix(server): 修复 #69 工作区 git 子目录路径、ref 选项注入、终端额度与监听进程重启 (41a2b2c)
- fix(server): open 超时/取消后保留晚到响应,关闭无归属孤儿 runtime 后再释放租约 (f03ecff)
- fix(omp-worker): 背压暂停时仍记录子进程退出,rpc_chunk 按字节拼接后整帧严格解码 (60e49ec)
- fix: 显式登记官方会话目录并移除死的只读复制分支(#66.03/#66.08) (d5be4dd)
- test: 契约测试不再人为设置冲突的 PI_CODING_AGENT_DIR(#66) (2d9d3c6)
- fix: 修复 OMP 会话目录互通与只读浏览边界(#66) (9a6c50d)
- chore: 发布 v0.6.19 (48b3614)
- fix: 修复 Windows npm 入口保存模型角色失败 (0d05cc1)
- feat: 完善两套终端管理界面与项目展示 (c3dc188)
- chore: release 0.6.18 (4ada77c)
- fix: 修复磁盘会话刷新重复传输完整历史 (579e92c)

## [v0.6.22] - 2026-10-13

降低弱网重连、主消息流、文件浏览与转录恢复的重复流量，逐项处理 #84 至 #140。

- feat: 新增后端持久化的子代理预览思考开关，默认关闭实时及磁盘回填思考；聊天设置可远程修改，完整子会话界面与原文件思考数据不受影响。
- fix: 主文字、思考、工具字符串参数与子代理进度使用增量传输；订阅差异重放、退避轮询、共享探测、刷新 single-flight、显式 live 恢复和完整快照标记避免重复整页重拉。
- fix: RPC、IPC、事件历史、终端与桌面桥设置字节预算；终端使用块窗口与短窗口合并，relay 配额等待、实际帧计量、升级前缓冲及上游 drain 背压保护慢连接。
- fix: 原生 JSONL 使用异步增量扫描、摘要索引与有界缓存；历史阅读窗口最多 400 条或 8 MiB，可继续读取更早历史及返回最新；大图按需分片，树导航采用轻量平铺传输并保留原拓扑。
- fix: 附件及文件写入上传前验证容量，队列单条删除不重传剩余图片；文件/Git 事件合并，搜索与诊断报告有界，静态资源支持 gzip、304 与 Range。
- docs: 57 项全部逐条评论关闭，4 项按不成立的故障前提说明复核依据；修复范围与验证说明见 `docs/network-release-audit.md` 和逐项记录。
- verification: 类型检查、相关 Node 与前端回归、前端生产构建及 Rust 编译通过；隔离官方 OMP 验证确认终端与 UI 双向续写及浏览只读。安装包实机升级、设备长期锁屏与线上负载不以源码验证或发布构建冒充验收。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 统一为 `0.6.22`。本批升级到协议 2（`ompiui.events.v2`），前端、服务端与 worker 必须配套升级；官方会话目录和文件格式不变。

## [v0.6.21] - 2026-10-12

修复并发子代理通信与流式预览卡顿，补齐代理来信、实时活动和刷新恢复。

- fix: 子代理累计消息先合并再转为增量分块，每块正文最多 4096 字符；移除预览不消费的工具参数、结果、图片和模型签名，减少重复大包，原生会话历史与主时间线最终结果保持完整。
- fix: 主对话流式更新不再重复传输 SDK 附带的累计消息副本；子代理事件按稳定身份去重，进度更新保留转录引用，未消费的事件不触发转录重渲染。
- fix: 历史加载骨架不再遮挡已到达的实时工具进度，补充思考活动预览；超长正文默认显示有界预览，可展开查看全文，流式状态显示最新尾部。
- fix: 代理间 IRC 消息支持独立分块与显示，并及时同步主会话时间线；插入来信不会重置正在生成的助手回复身份和偏移。
- fix: 消息边界生成独立预览身份，避免重复回复 ID 覆盖旧正文；失败或中断的空终态快照保留已收到的部分输出。
- fix: 刷新或中途订阅先显示恢复尾部，任务结束后只读原生历史补齐；迟到的历史响应不覆盖运行中的转录。
- docs: 新增子代理预览传输协议、恢复语义与隔离验证命令说明。
- test: 修正历史预览的临时目录登记、取消打开后的租约收尾等待及文件编辑测试的服务器身份夹具，恢复完整跨平台 CI 校验。
- verification: 前端 88 项、后端 40 项相关回归、类型检查、针对性 lint 和前端生产构建通过；真实 OMP 十子代理并发验证确认结束前持续输出、全文无损还原及工具终态正确，实测最大预览帧约 28KB；桌面与手机宽度浏览器验收通过。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 版本统一为 `0.6.21`。增量预览需前后端一起更新；本次源码验证未重启或中止现用会话，不代表发行包已完成实机安装验收。

## [v0.6.20] - 2026-10-12

- fix: 修复会话历史增量合并重复追加条目，避免任务和子代理列表成倍显示。
- fix: 修复子代理实时进度不明显及重复事件追加，补充工具、请求和 token 状态展示。
- fix: 对齐官方 `PI_CODING_AGENT_DIR` 与显式 `--session-dir` 登记，旧 `OMP_AGENT_DIR` 仅用于历史会话根发现和校验，不转译成新会话的默认写入目录；浏览、刷新、草稿和只读 TUI 镜像不启动写 runtime，移除失效的只读复制提示，保持官方终端与 UI 双向继续原文件（#66、#28）。
- fix: stdout 背压期间仍处理子进程退出；超时或取消的会话打开保留租约直到晚到结果收尾；RPC 分片先按字节拼接再解码，兼容单片和未声明长度的既有帧（#67、#40）。
- fix: Node 与编译后 Bun 的超限请求明确返回 413；兑换优先配置的公网基址；只在显式可信代理或内部隧道标记下采用转发来源。HTTP 与 WebSocket 升级共享中转限速，事件订阅不再创建可挤掉他人历史的幽灵流，子协议只协商 `ompiui.events.v1`（#68、#39）。
- fix: Git 子目录工作区统一相对路径与补丁，避免恶意 upstream 选项截断文件；已退出终端不占活动额度；监听子进程异常退出后受控重启并恢复单调文件事件修订号（#69）。
- fix: 跨服务器会话列表、子会话解析和路径风格缓存按身份失效，陈旧侧边栏动作不能写到另一服务器；端点变更时重置健康检测并保留真实鉴权失败原因，延续既有授权恢复与连接状态语义（#70、#34、#36、#38、#42）。
- fix: 文件预览、跨面板打开、面板关闭和历史导航保护未保存草稿；跨服务器保存阻止提交并保留草稿；设置备份在任何写入前校验全部九个模块和嵌套结构，保留合法旧版备份兼容（#72、#37、#36）。
- fix: 队列回填保留图片与纯图片内容；流式列表、任务列表、标题及嵌套列表不再泄漏标记；桌面本地文件链接授予路径权限并显示打开错误（#71、#35、#74）。
- fix: 管理器优先身份核对后的 HTTP 优雅关闭并覆盖后端清理预算；安装等待非空管理令牌并正确转义 systemd 路径；Windows 打包不经 shell 拼接参数，检查缺失的内嵌 bridge（#73、#41、#74）。
- privacy: 故障报告只保留固定生命周期标签，不上传日志异常正文、路径或任意控制台文本；报告头及中英文承诺与实际收集策略一致（#75）。
- feat: Windows 官方桌面 exe 增加可选登录后台启动与异常退避恢复、持久化用户停止意图、单实例监督及安装和更新维护入口；仅管理本应用安装目录中的 `omp-worker.exe`，不扫描或中止独立 OMP 任务（#63）。
- chore: 根包、全部 workspace、互依赖、npm 锁文件及 Tauri/Cargo 版本统一为 `0.6.20`；#70.01 所述本地依赖暂存状态已恢复正式包路径，本轮未重新安装依赖，不作为源码修复计入。
- verification: 本轮仅做源码与 Git 静态核对，未运行测试、构建、验证脚本或应用。前一轮已有记录包含 OMP 双向续写和浏览只读、网络错误响应、终端与监听恢复、管理器收尾、打包和原生维护场景；这些历史记录不代表本轮最终修改已运行验证。Windows 重新登录及完整 NSIS 安装、升级和卸载仍需发行包环境验收，不以维护命令演练或发行构建成功冒充实机验收。
- note: 现有队列清空和重放 API 在重放失败时仍非事务操作，本轮保留既有边界，不将附件回填修复描述为队列事务保证。

## [v0.6.19] - 2026-10-12

修复 Windows npm 入口保存模型角色返回 500，完善后端与中转终端管理界面。

- feat: 重做后端管理 TUI，增加全屏布局、命令面板、网络配置表单、凭证遮蔽和脱敏日志；支持接入现有管理器，保留进程所有权边界。
- feat: 新增自建中转管理 TUI，支持服务启停、在线隧道与转发连接查看、路由编辑、密钥轮换、断开与删除；配置保存后显式重启生效。
- test: 增加终端布局、键盘确认、实际后端进程和中转密钥回归验证，以及隔离的 PTY 截图验收脚本。
- docs: README 改为项目展示和使用指南，加入四张真实 TUI 演示截图；实现细节与开发流程移入独立文档，并更新中转的构建与容器部署说明。
- fix: 对齐新版 OMP 的 Windows 短路径展开规则，修复官方会话列表发现及旧会话迁移目录匹配；浏览继续只读。
- fix: 模型角色配置遵循显式 `OMPI_OMP_BIN`，直接通过 Bun/Node 调用 Windows npm shim 指向的 CLI，修复完整 JSON 保存返回 500；配置读写与会话运行使用一致的 Agent 目录。
- test: 增加模型角色 JSON 原样传递回归，以及真实 OMP npm、原生二进制和编译后 Bun 后端的隔离保存、读回、修改与清空验收，并纳入必需 CI。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.19`。

## [v0.6.18] - 2026-10-12

- fix: 修复磁盘会话刷新重复传输完整历史 (579e92c)

## [v0.6.17] - 2026-10-12

恢复手机扫码与粘贴自动配对，补齐旧会话迁移和桌面后端启动状态。

- feat: 手机认证页新增原生相机扫码和完整配对信息输入，支持从桌面状态文字、Markdown 与连接分享链接中自动解析；扫码或粘贴成功后自动兑换认证、保存并选中服务器，跳转到服务器列表，不再打开空白连接表单。
- ui: 移除手机认证页多余的“添加服务器连接”跳转按钮；Tailscale 登录完成后停留在认证页，配对失败保留输入和错误提示。
- fix: 新增 `npm run sessions:migrate -- --cwd <项目路径> [--apply]`，显式迁移旧私有会话到官方 OMP 目录，修复升级后终端仍无法发现旧任务的问题；迁移前备份，保留会话身份、子任务、附件和旧路径兼容，浏览与刷新保持只读。
- fix: 迁移前探测实际 OMP 版本，兼容 `18.5.0` 起临时目录优先匹配的新规则；版本无法确认时停止迁移，避免写入错误的项目目录。
- fix: 修复桌面后端启动阻塞，新增可查看的启动状态与诊断信息。
- fix: 修复已完成工具仍残留加载状态的问题。
- test: 补齐原生会话目录的 home、临时目录、绝对路径及目录别名测试；CI 在 Windows 和 Linux 上使用标定版本与官方最新稳定版 OMP 验证目录契约、按 ID 恢复和双向续写，并纳入必需验证汇总。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.17`；按用户要求，本次发版未重新执行本地测试。

## [v0.6.16] - 2026-10-11

降低远程会话的重复流量，保留完整工具结果、历史和重连恢复。

- fix: 工具进度不再重复传输调用参数和全体子代理结果；子代理进度与恢复快照只保留界面使用的状态字段，工具输出更新不再逐帧触发状态查询。
- fix: 活跃会话历史改为增量刷新；历史改写、分支切换或缓存失效时回退完整分页，保留已加载历史、实时思考和分页游标。
- ui: 流量排行榜保留实际命令名，分别显示提交、接收和单次峰值。
- fix: 优化目标消息标记，支持目标栏粘贴图片；完善许可处理与云端交付验收。
- ci: 预构建完整跨平台产物并复用匹配的发布构建，修正文件与 Git 通知测试的跨进程等待。
- test: 新增大载荷量化、工具进度、完整结果、状态恢复、历史增量和分页竞争回归测试。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.16`。

## [v0.6.15] - 2026-10-11

修复本地发送消息前的长时间等待，保留官方 OMP 会话互通和浏览只读，并加速跨平台验证。

- fix: 移除打开、发送、复制、删除和关闭会话时的全局终端进程扫描，以及每秒探测触发的 runtime 强杀，消除 Windows 下进程查询带来的数秒等待。
- fix: 浏览、刷新和草稿同步保持只读；主动继续会话时读取原文件最新历史并备份，保留官方 OMP 与 UI 双向发现、恢复和继续写入能力，不隐式恢复其他会话。
- fix: 校准崩溃、重连和后台探测后的运行状态，停止已结束子代理的虚假运行展示，补齐 worker 生命周期诊断；限制子代理继续递归派发，不降低第一层并发上限。
- ci: 按共享依赖构建、后端分组、前端四分片、前端构建及结果汇总分层并发运行，按系统复用编译产物，保留跨平台覆盖和原检查名称，补齐 relay 测试。
- test: 跨平台 CI 的 20 项任务全部通过；真实 OMP 隔离验收确认浏览不改变原会话内容和修改时间，双方可继续原生会话。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.15`。

## [v0.6.14] - 2026-10-11

- test: 增加桌面服务启动验收脚本 (daea4a9)
- fix: 将工作区监听隔离到独立进程 (54af694)
- fix: 修复 Windows Bun 网卡名称乱码 (a29dc49)
- fix: 校验远程配对的实际监听地址 (3c41922)

## [v0.6.13] - 2026-10-11

修复高并发任务的事件转发与子代理状态恢复，新增可分享的自动故障诊断报告。

- fix: RPC stdout 分批解析，主任务和子代理的累计消息快照合并转发；IPC 发送增加背压和心跳优先调度，仍在通信的 worker 不再仅因心跳帧延迟被误判失联；保留真正卡死的看门狗检测，不通过延长超时掩盖问题。
- fix: 识别官方进度帧中的 `progress.id`；中断且没有工具结果的命名子代理仍可读取已落盘转录，崩溃后停止虚假的运行状态与计时，工具最终结果和 bash 增量输出完整保留。
- feat: 自动检测 runtime 崩溃、任务运行期间服务端异常重启和持续失联，弹窗提供报告预览、本地保存、用户确认后的 mclo.gs 上传及复制分享链接；同一故障在事件流和轮询之间去重，正常切换服务器和短暂断网不反复提示。
- feat: 大报告按 UTF-8 字节和行数无损分片，多份报告生成统一索引；上传失败保留成功分片并支持续传，刷新后恢复本地报告和链接，重连后可补齐服务端日志。
- privacy: 仅收集保留范围内的诊断元数据和安全生命周期摘要，排除聊天正文、工具输出、令牌、Cookie 和私有地址；第三方上传不携带后端鉴权头，日志缺失、保留范围和收集限制明确标注。
- test: 1447 项全仓测试、类型检查和生产构建通过；手机与桌面的故障报告流程通过浏览器验收，Bun 编译产物的 IPC 顺序、心跳、背压和最终 flush 冒烟检查通过。浏览器验收拦截第三方上传，不传播真实用户日志。
- test: 跨进程文件锁测试改为明确通知子进程释放，并在启动时监听退出，修复慢 runner 漏接退出事件导致 CI 挂起的竞态；业务锁实现不变。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.13`。

## [v0.6.12] - 2026-10-11

补齐共享会话安全关闭流程，作为本轮最终稳定版本。

- fix: HTTP 连接排空后取消短关闭截止计时，worker 保存与 runtime 退出使用独立的 20 秒清理预算，避免端口已经释放却在保存历史期间被强制退出；保留卡死清理的兜底截止。
- fix: 保留 `0.6.11` 的双向会话互通、浏览零写入、终端进程退出检查、接管备份和禁止 RPC 自动恢复；不通过私有任务副本或禁止互通规避写入安全。
- test: 新增正常延迟清理与卡死清理回归；编译产物验收增加真实 OMP runtime 的优雅关闭路径。
- chore: 全部 workspace、Tauri 与锁文件统一为 `0.6.12`；`0.6.11` 保留为预发布，稳定更新以本版本为准。

## [v0.6.11] - 2026-10-11

修复会话互通的数据安全与桌面后端启动期间的关闭竞态。

- fix: 新会话使用官方 OMP 原生目录，终端与 OMPiUI 双向发现和恢复同一会话；保留旧托管目录兼容。
- fix: 查看、刷新历史与草稿同步只读磁盘，不启动写入进程；接管原会话和提交写命令前确认 OMP 终端已退出，探测失败或进程仍存活时阻止写入，接管前逐字节备份历史。
- fix: 禁止 RPC 启动自动恢复其他会话；模型和认证控制进程使用无持久化模式，避免无意保存用户历史；Windows 优先直接执行 OMP 二进制，保留带空格的会话路径。
- fix: 优雅关闭钩子在 HTTP 监听前绑定，启动恢复期间收到关闭请求也会停止服务，不再返回成功却什么都不做；重复关闭等待同一份清理。
- test: 新增终端进程存活、原文件备份、只读浏览及早到关闭请求回归；整仓类型检查、lint、测试与生产构建通过。
- docs: `AGENTS.md` 明确双向互通、浏览零写入与终端退出后才能接管的约束；全部 workspace、Tauri 与锁文件统一为 `0.6.11`。

## [v0.6.10] - 2026-10-11

修复流式思考期间工具状态卡住与桌面后端资源查找问题，整理认证和服务器连接入口。

- fix: 实时消息更新不再使历史请求失效，工具完成后的结果可在模型持续思考时正常合入；依据事件游标保留较新的思考内容，兼容重连恢复与 OMP 历史版本变化。
- fix: 桌面壳查找的后端文件名与打包产物统一为 `omp-worker(.exe)`，修复自带服务无法启动；同步 worker 入口、协议常量与日志标识。
- ui: 认证与服务器连接分离；手机登录完成后可进入添加连接，配对链接在连接表单兑换，保留登录诊断、连接失败重试与自建中转配置。
- fix: 修复手机收起输入栏后的滚动遮挡，保留远端已有的草稿持久化、内嵌 Tailscale、模型同步和流量审计功能。
- test: 整仓类型检查、lint、1400 项 JavaScript/TypeScript 测试及生产构建通过；桌面后端打包路径的 Rust 回归测试通过。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.10`。

## [v0.6.9] - 2026-10-10

新增客户端流量审计，便于排查远程连接和内网穿透下的请求量与传输载荷。

- feat: 设置新增「流量审计」，逐条记录后端 HTTP 请求、事件流与终端 WebSocket 消息的载荷大小、状态和耗时，HTTP 重试独立计量。
- feat: 支持按服务器、协议、方向、URL、事件、会话和失败状态筛选，提供大小与耗时排序、单条详情、流量排行、暂停、清空及 JSON 导出。
- perf: 复用业务已解析的实时事件标注消息类型，UTF-8 计量使用固定缓冲；界面通知限频，不额外复制或提前读取 HTTP 响应正文。
- privacy: 正文预览默认关闭，开启后限长并遮蔽常见凭证；记录只留在客户端内存，保留最近 2000 条明细，累计统计不受明细淘汰影响。
- docs: 明确统计范围为当前客户端的应用载荷，不包含其他客户端、静态资源、传输头、TLS、穿透开销或网络重传，不等同于穿透计费流量；本版不改变原有流式传输协议。
- test: 101 项相关回归、前端 159 个测试文件和 1091 项全量测试通过；完整发布校验、桌面和手机深浅主题、横屏及最大字号浏览器验收通过。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.9`，保留 `0.6.8` 的手机连接与登录诊断修复。

## [v0.6.8] - 2026-10-10

- fix: 修复 Android Tailscale 启动时报 `no safe place found to store log state`：启动前创建应用私有日志目录并设置 `TS_LOGS_DIR`，避免依赖系统 HOME、工作目录或临时目录。
- test: 调用真实 Tailscale 日志策略验证目录选择、写入与重试状态保留；日志目录不可用时返回错误，移动模块与网关测试通过。
- chore: 统一版本为 `0.6.8`，保留已有 UI、模型同步和手机诊断功能；正式 APK 由 GitHub Actions 生成，授权流程由维护者实机验证。

## [v0.6.7] - 2026-10-10

- feat: Android 服务器设置新增复制及导出登录诊断，可直接从手机取得安装版本、登录阶段、系统退出原因与异常记录，无需 ADB。
- fix: 登录核心调用前同步保存阶段，Go 标准错误输出保留到应用私有文件；重开后可导出 Java 异常及系统提供的退出转储。
- fix: 检测到异常退出后暂停自动状态恢复与 HTTP/WebSocket 路由启动，避免尚未导出诊断就再次闪退；主动登录允许重试。
- test: 29 项相关前端测试、类型检查、Go 模块及网关测试和针对性 Kotlin 编译检查通过；临时脚本验证跨进程重开、暂停恢复、独立导出、退出码 2 与正常退出。
- chore: 统一版本为 `0.6.7`。本版提供远程排障能力，原始手机闪退根因仍需实际诊断记录确认。

## [v0.6.6] - 2026-10-10

- fix: Android Tailscale 授权页面改为由原生主线程启动系统浏览器选择器，打开失败时返回设置面板显示错误。
- fix: Tailscale 启动、登录、状态读取与网络更新调用中的 Go panic 在跨越 JNI 前转换为错误，保留异常堆栈用于排查。
- test: 25 项相关前端测试、类型检查和 Go 移动模块及网关测试通过；新增浏览器模块及原生桥完成针对性 Kotlin 编译检查。
- chore: 统一版本为 `0.6.6`，正式 Android 包由 GitHub Actions 生成。手机闪退尚缺实机堆栈，是否完全消除由测试人员验证。

## [v0.6.5] - 2026-10-10

- fix: Android 内嵌 Tailscale 使用原生网络接口快照，避开 Netlink 权限拒绝造成的启动失败；网络切换时更新默认路由并通知核心重新检查连接。
- ui: Tailscale 未登录时显示配对前登录提示，移除远程设置中的授权二维码；模型与模型角色设置显示连接和同步状态。
- fix: 更新模型与角色配置的缓存、服务端同步和会话状态恢复，修正模型选择与设置界面的状态展示。
- chore: 当前修复统一发布为 `0.6.5`。Go 核心测试已通过，Android 正式包由 GitHub Actions 编译，登录与跨网络连接由测试人员实机验收。

## [v0.6.4] - 2026-10-10

新增应用内 Tailscale 通道，电脑后端与 Android App 自带网络核心；本版交由测试人员进行首次跨网络实机验收。

- feat: Windows、Linux/WSL 后端使用随包提供的 `tsnet` 网关，不再下载或安装 Tailscale 官方客户端；支持官方网页授权、节点状态查询、启用状态恢复与主动断开。
- feat: Android 内嵌 Tailscale 用户态网络核心，HTTP 与 WebSocket 经应用内通道连接电脑，不创建系统 VPN，不需要安装独立 Tailscale App。
- ui: 手机远程增加独立 Tailscale 入口，配对信息使用内嵌节点地址；手机服务器设置提供独立登录和完整配对链接导入，手机不运行业务后端。
- chore: 发布工作流自动编译桌面网关和 Android AAR，并将组件及依赖许可证随发行包提供。
- fix: 合入输入草稿持久化修复，刷新后恢复未发送内容与附件。
- test: 已完成针对性生命周期、鉴权、HTTP/WebSocket 转发、手机入口与布局验证；真实账号授权、跨公网直连/DERP、手机后台与网络切换尚待测试人员验收。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.4`。

## [v0.6.3] - 2026-10-10

对齐 OpenCodeUI 的子代理预览，修复连续工具竖排与首条任务消息缺失。

- ui: 子代理预览改为紧凑的小聊天框，正文与工具按消息关联；工具开始执行即显示运行徽标，结束后原位更新，保留错误状态与可读标题。
- fix: 不同消息 ID 的连续纯工具轮次共用横向徽标流，空间不足时自动换行，不再一个工具独占一行。
- fix: 移除预览的最近 20 组裁剪；长转录保留首条任务消息与有界的最新内容，已完成历史从顶部打开。
- fix: 贴底滚动依据用户先前的位置跟随长输出，手动上滚后不强制拉回；最终回复完整显示，旧正文按开头截断。
- ui: 移除重复状态栏和进度输出，补齐加载骨架、任务说明分隔线与响应式预览高度。
- test: 56 项子代理相关回归、前端 146 个测试文件和 975 项全量测试通过；四份真实转录结构的桌面和手机脱敏回放通过，全仓发布校验与构建通过。
- chore: 根包、全部 workspace、Tauri 与锁文件统一为 `0.6.3`。

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
- fix: 桌面端重新找到随包分发的后端——PiUI 改名后 Tauri 仍在 resource 目录查找 `pi-worker(.exe)`，而打包脚本已产出 `omp-worker(.exe)`，导致桌面版启动本地服务时报「server binary was not bundled」（v0.1.1 起所有桌面安装包受影响）；查找路径与打包产物对齐并加回归测试。
- chore: 补完 PiUI 改名遗漏的 worker 标识——`PI_WORKER_PROTOCOL_VERSION`/`PI_WORKER_HEARTBEAT_INTERVAL_MS` → `OMP_WORKER_*`、`getPiWorkerEntryUrl` → `getOmpWorkerEntryUrl`，worker 与服务端日志前缀 `[piui-worker]` → `[omp-worker]`，协议不匹配报错文案同步更新；均为内部标识，不影响协议帧与 IPC 契约。

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
