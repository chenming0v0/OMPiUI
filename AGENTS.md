# AGENTS.md

## 分支

- 默认在 `dev` 工作。`dev` 是集成分支：功能 PR 进这里，维护者也可以直接推送。
- `main` 是发布分支：只接受本仓库 `dev` 合并进来的 PR。不直接推送，不把功能 PR 开到 `main`。
- 开 PR 时 base 只能是 `dev`。唯一例外是用户明确要求把 `dev` 合并进 `main`。

## 不在 dev 时

当前分支不是 `dev`，且用户没有明确要求留在该分支：先说明当前分支并告知要切到 `dev`，执行 `git checkout dev`，然后继续工作。

## 版本

- 从 `0.1.0` 起。根包、`app` / `server` / `omp-worker` / `protocol`、Tauri 用同一个号。
- 发版记录写根目录 `CHANGELOG.md`。`packages/app/CHANGELOG.md` 是上游 PiUI 历史，不参与发版。
- 升版本：`npm run release:prepare -- <version>`，或 `npm run release:bump -- <version>`。提交留在 `dev`，合并进 `main` 之后再打 tag：

```bash
git fetch origin main
git tag v<version> origin/main
git push origin v<version>
```

- `v*` tag 触发 Desktop And Mobile Release。Android 签名 secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`。
- 应用内更新检查读本仓库 `releases/latest`，不是 PiUI。

## 工具调用渲染

- 新增工具、改工具行布局/连线、把非 toolCall 条目显示成工具行之前，先读 `.claude/skills/ompiui-tool-rendering/SKILL.md`。工具行外壳只有 `ToolGroup` / `ToolPartView` 一套；要连线就并进同一组，不要自绘卡片或加补线开关。

## 诊断日志

- 查找会话运行日志、排查刷新后停止、断连重连、状态恢复、命令中止、空闲回收或服务端/worker 重启问题时，优先使用本仓库诊断工具 `npm run diagnostics --`，不要只搜索服务端文本日志就下结论。
- 已知会话 ID 时，先查对应时间线；已知故障时间时，加 `--since`，使用带时区的 ISO 时间。查询会保留服务端和全局 worker 生命周期作为上下文。

```bash
npm run diagnostics -- --session <sessionId>
npm run diagnostics -- --session <sessionId> --since 2026-10-09T18:00:00+08:00
npm run diagnostics -- --level warn
npm run diagnostics -- --event connection --limit 500
npm run diagnostics -- --session <sessionId> --out diagnostic-report.jsonl
```

- `--json` 输出 JSONL，`--dir` 可查询其他机器复制来的诊断目录。完整字段、事件含义、保存位置与配置见 `docs/diagnostics.md`。
- 诊断记录不足时，再结合原始服务端日志和会话 JSONL。旧版本或关闭诊断记录时可能没有数据；缺少结束日志不代表任务正常完成，浏览器自报事件也不是后端状态的权威来源。
- 排查时区分浏览器断连、请求取消、Agent 收到 `abort`、runtime 被回收和进程重启，不要把这些原因混为“自动停止”。
- 不要为了查日志重启或中止正在工作的会话；分享记录优先使用诊断工具导出，避免直接传播含正文或令牌的原始日志。

## 网络与流量审计

- 禁止用极端或假想输入推算问题（最小帧、1 字节行、假想超大文件/超大会话）；量级必须符合生产实际，禁止拿「没有显式上限」当「已经出事」。
- 提这类 issue 前先检索 open + closed issue，并在正文说明已有的硬上限为什么没兜住这次；重复结论走评论，不新开单。

## OMP 会话互通

- OMPiUI 必须与官方终端版 `omp` 共享同一套原生会话目录和会话文件；官方终端创建的任务必须能在 OMPiUI 中打开并继续，OMPiUI 创建的任务也必须能被官方 `omp` 的任务列表和恢复命令发现。
- 不得把新会话仅写入 OMPiUI 私有目录后再把官方会话标记为只读。历史 OMPiUI 私有会话可以保留兼容读取，但不能破坏新旧会话的双向互通。
- 任何涉及会话目录、`--session-dir`、`session.open`、`session.preview`、只读判定或会话复制的改动，都必须验证官方终端与 OMPiUI 的双向可见和继续写入能力。
- 浏览、刷新和草稿同步必须只读，不得为这些操作启动 Agent runtime、自动保存或覆盖官方会话历史。用户主动发消息或执行明确的会话修改操作时才进入写入流程，恢复原会话前备份并读取最新历史。不得全局扫描官方终端进程、因终端运行而拦截操作或终止 runtime，也不得用禁止互通或静默复制为私有任务代替只读浏览。

## 对齐官方 TUI 的含义

- OMPiUI 的创作定位是 GUI：由 Web / 桌面 / 移动端界面承载交互，不是官方终端的启动器或套壳。任何功能都不得通过在我们的 UI 内直接打开官方终端来交付；本条不是只禁止某一种接管实现。
- 「对齐 TUI」= Web UI 自己做出官方 `omp` 交互界面的**功能和行为**：命令、交互流程、状态变化、结果显示都要一致，通过 RPC / rpc-ui 等官方协议驱动同一个 Agent runtime，在网页里完成。
- 「对齐 TUI」≠ 在 OMPiUI 里启动官方 `omp` 终端程序。禁止应用在 PTY / 内置终端里启动 `omp`、`omp --session`、`omp play`、`omp stream` 等；禁止添加任何启动、打开或接管官方终端的按钮、斜杠命令、下拉菜单、快捷键、链接或自动跳转，也禁止添加「原生 OMP」「打开官方终端」「启动终端使用此功能」等引导入口和文案。不得用会话接管、只读锁或静默复制替代 GUI 功能。0.6.40 加过的「原生 OMP」终端接管已经撤回，不要再加回来。
- 上游 RPC 没提供所需接口时，在 issue 里写清楚缺哪个接口，标为阻塞。不能拿「打开官方终端就能用」当退路、当完成，也不能写进验收清单。
- 写 issue、拆任务、写验收时同样适用：只证明「在官方终端里可用」不算对齐。
- 底部内置终端面板是用户自己的通用 shell，可以保留。用户自行输入命令运行 `omp` 属于用户自己的操作；应用不得为此预填、自动执行、添加专用入口或引导文案，也不能将用户手动运行官方终端算作 OMPiUI 实现了某个功能。
