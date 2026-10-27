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

## 注册表 ID 与运行代次（OMP 18.12.6）

官方 lifecycle 用 `id`、`parentToolCallId`、`sessionFile` 标识子代理与所属 task；
progress 的 ID 在 `progress.id`。同一父 task 的 IRC 自主唤醒保留同一 ID 和文件，
但重新发送 `started`，且 `detached: true`。GUI 的 `runId` 是 worker 根据真实
`started` 边界分配的本地传输代次，不是 OMP 原生身份字段。

新代次清空终止时间、进度计数、转录、历史回填状态和卡片折叠选择。相同名称可存在于
不同父会话，store 按父会话加原生 ID 隔离；父 task 索引仅链接当前所属运行。
预览分块保留代次，暂停队列与迟到历史不能把旧代次更新写入当前卡片。
刷新从 `get_subagents` 读取当前官方注册表，在途读取不会覆盖之后收到的运行帧。

仍有无法从官方协议区分的边界：原生 `subagent_event` 只有 `id` 与 `event`，
没有 owner/file/代次；同 parent/file 的生命周期、进度也没有每次运行的 ID。
旧原生帧若在新 `started` 后才首次到达 worker，无法证明它属于旧运行。
本地代次只能隔离 worker 已观察到且已标记的旧帧，不能冒充原生旧帧证明。
同文件历史 API 返回全部会话消息，没有唤醒代次选择器。因此自主唤醒卡片只展示该
代次收到的实时转录/统计，不把旧文件全文回填成新结果；可打开子会话查看完整历史。
页面重连恢复当前状态与统计，但错过的同文件唤醒正文需要上游运行边界/历史选择器
才能安全归属。完整验收不得以本地合成 `runId` 测试替代这些原生边界。

官方依据：`src/modes/rpc/wire/frames.ts` 的三种子代理帧字段、
`src/modes/rpc/rpc-subagents.ts` 的活动注册表，以及 `src/task/executor.ts` 的
`attachIrcWakeTurnMonitor`。`src/task/output-manager.ts` 为同一父会话的新 task
分配唯一名称（重复名称得到 `-2` 等后缀），不同 parent task 的同名新启动不保证复用 ID。

隔离的 18.12.6 / Bun 1.3.14 实测：同 `ReuseChild`/parent/file 的六次运行依次为
completed、completed、failed、completed、aborted、completed；失败由隔离本地模型
400 响应触发，中止由原生 800ms 运行期限触发。每次真实 `started` 清空计数与转录。
两个独立原生父会话可同时持有 `ReuseChild`，状态与父 task 索引互不污染。
`state.get` 在自主唤醒仍运行时恢复对应代次、running 和零计数。
独立 Chrome 的 GUI 回放使用这些实测 worker 帧和原生父 task 结果：折叠旧卡片后新
运行自动展开，旧已标记帧/快照晚到不污染新卡片，completed 与 running 重连快照均
恢复当前代次。该 GUI 回放是实际帧渲染证明，不宣称是浏览器到原生运行的端到端测试。

## 验证

```bash
node --import tsx scripts/verify-subagent-runtime.mjs
```

探针直接导入当前 worker 源码，在隔离临时目录运行真实 OMP，通过本地确定性
提供商并发启动十个子代理（明确配置 depth=1），逐块生成长正文，再调用 `yield`。
验证每个子代理结束前已有实时输出、UI 解码器完整还原正文、工具终态正确、
最大预览帧低于 50KB；不以转发 mock 代替原生工具执行。

随后逐一运行全局／项目 depth=0、1、2、3、-1 的原生 RPC 与受管 rpc-ui 对比：
核对官方 `config get` 的有效值和每层实际提供商请求中的任务工具 schema，
真实执行全部允许的层级，校验实时正文、请求统计、原生父工具关联、磁盘转录，
并确认全局／项目配置及模型配置逐字节未变。负数场景由提供商主动结束在第四层，
不能据此声称证明无限执行。探针不访问真实模型、用户会话或用户全局配置。

Windows 隔离探针若使用独立 OMP 运行时，`PI_NATIVES_DIR` 应指向已安装的同版本
native binding。若临时目录不允许搬迁后的可执行文件写入，进程级 `TEMP`／`TMP`／
`TMPDIR` 可指向自己工作树内已存在的探针目录；不要为验收更改用户目录或配置。
这验证的是原生运行时与 UI 转录解码路径，最终浏览器任务树展示另行验收。

参考官方资料：

- MDN WebSocket：普通 WebSocket 没有接收背压，应控制输入量与消费成本。
  https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- React `useSyncExternalStore`：快照按实际变化更新，并保持稳定不可变引用。
  https://react.dev/reference/react/useSyncExternalStore
- OMP RPC：子代理事件仍保留完整消息快照；IRC 可能插入正在生成的回复。
  https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
