# 会话运行诊断日志

用于排查刷新后停止、重连状态丢失、运行实例回收、命令取消及服务端重启。
默认启用，独立于原有服务端文本日志，不需要额外服务或依赖。

## UI 有会话，但官方终端看不到

0.6.11 起新会话已使用 OMP 原生目录；更早创建的会话仍可能保存在
`~/.ompiui/sessions/<项目哈希>/`。升级后继续旧任务会恢复原文件，不会自动迁移，
因此 UI 可以读取它，官方终端的当前项目列表却无法发现它。

先停止该项目会话的写入并关闭其运行实例（包括空闲但仍打开的实例），再显式迁移：

```bash
npm run sessions:migrate -- --cwd "项目绝对路径"
npm run sessions:migrate -- --cwd "项目绝对路径" --apply
```

第一条只预览，第二条先备份，再把会话及附件、子任务目录移动到官方项目目录。
两条命令都会探测实际 OMP 版本，兼容 `18.5.0` 起临时目录优先匹配的规则；无法确认版本时停止操作。
旧目录替换为目录链接（Windows 使用 junction），已保存的旧路径仍访问同一份文件，
也能承受 OMP 的原子文件替换。会话 ID、内容和修改时间保持不变；已有原生会话不覆盖，
重名冲突会在移动前报错。迁移要求两个目录在同一文件系统。
备份位于 `~/.ompiui/session-migration-backups/`，使用 `OMPIUI_DATA_DIR` 时随数据根目录变化。
迁移不会扫描或终止终端进程，也不会在浏览、刷新或草稿同步时隐式执行。
迁移完成后重新打开终端的会话选择器；无需创建副本或更换会话身份。

## 查看与导出

在仓库根目录运行：

```bash
npm run diagnostics -- --session <sessionId>
npm run diagnostics -- --session <sessionId> --since 2026-10-09T18:00:00+08:00
npm run diagnostics -- --level warn
npm run diagnostics -- --event connection --limit 500
npm run diagnostics -- --session <sessionId> --out diagnostic-report.jsonl
```

`--json` 输出 JSONL；`--dir` 指定其他机器复制来的诊断目录。
导出不会覆盖已有文件。按会话查询保留服务端和全局 worker 事件作为上下文。
时间为 UTC，跨启动批次按时间排列；同一进程中的顺序由 `seq` 确定。

## 保存位置与保留策略

- Windows：`%APPDATA%/com.ompiui.app/logs/diagnostics/`。
- Linux/macOS：`~/.ompiui/logs/diagnostics/`。
- `OMPIUI_DATA_DIR` 可覆盖数据根目录。
- 文件名包含日期、启动批次 UUID 与分片编号。
- 默认每片约 5 MiB，最多 20 个文件，保留 7 天。
- 轮转只清理符合诊断日志命名规则的文件，不碰其他日志或会话历史。
- 生命周期记录同步写盘，避免正常重启时丢失尚未刷出的尾部记录。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `OMPIUI_DIAGNOSTICS` | `1` | `0` 关闭诊断记录 |
| `OMPIUI_DIAGNOSTIC_LEVEL` | `info` | `debug/info/warn/error`；debug 增加只读 worker 请求及状态查询 |
| `OMPIUI_DIAGNOSTIC_MAX_MB` | `5` | 每片文件上限 |
| `OMPIUI_DIAGNOSTIC_MAX_FILES` | `20` | 诊断目录最大分片数 |
| `OMPIUI_LOG_KEEP_DAYS` | `7` | 最长保留天数 |

环境变量在服务端进程启动时读取。部署后正常重启服务端即可启用新版记录；
不要为了启用记录中断正在执行的任务。开发模式修改服务端源码可能触发 watch 重启。

## 如何判断问题

每条记录包含 `schemaVersion/time/level/event/runId/pid/seq`。
会话 UUID 是业务身份，不是认证会话令牌。命令、worker 请求、浏览器连接分别有
`commandId/requestId/connectionId`，浏览器页面有 `clientId`。

- `connection.closed → connection.opened → connection.subscribed`：
  浏览器断线或刷新；仅断线不应该导致 Agent 中止。
- `browser.connected.navigation=reload`：页面自报刷新，不是服务端推测。
- `connection.resync`：事件游标缺失、过期或服务端批次变化，需要重新加载。
- `browser.state` 与 `session.activity`：对比浏览器拿到的状态与后端活动状态。
- `worker.request.started.command=abort`：确实向 Agent 发送中止。
- `worker.request.failed.reason=caller_cancelled_request_not_agent_abort`：
  只取消等待请求响应，不代表 Agent 已收到 abort。
- `session.close.requested.reason=idle_ttl`：空闲回收触发关闭。
- `session.reaper.kept`：状态查询失败、缺少明确 idle／settled 答复或仍有工作，保留运行实例。回收还会复查查询期间的访问、活动、命令及运行实例身份，旧空闲答复不能回收新活动。
- `server.stopping / worker.dispose / session.host.disposed`：
  服务端关闭造成的实例销毁。
- `server.started` 的 `runId/pid` 变化：服务端已重启。
- `worker.heartbeat.kill / worker.exited`：看门狗或 worker 异常退出。
- `session.crashed` 的 `workerPid/code/signal/reason`：内层 OMP 进程的退出信息；
  `unexpected_exit` 表示未主动停止。不要将内层 OMP 退出与共享 worker 退出混淆。
- `agent.event.eventType=message_end` 的 `status=error/aborted`：
  模型回复失败或中止；失败使用 `MODEL_RESPONSE_ERROR`，原始错误正文不进入诊断日志。
- `command.status.status=unknown_after_crash`：命令结果因崩溃无法确认。

异常强杀或 watch 重启可能没有完整的停止事件。此时只能结合新启动批次与旧
记录推断重启，不能把没有结束日志当作“已正常完成”。
浏览器 pagehide 是尽力发送，网络已经断开时无法补发；重连会上报前次关闭码。
桌面 Bun 和 Node 的 worker 错误均写入数据根目录的日志。重连和故障状态探测
会重新校准当前运行状态；后端确认空闲且子代理已不在注册表时，遗留条目标记中断。

停止后若已经出现终止的 `agent_end`，且原生状态为 `isStreaming=false`、
`hasPendingAsyncWork=false`，但 `pendingMessageCount>0`、`isIdle=false`，
表示前台已停止、原生队列仍保留，不代表模型继续生成。活动指示与 Stop 按钮
按实际前台／异步执行状态显示；`isSettled` 仍保留原生语义，不因隐藏忙碌提示
伪造完全结束。清除或取回排队消息使用显式队列操作，不要发新消息“解除卡住”，
那会真正启动下一轮。真正的异步工作、压缩与重试仍保留停止入口。

普通 async bash 的启动结果只是官方 job ACK。OMP 18.12.6 实测父回合会发
`agent_end { isTerminal:false, yielded:true, awaitingAsyncWork:true }`：前台已 yield，
但 `hasPendingAsyncWork=true`、`isSettled=false`，不可显示已完全完成或发送 idle 通知。
原生 async-result 会唤醒后续回合；只在最终 `session_settled` 后清除 pending。
读取 job／`proc://` 状态不应确认消费结果，也不能在刷新时重新启动或自行二次回灌。

命名服务不同于普通 job：`ready=false` 或 PID 只表示尚未就绪；真实 ready 超时
保留 `service.timedOut=true` 与日志，官方可能让服务继续 starting，可读状态后由用户
明确目标取消。普通 job 不支持 stdin；服务支持 `write proc://<name>`，空内容是真实 Enter。
`mode=persist` 保持 broker 存活；`detached` 由官方 broker 重新启动并分离服务，可能换 PID，
不是单纯改 UI 标签；`session` 恢复非持久模式，仍按官方共享 broker 的存活规则处理。
关闭视图不是 kill，禁止为了重连批量停止共享／其它 workspace 的服务。


桌面窗口使用可执行文件内嵌的前端；仅更新安装目录的 `web/` 只能更新服务托管网页，
不能修复旧桌面窗口。确认桌面应用版本与实际运行的程序路径，再使用包含修复的桌面构建。

OMPiUI 管理的会话保留原生全局／项目 `task.maxRecursionDepth`，不注入 UI 专用
`depth=1`。原生语义是 `0` 禁止派任务、`1` 只允许第一层、`2` 允许子代理继续
委派到第二层；更深数值按同一边界生效，负数不设递归上限。并发、异步等其他
原生任务设置不被覆盖，`autoResume: false` 与受管 RPC 的无界前台 PTY 限制仍保留。

打开尚未运行的历史会话、刷新和草稿同步走只读路径，不启动会写盘的 OMP runtime。
主动发消息或明确修改会话时才恢复写入；不扫描或拦截官方终端进程。

### 原生 ask 的活动与等待

查看实际 `activeTools` 和 `askUi`：`askUi.available` 仅表示 ask 当前活动且托管原生应答通道可用，`surface` 区分官方问卷 `ask` 与基础 `select/editor`；不代表用户已作批准。扩展面板显示未活动／运行时不可用原因。只读历史预览不应为了探测 ask 启动 runtime；没有运行态快照不能当作已支持。

OMP 18.12.6 实测普通 `rpc` 无 ask，托管 `rpc-ui` 有 ask；`rpc-ui --no-ui` 仍有工具 UI，但扩展 headless；官方禁用 ask 后活动／注册列表均没有 ask。新问卷使用真实 `set_ask_dialog` 和 `extension_ui_response.answers`。旧版本基础 fallback 不提供返回回调；不要声称基本 select 已有 TUI 富组件能力。

隔离 Chrome 与原生进程已验证官方工具结果与答案一致、取消／abort 保留原错误、超时产生 `timedOut`，Plan 下即使 timeout=1s 也保持未决。`ask.timeout: 0` 是官方无期限等待；没有客户端时不能伪造默认审批，只有原生取消／abort／关闭或实际答案能够结算。独立单选附注被 18.12.6 RPC 忽略，接口缺少 `note`，与多选可携带的 `customInput` 不同；这是剩余上游能力边界，不能用普通聊天绕过。


## 工具长时间显示运行中

先按会话查询 `tool_execution_start` / `tool_execution_end`：同一轮模型生成多个工具调用，不代表它们已经同时开始执行。界面使用官方落盘的 `customType=tool_execution_start` 与实时事件区分「等待执行」和「运行中」，按各工具实际开始时间计时；结果到达后立即结束，不使用助手消息时间作为工具开始时间。

已确认的一类阻塞是模型用 `bash` 的 `pty:true, timeout:0` 在前台启动常驻服务。官方 OMP 的自动后台机制排除 PTY 调用，`timeout:0` 又取消执行期限，因此服务一直等标准输入或退出，后续工具也不能开始。这不是模型连续推理了数小时。

OMPiUI 新启动的受管 runtime 通过显式进程级扩展，在执行前拒绝没有 `name`、没有 `async:true` 的这一组合，返回真实错误，不启动命令、不终止 Agent。有限交互命令使用正数 `timeout`；已启用服务能力时，常驻服务使用 `name` 和有界 `ready.timeout`，省略命令 `timeout`，通过 `read proc://<name>` 查看、`write proc://<name>` 输入；已启用异步能力时非交互后台任务可显式使用 `async:true`。能力由官方实际全局／项目设置决定；遗留 `omp-compat.yml` 已不加载，显式 false 应保留官方错误和实际 schema，不能假称已后台启动.

不修改官方全局配置、普通非 PTY 命令或用户主动的 Bash RPC；已有运行实例不会热加载限制，不为应用修复强制中止正在工作的会话。

## 通知与 RPC 协议错误反馈

通知点击后打开所属会话右侧「扩展」面板中的命令反馈区；反馈记录分别保存来源和完整原文，`info`、`warning`、`error` 不使用「已完成」或成功标记。原生 `rpc_frame_error`／`rpc_stream_error` 保留 `error`、可用的 `originalType` 和额外文本上下文；没有扩展来源的运行时错误显示为 `OMP runtime`，本地 RPC 解码／分片失败显示为 `OMP RPC`。

本地分片初始元数据拒绝、JSON／UTF-8 解码失败和字节上限错误不再只等待进程退出才可见。每个运行时仍最多每分钟送达 20 条本地协议错误，第 20 条保留原始错误并附上后续抑制说明；反馈区每会话最多保存最近 100 条，不截断保留下来的正文。错误反馈不绕过分片／字节硬上限或背压，不自动重放写命令。通知历史按服务器隔离，切服不会把旧服务器通知点击到当前服务器同名会话。

## 隐私与负载

记录器使用固定字段白名单，不记录聊天正文、命令参数、工具输出、完整 URL、
认证头、令牌或错误堆栈。字符串限制长度，并对常见令牌格式脱敏。
浏览器诊断必须通过现有 WebSocket 认证，只接受订阅会话，每连接每分钟最多
120 条。浏览器事件是客户端自报，不作为业务状态的权威来源。

不记录 token 增量、工具输出增量或每次心跳；运行状态变化去重。
日志写入失败不阻塞 Agent，并仅打印一次写盘失败提示。
WebSocket 诊断协议不能读取服务器日志；CLI 可导出时间线，故障报告接口仅对已鉴权客户端开放。

## 自动故障报告

- runtime 崩溃、任务运行期间服务端启动批次变化会触发故障提示；持续连接失败或反复断连超过 45 秒才提示。正常切换服务器、后台页面和系统离线不计入这一宽限期。
- “×”和“稍后处理”仅收起当前报告，保留右下角“故障报告”入口；“不再提示本次报错”同时隐藏弹窗和入口，并在当前浏览器/客户端保存选择，刷新或出现新故障后也不再提示。此选择不删除诊断记录、不停止故障收集，也不授权上传；清除站点数据会重置该选择。
- 平时的状态探测只读内存中的启动批次和最近故障，不扫描日志、不启动 Agent。检测故障后，客户端从 `GET /api/v1/host/diagnostics/report` 收集报告；此接口沿用现有 token 和 Origin 校验。
- 报告包含全部仍保留的诊断元数据,以及服务端/worker 日志中的固定生命周期标签(如 `[ompiui-server] graceful shutdown`、`[omp-worker] command timed out`)。这些标签之后的错误信息、堆栈、会话 ID、路径、UNC/私有地址、任意控制台正文、会话 JSONL、工具输出、令牌、Cookie、私有 URL 和用户名均不导出。
- 客户端保留最近 300 条连接/状态元数据，报告注明更早记录的淘汰数量；服务端记录仍按原有 7 天 / 20 个文件的保留策略收集。
- 收集上限为 64 MiB；文件不可读、超出收集上限或诊断记录缺失时，报告明确标记不完整，不静默声称已收集全部日志。
- 后端完全不可达时先保留客户端记录。恢复连接后补齐服务端日志；已经上传的内容不修改，用户可重新收集并生成新链接，旧链接保留。
- 用户确认后才通过独立、无 OMPiUI 鉴权头的请求上传至 mclo.gs。每份最多 9 MiB / 24000 行，超限按 UTF-8 无损拆分；多份报告最终生成一个包含所有分片链接的索引。
- 上传失败保留本地报告和已成功分片，重试继续上传。报告摘要及链接保存在 localStorage，完整内容保存在 IndexedDB；支持浏览器下载和 Tauri 原生保存。删除浏览器站点数据会同时清除这些记录。

## 方案参考

通过 GitHub CLI 调研 Pino 官方的结构化记录/脱敏文档，以及 OWASP Logging
Cheat Sheet 的关联标识、敏感信息排除及容量约束建议。实现沿用项目本地文件
日志架构，未引入远程采集或新的运行依赖。
