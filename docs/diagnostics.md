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
- `agent.event.eventType=message_end` 的 `status=error/aborted`：
  模型回复失败或中止；失败使用 `MODEL_RESPONSE_ERROR`，原始错误正文不进入诊断日志。
- `command.status.status=unknown_after_crash`：命令结果因崩溃无法确认。

异常强杀或 watch 重启可能没有完整的停止事件。此时只能结合新启动批次与旧
记录推断重启，不能把没有结束日志当作“已正常完成”。
浏览器 pagehide 是尽力发送，网络已经断开时无法补发；重连会上报前次关闭码。

## 隐私与负载

记录器使用固定字段白名单，不记录聊天正文、命令参数、工具输出、完整 URL、
认证头、令牌或错误堆栈。字符串限制长度，并对常见令牌格式脱敏。
浏览器诊断必须通过现有 WebSocket 认证，只接受订阅会话，每连接每分钟最多
120 条。浏览器事件是客户端自报，不作为业务状态的权威来源。

不记录 token 增量、工具输出增量或每次心跳；运行状态变化去重。
日志写入失败不阻塞 Agent，并仅打印一次写盘失败提示。
浏览器不能通过该协议读取服务器日志；诊断导出仅通过本机 CLI 完成。

## 方案参考

通过 GitHub CLI 调研 Pino 官方的结构化记录/脱敏文档，以及 OWASP Logging
Cheat Sheet 的关联标识、敏感信息排除及容量约束建议。实现沿用项目本地文件
日志架构，未引入远程采集或新的运行依赖。
