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
