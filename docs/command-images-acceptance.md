# 斜杠菜单图片与草稿验收（#375）

## 完成范围

本单经维护者批准，仅验收 **菜单原文与图片传输、独立附件、失败草稿及等待期间新草稿保护**，不要求所有命令都支持看图。

- 原生命令／扩展若支持产出 prompt 和图片，菜单与手输同文字／图片走同一官方投递路径，不绕到纯文本 `invokeCommand`。
- consumed 纯文本命令保持官方行为；GUI 不得在提交前静默丢图，也不声明图片已被模型使用。
- **没有调用真实视觉模型读图或识别。本地确定性 HTTP provider 仅证明图片送达，不证明模型理解图片。**
- 普通 `@file` 的正文确实送到 provider；`message:fileMention` 专用渲染未支持，二者分别披露，不把显示限制写成文件没传过去。

## 本轮修复与永久回归

旧原生／GUI 验收已有记录，但当前 dev 后续失败恢复又通过 Undo/Fork editor 桥广播旧提交快照，覆盖等待期间新文字／图片。新增真实 `PiChatPane` + `InputBox` 组合回归先复现，再移除重复恢复；持久化共享 composer 草稿继续归用户所有。

重试按钮保留原投递文字／图片／delivery。成功使用原 composer 快照清理，包含未放入 RPC 的 command chip 对象，保留后来的编辑；未改变全局 Undo/Fork/queue 取回语义。独立审查补入“恢复草稿发送失败 → 重试成功 → 重挂载”的恢复 marker 清理回归，防止已接受草稿再次复活。

相关代码与测试：

- [`PiChatPane.tsx`](../packages/app/src/features/pi-chat/PiChatPane.tsx)
- [`PiChatPane.composer.integration.test.tsx`](../packages/app/src/features/pi-chat/PiChatPane.composer.integration.test.tsx)：真实输入框、菜单、toolbar、附件 UI；只替换数据／投递边界，不联网。
- [`InputBox.test.tsx`](../packages/app/src/features/chat/InputBox.test.tsx) 与 [`composerDraftStore.test.ts`](../packages/app/src/features/chat/input/composerDraftStore.test.ts)：持久化、迟到恢复、快照清理和首页迁移。

初始组合 **10 失败／2 通过**；移除旧恢复后剩 **3 个重试失败／9 通过**；补入 retry 快照清理。审查补测恢复 marker 时 **1 失败／17 通过**，先捕获 remount 复活再修复。最终 **18 项组合／8 文件 85 项聚焦回归通过**；原生接受 helper 5 项通过，app typecheck 与生产构建通过，受影响 lint 0 error／5 条既有 warning。不将失败尝试记为通过。

## 可重复隔离 GUI

先构建工作区并准备已安装的受支持官方 OMP/Bun runtime；脚本不下载依赖。`.claude/launch.json` 的 `isolated-command-images` 对应：

```bash
node --import tsx scripts/preview-command-images.mjs --runtime-dir .slim/issue-repair-native-runtime
```

服务器只在 `127.0.0.1:8797`，token 是固定的本地测试值 `isolated-command-images-check`。入口复用 `session-transition-fixture.mjs` 创建全新的 HOME／TEMP／agent／workspace／WebUI 数据目录和 loopback provider，dummy key、零费用。仅使用官方 RPC 进程，不开官方 TUI；不接管或停止用户会话。

每轮 `.slim/transition-acceptance/run-*` 保留 `gui-session.json`、`native-inputs.jsonl`、`provider-requests.json` 和原生 JSONL。测试命令：

- `/image-check <args>`：官方文件命令展开为 `Describe native pictures <args>`，保持图片。
- `/image-check WAIT_ACCEPT_375`：受支持 input 扩展等待 23 秒，实际原生接受晚于普通 20 秒网络期限。
- `/draft-reject`：扩展等待 23 秒后抛错，不调用模型；用于期间新增／删图、失败草稿验证。

GUI 应先进入测试会话并明确提交一条初始化消息以加载写入 runtime 的命令目录，再执行以下矩阵。只读会话预览不启动 writer，因此冷目录不冒称已加载命令。

## 2026-10-29 实际生产网页结果

隔离目录 `run-q5dL2T`；源 `01a18824-f29b-7125-a68e-3527683cfe4f`。运行是官方 OMP 18.12.6、本地协议 provider 和当前工作区生产构建，**不是已发布 v0.6.45 安装器新字节的验收**；本次修复尚未提交／推送／发布。

| 检查 | 实际结果 |
| --- | --- |
| 先粘贴两张图片再选菜单 | `first.png`、`second.png` 与 `image-check` chip 同时保留；删除 chip 图片不删，重选命令再删第二张图，文字与 chip 不删。 |
| 菜单／手输同文字＋图 | 两次原生 input 均为 `/image-check @note.txt PARITY_375`、1 张 `image/png`；provider 两次文字完全相同，独立 `image_url` 内容完全相同（官方归一化为 WebP）。 |
| 普通 @file 内容 | 两次 provider 都有 `<file path="note.txt">` 和 `1:NATIVE_FILE_REFERENCE_375`；GUI 同时显示未支持 `message:fileMention`，并非未传文件。 |
| 原生拒绝期间编辑 | 点击 `/draft-reject` 后 1 秒改为 `LATEST_FAILURE_TEXT_375`、贴 `latest-failure.png`、删旧图；原生 409 `SUBMISSION_NOT_ADMITTED` 后只保留最新文字／图，不复活旧图片。历史 500 记录仍是此前验收，不写成本次重跑。 |
| 延迟成功期间编辑 | 23 秒 input 等待时改为 `NEW_TEXT_DURING_ACCEPT_375` 并贴新图；原生成功后只清已接受的旧图，最新文字及 `new-accepted-draft.png` 留在草稿。刷新仍保留。 |
| 重试成功清理 | 浏览器调试拦截一次投递 fetch，在网络调用前拒绝（不是模拟原生拒绝／断连）；真实点击重试后走未拦截官方 RPC，产生含图片的新用户消息，原文字／图片草稿清空。 |
| 原生恢复草稿重试 | 最终构建从真实图片消息 Undo，恢复文字与 WebP；网络前拒绝一次后真实重试成功，文字／图片清空，刷新不复活已接受草稿。 |
| 官方 consumed 命令 | `/changelog last 1` 原生 input 仍带 1 张 PNG；provider 请求数不增加，成功清草稿。不把此结果称为图片进入模型。 |

证据边界：Browser pane 未显示，工具返回 `page is not compositing frames`，**未取得本轮截图或有效布局测量**。为测试后台页面的交互，浏览器调试中仅对该隔离页模拟 visible 状态、以 timer 驱动 rAF；未修改产品代码、DOM 视觉或用户环境。真实 DOM／网络／原生 payload 检查通过，截图和视觉布局不能记为通过。无 CSS／布局改动；旧截图属于历史记录，不充作本次新截图。

## 回归命令

```bash
npm run test:run -w @ompiui/app -- PiChatPane.composer.integration.test.tsx PiChatPane.sendFailure.test.tsx InputBox.test.tsx InputBoxAttachments.test.tsx composerDraftStore.test.ts attachmentToImage.test.ts SlashCommandMenu.test.tsx sessionEditorDraftStore.test.ts
```

```bash
node --import tsx --test packages/omp-worker/src/omp/native-rpc-prompt.test.ts
```

上述测试不证明真实模型视觉能力，付费模型验证始终未执行。`pendingSend.ts`、`pendingSend.test.ts`、`.ignore` 保持不变。
