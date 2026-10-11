# 会话运行诊断日志

用于排查刷新后停止、重连状态丢失、运行实例回收、命令取消及服务端重启。
默认启用，独立于原有服务端文本日志，不需要额外服务或依赖。

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
- `session.reaper.kept`：状态查询失败或仍忙，保留运行实例。
- `server.stopping / worker.dispose / session.host.disposed`：
  服务端关闭造成的实例销毁。
- `server.started` 的 `runId/pid` 变化：服务端已重启。
- `worker.heartbeat.kill / worker.exited`：看门狗或 worker 异常退出。
- `session.crashed` 的 `workerPid/code/signal/reason`：内层 OMP 进程的退出信息；
  `terminal_running` 表示发现独立终端，`terminal_probe_failed` 表示进程探测失败，
  `unexpected_exit` 表示未主动停止。不要将内层 OMP 退出与共享 worker 退出混淆。
- `agent.event.eventType=message_end` 的 `status=error/aborted`：
  模型回复失败或中止；失败使用 `MODEL_RESPONSE_ERROR`，原始错误正文不进入诊断日志。
- `command.status.status=unknown_after_crash`：命令结果因崩溃无法确认。

异常强杀或 watch 重启可能没有完整的停止事件。此时只能结合新启动批次与旧
记录推断重启，不能把没有结束日志当作“已正常完成”。
浏览器 pagehide 是尽力发送，网络已经断开时无法补发；重连会上报前次关闭码。
桌面 Bun 和 Node 的 worker 错误均写入数据根目录的日志。重连和故障状态探测
会重新校准当前运行状态；后端确认空闲且子代理已不在注册表时，遗留条目标记中断。

OMPiUI 管理的会话使用进程级 `task.maxRecursionDepth: 1`：主代理可以并发派任务，
子代理不能继续派子代理；不修改官方终端的全局配置，也不降低第一层并发上限。

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
- 平时的状态探测只读内存中的启动批次和最近故障，不扫描日志、不启动 Agent。检测故障后，客户端从 `GET /api/v1/host/diagnostics/report` 收集报告；此接口沿用现有 token 和 Origin 校验。
- 报告包含全部仍保留的诊断元数据和可安全分享的服务端/worker 生命周期摘要。任意控制台正文、会话 JSONL、工具输出、令牌、Cookie、私有 URL 和用户名不导出。
- 客户端保留最近 300 条连接/状态元数据，报告注明更早记录的淘汰数量；服务端记录仍按原有 7 天 / 20 个文件的保留策略收集。
- 收集上限为 64 MiB；文件不可读、超出收集上限或诊断记录缺失时，报告明确标记不完整，不静默声称已收集全部日志。
- 后端完全不可达时先保留客户端记录。恢复连接后补齐服务端日志；已经上传的内容不修改，用户可重新收集并生成新链接，旧链接保留。
- 用户确认后才通过独立、无 OMPiUI 鉴权头的请求上传至 mclo.gs。每份最多 9 MiB / 24000 行，超限按 UTF-8 无损拆分；多份报告最终生成一个包含所有分片链接的索引。
- 上传失败保留本地报告和已成功分片，重试继续上传。报告摘要及链接保存在 localStorage，完整内容保存在 IndexedDB；支持浏览器下载和 Tauri 原生保存。删除浏览器站点数据会同时清除这些记录。

## 方案参考

通过 GitHub CLI 调研 Pino 官方的结构化记录/脱敏文档，以及 OWASP Logging
Cheat Sheet 的关联标识、敏感信息排除及容量约束建议。实现沿用项目本地文件
日志架构，未引入远程采集或新的运行依赖。
