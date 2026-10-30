# RPC 分片故障与网页反馈验收

## 结论（2026-10-30）

#367 的本地 stream 故障产生点到真实网页反馈路径已完成验收。既有生产分类与消费者无需再重写：实际官方 stdout `rpc_chunk` 的长度损失／超时仍由生产 RpcClient 拒绝为 `rpc_stream_error`，完整帧 UTF-8 解码失败为 `rpc_frame_error`；原文、`originalType`、所属会话和反馈定位保留。

本轮新增的是隔离传输故障夹具及回归，不是官方 `rpc_stream_error` emitter。不存在的上游 emitter、独立会话级 `open_url` 接口不再作为原 #367 错误保留／本地错误送达要求之外的结案前提；已有 notice 严重度、通知归属和链接历史验收仍保留。

## 可重复入口

使用明确安装的同版本官方 binary/npm 与 Bun；默认读取 `.slim/issue-repair-native-runtime`，没有该资源时明确失败，不隐式下载。

```bash
node --import tsx scripts/verify-rpc-stream-errors.mjs --runtime-dir .slim/issue-repair-native-runtime
```

包含真实 30 秒丢片超时：

```bash
node --import tsx scripts/verify-rpc-stream-errors.mjs --runtime-dir .slim/issue-repair-native-runtime --drop
```

这两个入口不启动 app server。网页使用 `.claude/launch.json` 中 `isolated-rpc-stream-errors`，由 `preview_start` 启动实际 `packages/app/dist`、server、worker。默认端口 8799；被占用时自动分配，启动脚本读取 `PORT`，以 `RPC_STREAM_GUI` 打印的 URL 为准。不得停止或接管占用端口的其它服务。

1. 打开打印 URL（带隔离 token），在打印 cwd 新建测试会话。
2. 通过公开提交接口或 composer 发送 `/rpc-stream-large gui-normal`；先确认 `proxy-*.jsonl` 中真正的 `native-group` 和 `nativeChunkCount > 1`。
3. 使用 arm-only 入口，仅修改该测试夹具的 control，不启动服务：

```bash
node --import tsx scripts/preview-rpc-stream-errors.mjs --arm <fixture-root> --cwd <target-cwd> --mode stream
```

4. 发送 `/rpc-stream-large gui-stream`，观察通知、点击定位扩展面板、完整错误及 `originalType: rpc_chunk`。frame 模式另发 `/rpc-stream-large gui-frame`。
5. 发送 `/rpc-stream-marker gui-continued` 确认后续原生事件继续；在另一打印的 workspace-second 会话检查没有协议错误串线。

## 真实故障入口与边界

`rpc-stream-proxy.mjs` 是验收专用透明子进程代理，通过既有 `OMPI_OMP_BIN` 接入，内部启动原官方 executable。版本输出、stdin、stderr、退出及 stdout 背压保持；只有明确 arm 的目标 cwd 中、公开测试扩展的大消息组可消费 arm。不改官方 runner，不生成最终 `pi.event`，不向浏览器 store 写入错误。

公开扩展产生固定有界的 1.125 MiB 消息，先观察实际官方 encoder 输出；没有真实 chunk 就验收失败。正常组逐帧原始与转发 SHA-256 一致，并检查解码后内容哈希。损坏方式：

- **stream**：同组每个原始 chunk 的声明 `byteLength` 一致 +1，payload 不变；生产 decoder 完整重组后出现真实 length mismatch。
- **frame**：一个 payload 等长改成非法 UTF-8；重组长度正确，生产 decoder 返回 frame 解码失败。
- **drop**：丢最后一片，保留原 30 秒 deadline，实际等待超时；不缩短生产计时。

代理证据包含原 chunk 元数据、哈希、动作、逻辑原帧类型、测试消息 sessionId/tag、官方 binary 哈希与子进程退出。生产缓冲／字节上限与拒绝语义不放宽，不重放损失消息，不假报成功。

## 本轮原生结果

官方 **OMP 18.12.6 / Bun 1.3.14**：

- `run-rwM1VC/rpc-stream-acceptance.json`：normal／stream／frame 通过，75 个实际 native chunks；正常 payload 与 wire 哈希一致；每个故障组只出现一个正确类别错误，保留 `source: OMP RPC`、原文和 `originalType: rpc_chunk`。
- `run-2xpD2p/rpc-stream-acceptance.json`：含 drop 的专项通过，105 个实际 native chunks，丢片至少等待真实 30 秒。故障后原生 marker 继续、另一同时运行会话的大帧不消费目标 arm、错误／消息不串线。
- 两原生专项的 provider 请求为 **0**（公开扩展命令，不触发模型回合）。status 明确为 `NATIVE_PASS_GUI_NOT_RUN`，不把该脚本当网页证明。
- 共享 20 条/60s 防风暴窗口另做受控 `protocolError` listener 回归，frame/stream 共用计数，第 20 条保留抑制说明，窗口后恢复。此项单独标为 controlled listener，不冒充原生故障帧。

上述路径相对于 `.slim/transition-acceptance/`，完整原始摘要见各目录 `rpc-stream-wire-summary.json`。

## 本轮实际生产网页结果

本会话 `preview_start` 建立专用实例。8798／8799 被其它进程占用，自动端口 **59794**；没有停止其它进程。夹具 `run-b2zqz6/gui-rpc-stream-evidence.json`：

- 源会话 `01a18bda-a8d5-70d3-b2ba-6990382dd905` 正常消息实际 5 片；首次 stream `rpc-4` 的完整 length mismatch 出现在扩展面板。
- 支持的鉴权 WebSocket 子协议 `ompiui.events.v3` 实际捕获 frame `rpc-7` 与 stream `rpc-10`：会话流分别 sequence 25／30，保留原生 worker meta，均 `error` 严重度、`source: OMP RPC`、`originalType: rpc_chunk`。
- `rpc-10` 原文为 `rpc chunk rpc-10 length mismatch: got 1179943 expected 1179944`；通知点击后仍为该源会话，扩展 tab 被选中，完整原文可读，不是瞬时截断 toast。
- 第二会话 `01a18be1-7646-7737-a471-65535c5b6423` 的扩展面板无 chunk 错误，实际订阅也未收到其协议错误；源与目标反馈分开。
- 故障后公开 marker 显示 `RPC_STREAM_NATIVE gui-continued continued`，另一次本地确定性 provider 回合显示 `Native reply: GUI model continues after protocol faults`。只有这一网页后续消息测试触发本地模型协议，不是厂商推理验收。
- 浏览器 error 日志为空；实际截图已取得，显示 warning 与 RPC error 正确区分。大型夹具历史触发原生压缩 warning，未隐藏或伪称修好；后续回复确实成功。初始化未带 token 的 401 不计成功证据，带隔离 token 后完成交互。
- 服务端日志另外出现隔离临时 spool 路径的 workspace watcher `EPERM`；这不是 RPC 分片分类失败，未声称服务端全程无错误。网页反馈／正常后续回复与会话隔离均在该日志存在时通过，未修改监听器权限或抑制错误。

## 回归与安全

- `rpc-stream-errors-process.test.ts` + `rpc-chunks.test.ts` **14/14 通过**：实际受控 RPC 子进程（不是官方 native 证据）的 normal／stream／frame、stdout pause/resume 背压、单次错误、stdin 回执、后续 notice、stderr 与退出。
- 前端 `eventStream.test.ts` **36 项通过**，新增 stream 原文、上下文、会话归属和后续正常反馈回归。
- `npm run validate` 全流程通过：前端 **214 文件／1708 项**；worker **305 通过／13 跳过**；server **321 通过／1 跳过**；protocol 26、admin 19、relay 59、tui 16 均零失败；全工作区类型与生产构建通过。lint **0 error／42 warning**，没有把 warning 写成零。
- 所有故障仅作用于新建隔离 HOME／APPDATA／XDG／配置／工作区，清除用户密钥相关环境变量。不碰活跃用户会话，不调用付费模型，不创建官方终端入口或 GUI 私有权威日志。
- 隔离 `verify-session-safety.mjs` 本轮 exit 0：legacy migration、官方 ID 发现、旧路径继续、官方进程仍打开时只读 bytes/mtime 不变、同 JSONL 双向继续、写前备份和无自动恢复通过；临时 HOME／APPDATA／XDG／spool 与用户目录分离。
- 本轮业务生产路由未改；已发布历史记录不重写，新证据只追加到 Unreleased。新脚本／文档尚未提交、推送或发布。
