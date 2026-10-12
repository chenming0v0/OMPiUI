# 子代理实时预览传输

## 数据路径

`omp --mode rpc` → `OmpRpcSession` → `SubagentEventBuffer` →
`SubagentMessageStream` → worker IPC → `omp.subagent` 会话事件流 →
`ompSubagentStore` → `TaskRenderer` / `SubagentSessionPreview`。

OMP 的子代理 `message_update` 仍然携带完整累计消息。worker 先按运行身份合并
50ms 内的累计更新，再计算已发送正文之后的增量。不能直接在合并器里合并增量：
覆盖前面的增量会丢字。消息边界和工具状态到达时先排空该运行的更新。

## 预览事件

`omp.subagent` 的 `kind: "event"` 帧带 worker 生成的 `eventId`，用于重放去重。
消息转换为 `payload.event.type: "message_patch"`：

- `messageId`：消息边界生成的预览身份，不依赖模型提供商的回复 ID。
- `role`：`assistant`、`user` 或 `agent`（IRC 通信）。
- `phase`：`message_start`、`message_update` 或 `message_end`。
- `textOffset` / `textDelta`：UTF-16 字符偏移及增量正文，每块最多 4096 个字符。
- `textTailOffset` / `textTail`：最多 2048 个字符的恢复尾部。
- `thinking`：最近 2048 个字符的思考活动摘要。
- `tools`：工具调用的身份、名称与标题，不包含参数、结果或图片。

这些字段是预览协议，不是原生会话格式。原生会话历史、主时间线最终工具结果
及完整回复不改变；工具参数与结果仍可在子会话中查看。
主对话更新只去掉 SDK 重复携带的 `assistantMessageEvent` 副本，保留完整 `message`。

IRC 事件单独分块，不改变正在生成的助手消息身份或正文偏移。主会话收到 IRC
事件后同步原生条目并刷新时间线，不再等下一轮工具结束。

## UI 恢复与渲染

收到不连续偏移时先显示恢复尾部，保持实时活动可见。
任务终态后，残缺预览用只读原生历史补齐；迟到的历史响应不能覆盖运行中的转录。
旧 worker 的累计快照仍可读取。前后端需要一起更新才能启用增量预览。

已收到的工具进度不能被历史加载骨架遮挡。进度更新保留转录数组引用，
未消费的事件不触发转录重渲染。超长文本默认只挂载 8000 字符预览，
用户展开后显示完整正文；流式预览显示最新尾部。

## 验证

```bash
npm run build -w @ompiui/omp-worker
node --import tsx scripts/verify-subagent-runtime.mjs
```

探针在隔离临时目录运行真实 OMP，通过本地假模型并发启动十个子代理，
逐块生成长正文，再调用 `yield`。验证每个子代理结束前已有实时输出、
UI 解码器完整还原正文、工具终态正确、最大预览帧低于 50KB。
不会访问真实模型或更改用户会话、全局配置。

参考官方资料：

- MDN WebSocket：普通 WebSocket 没有接收背压，应控制输入量与消费成本。
  https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- React `useSyncExternalStore`：快照按实际变化更新，并保持稳定不可变引用。
  https://react.dev/reference/react/useSyncExternalStore
- OMP RPC：子代理事件仍保留完整消息快照；IRC 可能插入正在生成的回复。
  https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
