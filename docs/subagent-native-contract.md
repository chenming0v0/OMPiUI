# 子代理原生契约提案：运行身份与合并结算

> 状态：原生完整契约的本地提案，未实现、未提交上游。关联 OMPiUI [#373](https://github.com/chenming0v0/OMPiUI/issues/373)、[#374](https://github.com/chenming0v0/OMPiUI/issues/374)。
>
> 范围澄清：下文解释的是官方 RPC 缺少完整原生身份／合并结算契约，不代表 OMPiUI 无法做客户端兼容。维护者已明确不改 OMP；后续优先评估公开 `AgentSession.subscribeRunState()`／registry 观察结合 OMPiUI 自有代次，并区分执行完成与合并未确认。该兼容方案尚未实现或验收，不能在本次提交中记为 #373/#374 已完成；上游提案也不代表已获对外提交授权。
> 本轮仅核对固定源码、读取历史证据；没有运行 native、执行子任务或重试合并，没有修改业务代码、私有 runner 或 `node_modules`。

## 1. 结论与版本边界

要从现有 RPC 帧完整还原原生运行身份和合并结算，仍需要原生生产者补齐契约。下述缺口不否定客户端通过公开运行观察和保守状态展示修正自身界面的可行性；两者应分别验收：

- **#373：运行身份缺失。** 同一 child id、parent tool call 和子会话文件可跨运行复用；旧运行的终态不能据此识别为旧帧，原生 snapshot 也可能被它清除。
- **#374：合并结算缺失。** 子任务执行成功与变更回写成功是两个事实。root merge 已有 `changesApplied` 三态，但没有完整 typed root/nested settlement；原生 TaskTool 又丢弃该字段，公开事件及持久化结果无法表达回写失败。

核对基线固定如下，不使用浮动 `main` 链接：

| 基线 | 固定提交 | 本文证据性质 |
| --- | --- | --- |
| 官方 18.12.6 | 历史记录内的 runtime/version | 已有官方 `omp.exe` 记录；本轮只读，不重跑 |
| 最新正式 [v18.14.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.14.0) | [`31147f9d1a76608549821c3759f8487b4d66c72d`](https://github.com/can1357/oh-my-pi/tree/31147f9d1a76608549821c3759f8487b4d66c72d) | 发布源码核对，不是最新 native 实测 |
| 本轮固定 main | [`338d2ce6658dfdbfba19efe0f006f0d5a8edd66d`](https://github.com/can1357/oh-my-pi/tree/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d) | 源码核对，不是运行验收 |

本轮通过只读 GitHub API 确认 v18.14.0 为最新非 prerelease、非 draft 发布，tag 指向上述 release SHA。所核对的 executor、isolation-runner、structured-subagent、task/index、task/types、agent-registry、TUI observer/types 与 RPC types 在 release 和固定 main 中内容相同。下文源码链接统一使用固定 main SHA。这些接口在官方 18.12.6 历史记录及 v18.14.0 固定源码上均不满足需求；**不据此声称最新二进制已复现相同时序**。

## 2. 两份最小脱敏证据

以下是历史记录的字段投影，不是完整 RPC payload。路径统一替换为同一个 `<sessions>/…` 占位路径；省略正文、提示词和环境信息。`n` 是记录的帧序号，`frameIndex` 是 #374 回放记录中的序号，均不是协议 runId。

### #373：新 started 之后到达旧 completed

来源：`.slim/issue-retry-373-1/.probe373/run2/native-ordering-evidence.json`。记录标明官方 18.12.6、确定性本地 provider 驱动真实 native task/write/bash；不构成真实模型或 GUI 验收。

```json
[
  {"n":129,"type":"subagent_lifecycle","payload":{"id":"OrderingChild","index":0,"parentToolCallId":"provider-spawn","sessionFile":"<sessions>/OrderingChild.jsonl","status":"started"}},
  {"n":150,"type":"subagent_progress","payload":{"parentToolCallId":"provider-spawn","sessionFile":"<sessions>/OrderingChild.jsonl","progress":{"id":"OrderingChild","index":0,"task":"RETRY373_ASYNC_OBSERVATION","status":"completed"}}},
  {"n":151,"type":"subagent_lifecycle","payload":{"id":"OrderingChild","index":0,"parentToolCallId":"provider-spawn","sessionFile":"<sessions>/OrderingChild.jsonl","status":"completed"}},
  {"n":163,"type":"response","command":"get_subagents","data":{"subagents":[]}},
  {"n":168,"type":"subagent_event","payload":{"id":"OrderingChild","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"<new-run reply redacted>"}]}}}},
  {"n":171,"type":"response","command":"get_subagents","data":{"subagents":[]}}
]
```

n129 对应第二次观察的新运行；n150 的 task 仍为上一次 `RETRY373_ASYNC_OBSERVATION`，n151 是随后的旧终态。三者复用相同 id/index/parent/file，原始帧没有 `runId`。n163 snapshot 已为空，n168 新回复仍继续到达，n171 仍为空。正文内容可帮助调查者复盘，**不能成为产品判定运行身份的规则**。

同一记录还保留了 byte cursor 增量读：`16037 → 17364`、`reset:false`、两条新增 entry。这证明文件继续追加，不证明当前 run 已完整结束；字节位置不是运行 endcap。

### #374：执行 exit 0，但原生结果没有合并事实

来源：`.slim/issue-retry-374-1/.tmp/issue-374-retry-evidence.json`。这是对已记录 native Git-conflict frames 的只读公开 API/event-controller 诊断；该诊断自身没有执行 child 或 merge。下列布尔值是记录的字段存在性检查，不是原生协议字段。

```json
[
  {"frameIndex":153,"id":"MergeChild","status":"started","nativeSnapshotIds":["MergeChild"]},
  {"frameIndex":197,"id":"MergeChild","status":"completed","nativeSnapshotIds":[]},
  {"parentTaskEndIndex":199,"extensionExecutionEnd":{"type":"tool_execution_end","isError":false,"sameResultObject":true}},
  {"persistedRead":{"taskIsError":false,"result":{"id":"MergeChild","exitCode":0,"aborted":false,"errorPresent":false,"mergeErrorPresent":false,"changesAppliedPresent":false}}},
  {"childRead":{"sessionFile":"<sessions>/MergeChild.jsonl","nextByte":17100,"reset":false,"parentMergeFields":[],"incrementalEntryCount":0}}
]
```

执行 exit code 与 completed 是原生已投影的事实；已证明冲突后的合并事实没有进入该 child 的 TaskTool result，公开 `tool_execution_end` 看到的仍是同一个已构造结果，子 transcript 也没有 parent merge 字段。正常、非零退出、abort 的对照记录不改变这个缺口。不得补造 `mergeError`，也不得把历史 GUI 成功配色回放算作验收。

## 3. 固定源码中的缺口与修改点

链接中的路径以 `packages/` 为根；表内均为上游建议修改点，本仓库本轮不修改。

| 边界 | 固定源码 | 当前事实 / 建议 |
| --- | --- | --- |
| executor monitor | [coding-agent/src/task/executor.ts L1339–1375](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L1339-L1375) | 创建运行闭包及 progress，目前无 runId；在此生成不可变身份 |
| progress / raw event | [executor L1612–1630](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L1612-L1630)、[L1733–1736](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L1733-L1736) | progress 从闭包发出；raw payload 仅 `{id,event}`，需携带同一 run identity |
| terminal / result | [executor L2975–3000](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L2975-L3000) | execution terminal 与返回结果需使用原 monitor 身份，而不是读取 registry 当前运行 |
| wake / follow-up / spawn | [executor L3316–3352](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L3316-L3352)、[L3773–3804](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L3773-L3804)、[L4917–4929](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/executor.ts#L4917-L4929) | 每个新执行 monitor 的 started 必须使用其新 runId；session/file 可继续复用 |
| observer / raw types | [tui/src/overlays/session-observer-registry.ts L10–40](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/tui/src/overlays/session-observer-registry.ts#L10-L40)、[coding-agent/src/task/types.ts L36–43](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/types.ts#L36-L43) | progress/lifecycle/raw event 类型均没有 runId |
| registry lifecycle | [coding-agent/src/registry/agent-registry.ts L29–43](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/registry/agent-registry.ts#L29-L43)、[L238–265](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/registry/agent-registry.ts#L238-L265) | 仅有 response/accepted/terminal 时间，重新 running 时清除；时间重置不提供传输身份 |
| RPC snapshot / history | [coding-agent/src/modes/rpc/rpc-types.ts L397–419](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/modes/rpc/rpc-types.ts#L397-L419)、[rpc-subagents.ts L47–57](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/modes/rpc/rpc-subagents.ts#L47-L57)、[L70–106](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/modes/rpc/rpc-subagents.ts#L70-L106)、[L196–225](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/modes/rpc/rpc-subagents.ts#L196-L225) | owner 判定依赖 parent/file，terminal 按 id 删除 snapshot；history 只有 fromByte/nextByte/reset，无 run endcap |
| root merge | [coding-agent/src/task/isolation-runner.ts L619–631](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/isolation-runner.ts#L619-L631)、[L672–702](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/isolation-runner.ts#L672-L702)、[L765–777](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/isolation-runner.ts#L765-L777) | 已有 changesApplied 三态；失败诊断进入 summary，需在产生事实处同时生成 typed status/error/recovery |
| nested apply | [isolation-runner L803–825](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/isolation-runner.ts#L803-L825)、[coding-agent/src/task/worktree.ts L464–522](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/worktree.ts#L464-L522) | 前者只返回 string，后者只返回警告 string[]、可能抛错；需在实际 apply/restore 分支记录 typed outcome，不能从最终字符串反推 |
| structured orchestration | [coding-agent/src/task/structured-subagent.ts L909–959](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/structured-subagent.ts#L909-L959) | root outcome 留在 result 旁，nested 状态只进 summary；先补 root/nested 类型，再传播至 SingleResult 并发出 post-merge settlement |
| TaskTool projection | [coding-agent/src/task/index.ts L1921–1926](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/task/index.ts#L1921-L1926)、[tui/src/tools/task.ts L2487–2582](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/tui/src/tools/task.ts#L2487-L2582) | buildResultPayload 传 result 和 mergeSummary，却未传 changesApplied；SingleResult 无 runId/merge settlement，需贯通类型、结果及持久化 |

## 4. #373：原生不可变 run identity

### 建议类型

以下 TypeScript 仅为上游接口建议，不是现有 API：

```ts
type SubagentRunId = string; // opaque；native 生成，跨重连/持久化可识别

interface SubagentRunIdentity {
  readonly runId: SubagentRunId;
  readonly id: string;
  readonly index: number;
  readonly parentToolCallId?: string;
  readonly sessionFile?: string;
}

interface SubagentRunBoundary extends SubagentRunIdentity {
  phase: "started" | "execution_terminal" | "settled";
}
```

### 生产者不变量

1. **在 core executor 的 `createSubagentRunMonitor` 边界生成一次。** 身份由 native monitor 的不可变闭包持有；start、定时 progress、raw event listener、finalizer、result 和后续 merge settlement 引用该身份。异步回调不得临时读取 `AgentRegistry.get(id)` 的当前 runId 给旧回调补标签。
2. spawn、follow-up、IRC wake、warm/persisted revive 后真正开始的新运行都获得新 runId。相同 monitor 内的 provider retry/重挂监听不换 runId；未执行的 preflight refusal 不伪造一个已启动 run。
3. registry 的 current run、activity、responseAt/acceptedAt/terminalAt、result acceptance 和 status 更新须接受 expected runId；原有 session/ref ownership 防护继续保留。旧 run 结算可以留存历史，但不得改写新 run 的当前状态。
4. runId 贯穿 `AgentProgress`、三种 subagent payload、RPC snapshot、`SingleResult`、async-result/job 的 child 关联和历史边界。已有 parent id/index/file 继续携带，不能被 runId 替代为无父关系的数据。
5. TUI observer 与 RPC registry 以 runId 区分运行；可以保留 id→currentRun 的索引，但只能由**匹配 currentRun 的终态**移除当前 snapshot。n150/151 形式的旧帧不能删除 n129 对应的新运行。
6. 同 run 的 execution terminal 后不得再有新的执行 progress/raw event；重投递去重不能终态倒退。旧 run settlement 晚于新 run started 可以合法发生，但必须仍绑定旧 runId。

### snapshot 与 history 边界

- `get_subagents` 每项暴露 current runId；运行已从 active snapshot 移除时，历史仍能查询该 run 的边界与结算，不靠“snapshot 为空”推断成功或 transcript 已完整。
- 保留 `get_subagent_messages` 的 fromByte 增量能力，增加 run selector 和原生 run boundary 元数据；共享 JSONL 中持久化 start、execution-terminal、settled 标记及对应 runId。可采用既有 custom entry 承载，不要求每次运行创建新文件。
- endcap 表示该 run 的指定阶段已封闭及其持久化边界，不等于“读到了当前文件 EOF”。同一文件随后可追加另一 run；读到任意 byte cursor 不自动完成旧 run，也不把新回复归入旧 run。
- 新契约的边界与结果应在事件可见前完成相应持久化，使重连和全量/增量历史读取获得同一事实。旧文件缺 runId 时只提供 legacy 历史，不凭时间、正文、文件名或客户端计数重建权威身份。

## 5. #374：typed root/nested settlement 与 post-merge 投影

### 保持官方 changesApplied 语义

`IsolationMergeOutcome` 已明确定义：

| 值 | 官方含义 | 消费规则 |
| --- | --- | --- |
| `false` | merge 尝试失败，保留 artifacts | 明确回写失败；不能标成未知成功 |
| `true` | merge 完成，或没有内容需要应用 | 不等于确实修改了文件；结合 hadAnyChanges 区分 no-op |
| `null` | caller 跳过 merge phase，例如 apply=false | 显示跳过，不是成功或失败 |
| 字段缺失 | 旧接口没有投影事实 | 缺契约信息；不得填成 true，也不得伪填 null |

现有 root 字段不能被静默改成 root+nested 聚合值。建议结果保留 `changesApplied` 为 root 三态，同时用独立 settlement 表达 nested 失败、部分回写或恢复失败；root true 不掩盖 nested failure。

### 建议类型与判定

```ts
interface NativeMergeError {
  code: string; // native 在失败分支定义；不得从 summary/XML 猜测
  stage: "capture" | "root" | "nested" | "restore";
  message: string;
}

type NativeApplySettlement =
  | { status: "succeeded"; changesApplied: true; hadAnyChanges: boolean }
  | { status: "failed"; changesApplied: false; errors: NativeMergeError[] }
  | { status: "skipped"; changesApplied: null; reason: string };

interface NativeMergeSettlement {
  root: NativeApplySettlement;
  nested: Array<NativeApplySettlement & { repo: string }>;
  status: "succeeded" | "failed" | "skipped";
  warnings: Array<{ code: string; message: string; repo?: string }>;
  recovery?: {
    branchName?: string;
    patchPath?: string;
    nestedPatchPaths?: string[];
    retainedWorkspace?: string;
  };
}

// 新契约下的 SingleResult 扩展；保留原 execution 字段。
interface NativeSettledFields extends SubagentRunIdentity {
  changesApplied: boolean | null; // 保留 root 三态
  merge: NativeMergeSettlement;
}
```

`status` 是原生最终事实，不引入“未知成功”。root 或任一实际 nested apply/restore 失败时，整体 settlement 为 failed；root true 可与整体 failed 并存，表达部分回写。全部跳过为 skipped；实际阶段成功且其余阶段有明确跳过原因时可为 succeeded。空 patch/no-op 由 native 明确给出 succeeded/true 与 `hadAnyChanges:false`，不能由消费者自行推断。

对于当前 nested 返回的警告，上游需在产生处区分一般 warning 与未恢复用户 dirty state 等失败事实，保留 stash/patch 等恢复路径。没有 `.git`、不 eligible 或因 root 失败跳过的分支也要给出 typed skipped/reason；不能仅以空字符串表示成功。不得在 root 尚未 typed 化时直接把 nested summary 当 mergeError。

### 实施顺序与发布边界

1. **先补权威生产者类型。** 在 isolation-runner 的 root 返回/异常分支、nested apply 和 worktree 的实际 apply/restore 分支生成 typed status/error/recovery；summary 仅由这些事实格式化，保留原执行 exitCode、error、aborted、output、stderr。
2. **再贯通 structured-subagent。** root 和 nested 阶段均完成或明确跳过后，把 merge settlement、root changesApplied 与原 run identity 放入 SingleResult。capture/merge 异常即使 child exitCode 为 0 也必须保留执行事实及 typed merge failure，不改写成虚构的 child 非零退出。
3. **原生发出 post-merge settled。** 建议新增 `subagent_settled` 公共事件/通道；payload 携带 runId/id/index/parentToolCallId/sessionFile、执行终态和最终 merge settlement。execution `completed` 只说明执行结束，最终回写失败由同 run 的 settled 明确呈现，不能只输出一句摘要。
4. **TaskTool 不再丢字段。** flat、batch、async、follow-up 以及适用的 eval 路径统一保留 SingleResult 的 settlement；公开 progress/result、真实 TaskToolDetails.results 和 async-result 使用相同 child 关联。不能只修某一个调用分支。
5. **同一原生 JSONL 持久化。** parent 的真实 task toolResult/async-result 与 child run 的 settlement boundary 保存同一结算事实。child 可以复用同一 transcript，但 settled 不能丢失与原 parent call、child index、runId 的绑定；重连、历史读取、官方会话继续写入都不依赖 GUI 私有 sidecar。
6. **独立展示两类状态。** child execution exitCode/abort 不变；TUI/GUI 的最终任务状态和 error 指示使用结算事实。merge failed 不得再显示为完整成功，skipped/no-op 也不伪称“已应用变更”。

## 6. 公开扩展接口不能替代原生修复

- `before_subagent_spawn` 是执行前模型路由/拒绝 hook，child 的执行事件仍早于 parent merge。它们无法恢复尚未产生的合并结果。参见 [extensions/types.ts L1174–1183](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/extensibility/extensions/types.ts#L1174-L1183)。
- `tool_result` 可以修改已经返回的工具结果，但 native TaskTool 丢字段后，没有可供恢复的 typed authority；`tool_execution_end` 同理。参见 [extensions/types.ts L1550–1556、L1593–1601](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/extensibility/extensions/types.ts#L1550-L1601)。
- `ctx.invokeTool` 委托 native 不等于保留原 parent toolCallId。当前 [extensions/runner.ts L739–753](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/src/extensibility/extensions/runner.ts#L739-L753) 生成新的 `invoke-${name}-…` call id。即使继承 caller context、signal/onUpdate，也不能假定子帧仍属于外层 parent；应由上游定义显式 causal mapping。
- 不通过解析 XML、summary、任意 output 或提示词合成 mergeError；不重试保留分支的合并来“探测”已知失败；不创建 GUI 自有 `runStructuredSubagent` dispatcher、shadow controller 或 fork 私有 runner。
- 本地过滤乱序帧、重建世代计数、换色或增加终端入口，都不能补回原生缺失的运行/结算事实，也不构成 #373/#374 完成。

## 7. 上游验收矩阵（待实现后执行）

本表是建议验收，不是本轮通过记录。上游需提供新契约发布版本和真实 native 证据；OMPiUI 再进行 GUI、重连及官方会话互通验收。

| 场景 | 原生契约必须满足 | RPC / history / GUI 必须满足 |
| --- | --- | --- |
| 新 started 后旧 progress/terminal 到达，id/parent/file 均相同 | R1/R2 使用不同 runId，旧闭包始终携 R1 | R1 不删除或改写 R2 snapshot；新回复归 R2 |
| 同 monitor retry、监听重挂；warm follow-up / IRC wake / revive | retry 保持身份，新运行换身份；不在发送时查询 current run | start/progress/event/result/settled 身份一致 |
| abort / 非零退出 / timeout 与新 wake 交错 | 执行终态及 abort reason 留在所属 run | 旧 run 不回到 running，不终止新 run |
| root 合并冲突或 patch apply 失败，child exit 0 | changesApplied false、typed root error、恢复 artifacts；exitCode 保持 0 | post-merge failed、真实 TaskTool result 和同 JSONL 一致，不显示完整成功 |
| root 成功但 nested apply/restore 失败 | root true 保持；nested failed 与整体 failed，保留部分回写/恢复事实 | 不由空 summary 或 root true 推断全成功 |
| no-op / 已应用 patch / 无需 root 变更 | native 显式 true、hadAnyChanges false；nested 单独结算 | 显示无新增回写，不伪称发生修改 |
| apply=false / 无 isolation / 执行失败导致不进入 merge | 明确 skipped/null 与原因，执行失败独立保留 | skipped 不冒充成功；缺字段不冒充 skipped |
| flat / batch / async / eval / follow-up | 各路径保留 child id/index/parent/runId 与 settlement | 实时、结果、历史投影无字段损失；委托调用不能假定外层 parent |
| settlement 晚于另一个 run started，随后断线重连 | 结算归原 run，边界与结果原生持久化 | snapshot + byte 增量 + 全量历史还原一致；EOF 不冒充 run endcap |
| 同一官方会话在 TUI 与 OMPiUI 打开并继续 | 同一原生 JSONL，不创建 GUI 私有权威副本 | 浏览/刷新只读，不启动 native、不重试 merge；双向继续写入可见 |
| 旧 18.12.6 / v18.14.0 或无契约历史 | 显式能力/契约版本缺失，不生成假 runId/merge status | 保留 legacy 可读性，明确接口阻塞，不宣布完成 |

**交付边界：本轮完成的只是这份原生契约提案。完整原生契约需官方提供；OMPiUI 客户端兼容另按公开接口观察和保守显示方案评估、实施及验收，不修改 OMP，也不因这份文档把 #373/#374 关闭或记为已完成。**
