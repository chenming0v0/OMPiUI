# 子代理客户端兼容验收：#373 / #374

日期：2026-10-30。范围：仅 OMPiUI 兼容层，不修改 OMP、node_modules 或 native executor，不另建子代理引擎，不强制或重试合并。维护者确认按客户端兼容交付范围结案后，[#373](https://github.com/chenming0v0/OMPiUI/issues/373)、[#374](https://github.com/chenming0v0/OMPiUI/issues/374) 已关闭（completed）。兼容修复纳入 0.6.47 发布准备；GitHub 结案与发布状态分别记录，发布完成前不视为已发版。

## 交付语义

### #373：不让旧终态结束新执行

- native `started` 是本地任务观察代次边界，同 id/parent/file 在旧运行仍 running 时新 started 也换代。`startToken`/worker runId 防止双流重投递再次换代。
- 公开 `AgentRegistry` 的准确 ref/session 与 `AgentSession.subscribeRunState()` 提供当前会话活动，不等于任务完成。idle 可能有 pending async/续跑，不能生成虚构 completed。
- 观察使用独立 epoch/attachment/version；全局单调 `observationSequence` 跨扩展重载和 attachment 更换保留，拒绝此前未见过但来源更旧的观察。不同 worker 进程不比较旧计数。
- 复用后无身份 terminal/terminal progress 保留有界未归属证据，不贴当前 runId、不设置 endedAt、不清空新转录/工具状态。准确当前 session 正在执行时优先显示 running。
- 空闲而本次完成未确认显示“执行未确认”；能力缺失或运行时断开不能变成成功。共享 JSONL 是会话历史，不用 EOF、字节位置、正文或时间重建权威 monitor 边界。
- ToolGroup 描述型步骤、ToolPartView、TaskRenderer 使用同一实时/异步 outcome；不会子项未确认、摘要仍显示“子代理运行中”。

### #374：执行与合并不同事实

| 可靠结构化证据 | 执行 | 整体合并 | root 阶段 |
| --- | --- | --- | --- |
| exitCode 0，合并字段缺失 | 完成 | 未确认 | 未报告 |
| exitCode 0 + mergeError / changesApplied false | 完成 | 失败 | 按已有字段 |
| changesApplied true | 按执行证据 | 未确认（不证明 nested） | 已确认成功/no-op |
| changesApplied null | 按执行证据 | 未确认（不证明全部跳过） | 明确跳过 |
| abort / 非零退出 | 中断 / 失败 | 按独立字段 | 按独立字段 |
| interruption unknown，无结果 | 未确认 | 未确认 | 未报告 |

不解析 XML/summary/关键词为合并事实；真实输出含“Branch merge failed”而 typed 字段缺失时，正文照常可检查，状态仍是未确认。原 stdout/stderr、错误、details、outputPath 和恢复引用保留。单个 child 的失败不改变其他 child 的执行事实。

## 固定环境与真实 native 验收

- Windows 11，Node 24.14.1，官方 OMP 18.12.6 / Bun 1.3.14。
- 使用现有 `.slim/issue-repair-native-runtime`；native executable SHA256：`73d73c11dc8821cf939441a964992aefc9c5b0d5a4418e9e8985a46439b60eef`。
- 本地确定性 OpenAI-compatible fixture provider 驱动真实 task/write/bash/IRC/yield。不是收费模型实测；不是向 GUI 注入最终事件；历史 probe 仅只读核对哈希，不回放。
- HOME、配置、官方会话和 Git workspace 全部隔离于 `.slim/subagent-compat-acceptance/run-*`。

```bash
node --import tsx scripts/verify-subagent-compat.mjs
```

最终真实专项 exit 0，证据 `.slim/subagent-compat-acceptance/run-lFKpqs/verification.json`。另两次通过记录 `run-4uFX5o`、`run-IXgjMm`。

通过：
1. structured native task/yield，不取消 native 并行/执行方式。
2. IRC warm reuse 三次 started 复用同 child id/parent/file；旧无身份 completion 晚于新 started，新运行保持活跃，原 child journal 不另复制。
3. 公开观察 running/idle/pending async；旧通知未终结新运行，新回复继续送达。
4. 正常 native merge 一次产生真实 Git 冲突；child exit0 且公开/持久化结果没有 merge 字段，UI helper 为执行完成/整体未确认，不造 mergeError。
5. quiescent state/history 读取不改变原生日志哈希、不增加 provider 请求或 agent starts。
6. 历史证据和 native executable 哈希不变。

Native libgit 会回滚冲突 index，不能用 `git ls-files -u` 非空作为唯一验收。记录实际 parent/child divergent blobs、保留 recovery branch、native 诊断和只读 `git merge-tree` 冲突证明。该证明不用于产品状态判定；未重试、强制或二次应用 merge。

## 正规网页验收

入口 `.claude/launch.json`：`isolated-subagent-compat`，8800。仅通过 `preview_start` 启动本会话服务器，保留其他会话已有配置；正规 app/server/worker/public event 链路，setup 不创建会话或发 prompt。

真实 GUI 证据目录：`.slim/subagent-compat-acceptance/run-ghUZdy/`。

- 在 `merge` workspace 从输入框主动提交 `/subagent-compat-merge`，provider gate 暂停后，control-only release 只放行测试响应，不调用 merge。真实 Task 显示“执行完成 · 整体合并未确认”，槽 `data-status=unknown`，中性样式；展开 Result 看见 `REAL_MERGE_CHILD_EXIT_ZERO`、原始 native conflict summary 和保留分支说明。Screenshot 已在本会话 Browser pane 取得。
- 在 `ordering` workspace 主动执行 spawn / wake-one / wake-two，旧异步 gate 放行后，新 gate 仍保持，新 Task 槽为 running，显示“执行中”，不是 completed/failed。刷新后仍 running。
- 活跃刷新前后 `gui-refresh-before.json` / `gui-refresh-after.json`：4 个原生 JSONL 哈希一致，provider evidence 条数 23 不变，diagnostics runtime attach/prompt/send 计数 8 不变。证明这次真实浏览器刷新没有启动新 runtime/新增模型调用/写历史。
- 放行新 gate 后 `REAL_NEW_REPLY_AFTER_OLD_TERMINAL` 和后续原生 async 回复送达，槽 unknown，显示“执行未确认 · 整体合并未确认”，不旋转成永久运行，也不虚报成功。最后生产包刷新后描述型摘要显示“整体合并未确认”，不残留“子代理运行中”。
- 补充结案验收：离开 merge 会话后重新打开并强制刷新，持久化槽仍 `unknown`，显示“执行完成 · 整体合并未确认”，展开 Result 仍可读 `REAL_MERGE_CHILD_EXIT_ZERO`、native conflict summary 和恢复引用。`gui-merge-reopen-before.json` / `gui-merge-reopen-after.json` 的冲突父／子 2 个原生 JSONL 哈希一致，provider evidence 条数 26 与 runtime attach/prompt 计数 8 不变。初次全目录哈希断言因另一 ordering 父日志变化失败；没有判定该变化原因，不宣称这次全目录均未改变。冲突会话本身和无新增执行计数检查通过。
- 当前页面 console error 为 0；最初未附 fixture token 的 localhost 访问产生 401，改用入口 token 后连接正常，与兼容代码无关。

一次较早 GUI fixture `run-IQ6c0Q` 在操作 gate 前超过 90 秒，得到真实 abort，只算 abort 证据，**不算 merge 通过**。已将隔离 GUI task/provider gates 调整为 600 秒，另起全新 workspace 完成上面的验收，没有重试原冲突仓库。

GUI 仅中文、桌面布局实测；英文 strings、批量/异步/描述型摘要开关与显式 mergeError/changesApplied 字段由自动回归覆盖。未声称移动设备、Linux/macOS 或所有 native root/nested 场景实测。

## 自动验证

- 全 workspace `npm run build` 通过；最终 app 生产构建通过。
- app `src/omp` + message + chat：103 文件 / **947 项通过**（含 review 补充和摘要回归）。jsdom canvas 未实现提示为既有 warning，不是失败。
- worker 关键桥接/运行代次/缓冲：**85 项通过**；其中会话 53 项，公开 observer 的 source reload/root/inherited factory 及序列回归通过。
- app lint exit0，0 error / 41 warning（未清理与本任务无关的既有 warning）；`git diff --check` 通过。
- 发布准备补充 `npm run validate` 全流程 exit0：app 215 文件／1743 项，worker 324 通过／13 跳过，server 321 通过／1 跳过，其余工作区零失败；完整类型检查和构建通过，lint 0 error／41 warning。未执行的跳过项不算通过，不代表所有平台 native 验收。

## 剩余边界

不能准确将每条无身份晚到的 terminal 分给旧/新 monitor，也不能仅凭公开 session idle 确認 task 成功。不能凭空识别 native 未投影的 root/nested 合并失败；缺字段只能未确认。当前本地观察不是完整持久化 run boundary，runtime 重启后的旧历史仍是 legacy 会话历史。

这次交付是“错误终结隔离 + 真实活动观察 + 消除假成功”的兼容修复。#373/#374 已按维护者确认的该范围关闭，剩余完整原生契约属于另一个能力层次，不再阻止这两个客户端问题结案。完整原生契约提案见 [subagent-native-contract.md](subagent-native-contract.md)。
