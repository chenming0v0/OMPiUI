# task 实时更新载荷调查（2026-10-11）

## 现场与证据

手机截图显示 16:01:31 单条 `tool_execution_update` 接收 144.2 KiB，并连续出现多个超过 100 KiB 的更新。

先使用 `npm run diagnostics --` 按带时区时间查询，再按实际手机订阅的会话隔离测试进程日志。诊断日志不记录工具正文，无法恢复截图那一条的原始载荷。随后通过现有鉴权、本机 WebSocket 对同一会话做只读订阅，不发送 Agent 命令、不重启服务。

以下为 **16:06:43.574–16:06:53.582（UTC+08:00）** 的现场采样，未请求历史重放：

| 消息类型 | 数量 | 总载荷 | 最大单条 |
| --- | ---: | ---: | ---: |
| `tool_execution_update` | 34 | 5,764,486 B（5.50 MiB） | 169,740 B（165.76 KiB） |
| `omp.subagent` | 106 | 401,852 B | 6,806 B |

最大工具更新的 `toolName` 为 `task`，字段分解如下。嵌套字段之间包含彼此，不能将所有行相加：

| 字段 | 字节数 | 内容 |
| --- | ---: | --- |
| `args` | 20,503 | 十个子任务的参数和公共上下文，每帧重复 |
| `partialResult.content` | 47 | 页面实际提取的简短运行提示 |
| `partialResult.details` | 148,644 | 全体子代理进度快照 |
| `details.progress` | 148,568 | 十个子代理，七个已经完成 |
| 已完成子代理的 progress 合计 | 137,490 | 在其他子代理更新时继续重复发送 |
| `progress[*].extractedToolData` 合计 | 112,785 | 已提取的工具结果；采到的样本含 `yield` 结果数组 |
| `progress[*].task` 合计 | 12,011 | 子代理任务描述 |
| `progress[*].assignment` 合计 | 11,661 | 子代理分配内容 |
| `progress[*].recentTools` 合计 | 5,156 | 近期工具元数据 |
| `progress[*].recentOutput` 合计 | 472 | 近期输出尾部 |

34 帧之间的 33 次相邻比较中，`args` **33 次完全相同**，已完成子代理的 progress **33 次完全相同**。大头不是几十字节的进度文本，而是没变化的参数、全体进度及完成结果被重复打包。

## 调用链

- 上游 OMP `task/index.ts` 的 `emitCombined` 在任一子任务进度变化时发送全体 `latestProgress`。
- 上游 `task/executor.ts` 的 `recordExtractedToolData` 把 `yield` 等工具结果放入 `progress.extractedToolData`。
- OMPiUI `packages/omp-worker/src/omp/omp-session.ts` 的 `emitPiEvent` 原样把工具更新交给 `EventSnapshotBuffer`。
- `EventSnapshotBuffer` 每 50 毫秒合并快照，只减少次数，不减少每帧内容。
- `packages/app/src/omp/eventStream.ts` 的 `tool_execution_update` 分支只从 `partialResult.content` 提取文本，然后安排 `state.get` 刷新；该路径不读取 `args` 或 `details`。
- 子代理状态另由 `omp.subagent` → `applyProgress` 更新，因此聚合的巨型 `details.progress` 在这条 UI 路径上是重复且未消费的数据。

## 修复方向与验收

1. 在 OMPiUI 的传输边界投影 `tool_execution_update`，只传当前客户端需要的字段。保留工具身份和文本，不在每帧附带未消费的调用参数、整组子代理进度或完成结果。
2. 保留 `tool_execution_start`、`tool_execution_end`、最终历史与子代理独立通道的语义，不通过截断最终工具结果来缩小数字。
3. 检查工具更新触发的 `state.get` 是否又重复回传整份子代理快照；按实际消费和恢复需要处理，不能只缩小 WS 而把大载荷搬到 HTTP。
4. 用现场形状的脱敏测试数据验证进度文本、普通工具输出、最终结果、重连恢复；再按无历史重放的相同窗口比较实际字节数。

## 与此前修复的关系

此前 issue #62 的 96.62% 降幅来自 HTTP `branch.get` 的可复现场景，仅覆盖历史页重复传输；它没有解决本次 WS `task` 进度的重复载荷。本记录是独立现场证据，不能沿用此前数字声称 WS 已修复。

## 修复结果（v0.6.16）

- 在 worker 进入事件队列前删除工具更新的 `args` 和 `partialResult.details`，完整保留 `content`；开始、结束、最终历史不裁剪。
- 子代理 progress 投影为前端实际使用的状态字段，独立通道和 `state.get` 恢复快照共用，移除未消费的 `extractedToolData`、嵌套任务详情及内层重复任务说明。
- 工具进度不再触发 `state.get`；结束边界仍刷新状态和历史。
- 与现场形状一致的十子代理测试载荷从 161,178 B 降为 151 B（事件正文，不含 WS 外层）。普通工具的大段文本不截断，最终工具结果完整保留。
- 新增及相关 worker 30 项、前端 41 项测试通过，包括实际适配层转发、完成状态恢复和 34 次进度不触发 HTTP 状态轮询。

公开记录仅包含字段、字节统计和代码路径，不包含鉴权信息、会话正文或任务报告。
