# 会话树、Fork 与替换隔离验收

## 2026-10-30 结案范围

维护者确认 #361 按原「旧身份不污染目标会话」范围 completed 关闭；#382 同次模型工具网页 PTY 也已完成并关闭，验收见 [工具 PTY](tool-interaction.md)。未知来源的官方 `extension_error` 保留于无 sessionId 的宿主诊断，不猜测或虚构源会话；精确回源仍未提供，但不再作为 #361 的额外结案前提。

2026-10-30 本轮使用隔离官方 **OMP 18.12.6 / Bun 1.3.14** 重跑默认专项：`run-Ji0YPs/evidence.json`，exit 0、`HISTORY_AND_HOST_ISOLATION_PASS`。实际迟到旧回调 `sessionErrorCount=0`、`diagnosticCount=1`、`hasSourceIdentity=false`；只读历史／导航取消／图片 Fork／Goal 恢复断言全部通过。显式 `--require-source-attribution` 另跑 `run-yOsFWZ/evidence.json`，按预期 exit 2：宿主隔离通过，额外来源能力仍未提供，不把它记作目标污染或精确回源通过。新增 stream 反馈消费者回归所在 `eventStream.test.ts` 共 36 项通过，单测不冒充 GUI。

下文原生／网页记录属于 2026-10-29 历史证据，不因结案改写成今天重新执行或全部 GUI 矩阵通过。旧默认 exit 2 的记录保留；现在默认脚本按历史和宿主隔离断言结算，来源归属改为显式附加检查。

## 结论

- **#356 本轮缺失的专项证据已补齐**：真实双窗格消息 Fork 的身份／文字／图片同步、另一子分支切换、Undo 后新发同身份分支，均实跑通过。没有重写已有原生接口，也没有确认新的生产故障。
- **#361 本地宿主错误隔离已补齐**：不再将无来源的官方 `extension_error` 打上接收时刻 sessionId／epoch 放入会话流；独立宿主诊断通道保留错误原文、runtime 标识和事件类型，生产网页扩展面板可查看及独立清空。真实旧定时回调在 new 后的原始帧仍没有来源身份，因此不能精确路由回源会话。2026-10-29 曾将这一额外能力列为结案阻塞；2026-10-30 维护者确认按原隔离范围结案，不将精确回源记为已实现。对官方 18.13.3 的核对仅是源码，不是运行验收。
- 下文所有历史原生运行仅使用新建的隔离 HOME、配置、工作区及本机确定性 HTTP provider，没有真实厂商账号、付费请求、用户工作会话或终端接管；2026-10-29 该专项没有推送、发布或关闭 issue。2026-10-30 已按维护者确认关闭 #361/#382，仍没有推送或发布代码。

## 可重复原生验收

先准备受支持的官方 OMP／Bun runtime 并构建工作区，入口由现有 `OMPI_OMP_BIN`／`OMPI_BUN_BIN`／`OMPI_OMP_RUNTIME_DIR` 解析。隔离 HOME 下的编译版 CLI 如需 native addon，显式设置 `PI_NATIVES_DIR` 到官方 addon 缓存根。不要让验收使用用户会话目录。

```bash
node --import tsx scripts/verify-session-transitions.mjs --history-only
```

```bash
node --import tsx scripts/verify-session-transitions.mjs
```

脚本在 `.slim/transition-acceptance/run-*` 创建独立目录并保留 `evidence.json`、原生日志和本地 provider 请求：

- exit **0**：默认及兼容的 `--local-isolation` 验证历史／取消／Goal 恢复，以及真实迟到帧进入宿主诊断、不进入任何会话 `pi.event` 流；不声称精确回源。`--history-only` 仅证明历史子集，不运行迟到错误隔离。
- exit **1**：断言／运行失败。
- exit **2**：仅 `--require-source-attribution` 的附加精确归属检查未满足。未来上游加入字段也必须单独验证路由，不能仅因字段存在就退出 0；这不是再次检测到目标会话污染。

兼容的本地隔离入口：

```bash
node --import tsx scripts/verify-session-transitions.mjs --local-isolation
```

需要明确检查额外来源能力时使用：

```bash
node --import tsx scripts/verify-session-transitions.mjs --require-source-attribution
```

历史结果（当时默认脚本仍要求精确来源）：2026-10-29 官方 **OMP 18.12.6 / Bun 1.3.14** 完整运行：`run-vAcx9z/evidence.json`，exit 2；最终复跑 `run-053aee/evidence.json` 同样 exit 2、原始错误仍无来源；独立历史运行：`run-MFaTMk/evidence.json`，exit 0。

通过的原生检查：

1. state／tree／branch／entries 读取保持源文件字节及 mtime。
2. 无效节点失败、扩展取消导航不改源身份／历史；用户节点 Undo 返回其 parent 上下文和原生保存的文本／图片。比较的是官方归一化后的图片，不将输入 PNG 与官方保存的 WebP 字节直接比较。
3. Undo 后新消息与原用户节点共用 parent，仍是同 sessionId／JSONL；本地 provider 实际上下文不含被撤销回合。
4. 在两个子分支末端及助手节点导航，源分支仍存在，身份／文件不变。
5. before Fork 返回原消息草稿且不纳入该消息；at Fork 纳入选中消息。两者均为新 id／file，源文件字节及 mtime 不变；取消 Fork 不迁移身份。
6. 取消 new 保留旧暂停 Goal；成功 new 不显示旧 Goal／子代理投影；切回源文件恢复其原生 Goal，不发送 drop／clear。

## 真实生产网页验收

[`preview-session-transitions.mjs`](../scripts/preview-session-transitions.mjs) 创建三回合原生测试会话（第二回合含图片），关闭准备阶段 writer，再启动实际生产网页及真实 server／worker。`.claude/launch.json` 的 `isolated-session-transitions` 使用此入口；端口 8796，token 为明确的本地测试值。它不是 mock Agent 或内部组件样例页。

本次网页数据：`run-ja4AZK/gui-session.json`；源 `01a186ea-272f-7000-88c8-778310976e7a`，Fork 目标 `01a186ee-e623-7000-8b77-d6f70ffe3b97`。原生日志在该目录 `agent/sessions/-workspace/`；`gui-journal-evidence.json` 记录前两次目标发送的原生 header／parent／图片数，随后直接核对了 Undo 分支追加。

实际操作及观察：

- 界面分屏并在两窗格打开源会话，从左窗格 Fork 第二条图片消息。两窗格和 URL 跟随同一个真实 target；两个输入框都恢复 `GUI image question` 和 `image.webp`。IndexedDB 仅有 target 的同一图片草稿记录，源草稿未挂上 target 图片。
- 右窗格发送恢复图片：target JSONL 新用户条目 `528f1dd4` 含 1 张图片，源保持原三回合。左窗格再发 `GUI left pane continues fork`：target 新条目 `617248e9`，两边均收到真实助手回复、文字和附件草稿同步清空。
- 左窗格 Undo 到图片消息，两个输入框恢复图片草稿，Redo 计划为两回合；右窗格一次 Redo 仅恢复图片回合，左窗格再 Redo 恢复原末端。
- 再 Undo 后发送 `GUI alternative after Undo`，新条目 `8ac2527c` 的 parent 为 `3188b159`，与原图片用户条目相同；target id／file 不变，旧分支仍保留，两个窗格均只显示新分支且 Redo 不再冒用旧分支。
- 原生树面板选择旧末端 `6ea69510` 并“回到这里”，两窗格回到原分支；选择新末端 `0f7c4fd3` 再导航，两窗格回到新分支，始终同 id／file。
- Undo 新分支后刷新网页，URL 身份、文字／图片草稿及持久化 Redo 保留；点击 Redo 恢复正确新分支，未新增会话。刷新不会持久化分屏布局，本次不把布局恢复作为身份／草稿验收。
- 实际截图已查看；最终浏览器错误日志为空。启动未带 token 的早期 401 不计作业务失败，带测试 token 后真实交互通过。

## 精确来源归属的历史缺口（不再阻塞 #361 原隔离范围）

源 `01a186ec-fa53-7090-9a0a-7e9f9e0d1522` 通过受支持扩展命令注册 `ctx.setTimeout`，回调等待测试释放；成功 new 到 `01a186ed-0cb8-76c9-bfa5-2c391158a56a` 后释放旧回调。**在 OMPiUI 添加消费 epoch 之前**捕获的官方原始帧：

```json
{
  "type": "extension_error",
  "extensionPath": "<timer>",
  "event": "timeout_callback",
  "error": "isolated extension callback error"
}
```

缺少 source session／prompt／generation；给接收时的当前身份打 epoch 无法恢复丢失的原始归属。不能全忽略此类错误、从错误文本推测来源、启用旧回调模拟成功或替换官方内部 runner。精确回源需要上游在回调开始／注册时捕获来源并通过 RPC 保留可关联身份；本地已通过独立宿主通道满足 #361 的不污染要求，但没有恢复这些缺失身份。

官方源码核对：[18.13.3 rpc-mode.ts](https://github.com/can1357/oh-my-pi/blob/v18.13.3/packages/coding-agent/src/modes/rpc/rpc-mode.ts) 的 `initializeExtensions.reportRuntimeError` 仍只输出上述三项错误字段。

## 2026-10-29 本地诊断隔离补验

- 实现没有虚构会话桶／通知跳转目标，也没有按同名在飞命令推断来源；所有原始 `extension_error` 统一进入无 sessionId 的 `omp.extension_error` 宿主通道。既有 `native-rpc-prompt` 的命令失败处理保持不变，原生命令真实抛错仍拒绝提交并保留草稿。
- 独立诊断最多保留最近 100 条完整错误；切换后端清空，不随会话替换清空。清空诊断不清空会话反馈。服务器磁盘诊断只记录元数据，不记录路径／错误正文；完整原文仅在现有鉴权事件流和浏览器内存展示。
- **官方 OMP 18.12.6 / Bun 1.3.14**：`run-1hco1Y/evidence.json`，`--local-isolation` exit 0；`run-nfZjoL/evidence.json`，默认完整专项 exit 2。两者均 `sessionErrorCount=0`、`diagnosticCount=1`、`hasSourceIdentity=false`。不是把验收标准改成忽略错误。
- **生产网页**：`run-ZH1EaD/gui-diagnostic-evidence.json`。源 `01a187d4-80e1-74ca-a7c6-54644338069a` 注册迟到回调；图片消息 Fork 到 `01a187d8-736f-7146-a176-535c9e3b3817` 后释放。诊断区显示原文 `isolated extension callback error`、`<timer>`、`event: timeout_callback` 和宿主 runtimeId；聊天内容无该错误。恢复的文字／图片在 target 成功发送，target 最后用户条目含 1 张图片；清空诊断后回复／历史不变，控制台无错误。
- 源文件原字节完整保留，但显式 GUI 命令／Fork 的官方生命周期追加了一条 `custom: session_exit`；本轮没有把它描述成全文件字节／mtime 不变。只读浏览与双向继续由独立 `verify-session-safety.mjs` 再次通过。
- **未执行的证明**：本轮没有重跑生产双窗格全矩阵（前一轮 #356 记录仍保留）；Browser pane 未显示，截图工具返回 `page is not compositing frames`，因此未取得截图／非零布局测量。实际生产 DOM、诊断原文、图片发送、清空交互和控制台通过，不将截图或视觉布局记为通过。
- 前端完整套件 **212 文件 / 1683 项通过**；worker **290 通过 / 13 既有跳过 / 0 失败**；server 路由与真实 IPC **35 项通过**。类型检查与生产构建通过；lint **0 错误 / 36 既有警告**。不宣称本轮执行了完整 server 套件。

## 回归与安全边界（此前专项）

- 95 项前端回归通过，包括新增双 composer Fork 图片／目标发送回归、真实 router 全窗格 remap、draft、Redo 和事件消费者回归。
- 59 项 worker／server 专项通过，包括原生回执、取消／失败保留、目标投影及迟到代次失效。
- 全工作区 typecheck、worker／生产网页 build 通过；lint 0 error、36 条既有 warning。
- 既有 `verify-session-safety.mjs` 在专属 spool／目录环境运行通过：官方↔GUI 双向发现、同文件继续、只读字节／mtime、最新备份、旧目录迁移及无 auto-resume 接管。
- Windows 当前主机曾拒绝 Bun 在 OS TEMP 中创建 SQLite／RPC spool；验收 fixture 为每次运行设置独立 TEMP／TMP／TMPDIR，未放宽任何生产权限或修改用户环境配置。
