# 模型工具同次调用的网页 PTY

OMPiUI 的受管官方 runtime 支持前台 `bash pty:true` 的网页交互。命令在同一次工具调用中启动一次，网页输入、控制键与 resize 连接该进程；真实退出后结果由官方工具调用返回，模型继续。

它不是底部通用 shell，不创建第二个 shell/tab，不重跑命令，也不打开官方 OMP TUI。PTY 在工具启动时分配，无法把已经以管道启动的旧命令事后升级为终端。

## 执行与支持边界

- 官方公开扩展在 `session_start` 捕获内建 Bash，晚注册同名执行器；通过原工具的 lazy metadata 保留动态 schema、描述、审批和并发策略。普通 Bash、`async:true` 和带 `name` 的服务调用仍委托官方执行。禁用工具不会被重新激活。
- 前台 `pty:true` 且非 async、没有 name 时，使用官方 `PtySession`。采用当前会话的 `shellPath`、cwd、环境、命令拦截、direnv、worktree、timeout 和公开输出 helper；不修改 `PI_NO_PTY`、不调用私有 TUI 工厂。
- 版本/扩展/认证通道不支持时明确显示能力不可用。已有用户扩展覆盖 Bash 时不抢占。旧运行实例不强停或热接管。
- `timeout:0` 关闭命令 deadline，不表示已完成或已后台化；仅在交互执行器就绪时放行。没有该执行器时保留原无界前台 PTY 启动前门禁。
- 原始屏幕流与模型文本结果分离。模型结果保留真实错误、退出码、超时、截断和输出引用。PTY 窄适配层不是“原生 Bash 私有执行器零差异 backend 插槽”。

## 操作与恢复

工具正文显示终端后，点击“取得控制权”才可以输入。控制权为单 writer、多 viewer；方向键、Enter、Esc、Tab、Ctrl-C 可直接操作。Ctrl-C 是程序输入，“取消此命令”才是定向取消；不会停止其它调用或会话。

折叠、关闭全屏或视图、断网只 detach，不杀进程。重连恢复同一执行的输出 cursor 和 writer epoch；输入按 sequence 在执行端去重，确认丢失不重复发送已经受理的 Enter。控制权过期或输入受理未知时暂停，不把未知当作安全重试。输入正文不存 localStorage。

运行状态和网络状态分离；安静输出不能证明程序正在等 stdin。原进程退出后保留有界尾部回放。历史默认显示正式工具结果，读取旧附件不会启动 Agent/PTY。runtime 崩溃或会话身份改变后，旧票据和输入不能迁移到新执行，也不会自动重跑命令。

## 安全与流量

控制路径为网页一次性票据 WebSocket → server 代理 → 有界 worker IPC → 官方扩展的私有 socket/pipe。官方 JSONL stdin 不接收按键，不伪造 RPC 消息类型。控制密钥只交给受管 runtime，工具子进程中的相关环境变量显式清空。

执行身份绑定 runtime、原生 sessionId、toolCallId 与随机 executionId；writer epoch 和执行侧 sequence 限制重复输入。Unix socket 为用户私有权限，Windows named pipe 限当前用户且拒远端。票据 60 秒、一次性、有限数量；输入、帧、排队、输出窗口和 WebSocket 发送都保留预算。慢 viewer 不阻塞工具/其它会话；回放过期明确 reset，不假称无限无损恢复。

## 验收

使用独立 HOME/APPDATA/XDG、配置、工作区及官方 OMP 18.12.6/Bun 1.3.14，不读用户凭据或活跃任务：

```bash
node scripts/verify-tool-pty-contract.mjs
```

```bash
node --import tsx scripts/verify-tool-interaction.mjs
```

网页验收用 `preview-tool-interaction.mjs` 配置启动独立 8798 端口，再执行 `verify-tool-interaction-web.mjs <isolated-root>`。官方模型循环从本地确定性 HTTP provider 收到真实 `tool_calls`，启动要求 TTY 的 nonce 程序，网页输入中文、Enter、方向键及 resize，原 toolResult 回到后续 provider 请求，再生成 assistant 续答。nonce/启动记录证明一次启动。

已实跑：真实 stdin/stdout TTY、普通调用结果保持、中文/Enter/方向键/resize、单进程、输入 ACK 恢复去重、输出/退出尾部、成功/exit 7/timeout/定向 cancel、显式 false schema、未激活工具保持和后来的用户 override。Browser pane 已在真实生产 app 验证原工具正文、刷新恢复、输入与模型续答；单测覆盖身份、writer/租约、Unicode/预算、断连和清理；完整类型/构建/回归另随发布核验。

这是官方 runtime + 本地确定性模型协议 + 真实 PTY + GUI 的端到端证据，不是厂商真实模型推理验收。Windows 使用隔离 PowerShell `shellPath`；Git Bash 在该主机 ConPTY 下的 MSYS 权限错误原样保留。Linux/macOS 真机运行和真实移动设备软键盘未在这台 Windows 工作站验收，不冒称通过。
