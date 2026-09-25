# OMPiUI 计划

> OMPiUI = **PiUI 的 UI 资产** + **OMP (oh-my-pi) 的 agent 运行时**。
> 目标：做一个 OMP 的第三方 Web UI，功能与 OMP 完全对接。

## 背景与素材

| 素材 | 位置 | 作用 |
| --- | --- | --- |
| PiUI | `temp/PiUI-main` | 全部 UI 资产：界面、session 浏览、扩展 UI（agent 执行层将被替换） |
| oh-my-pi (OMP) | `temp/oh-my-pi` | agent 运行时。npm 包 `@oh-my-pi/pi-coding-agent`，CLI `omp`，官方 RPC 模式 `omp --mode rpc` |
| OpenCodeUI | `temp/OpenCodeUI` | 子代理 UI 参考（PiUI 没有子代理 UI）：TaskRenderer / SubSessionView / ToolBadge 设计 |

## 核心架构决策

1. **运行时对接方式：OMP 官方 RPC 模式**（`omp --mode rpc --no-ui`，stdio 上的 newline-delimited JSON，协议 v2 支持 64MB 无损分帧）。
   - 不采用 in-process SDK（`createAgentSession`），因为它要求 Bun 运行时；RPC 模式让 OMPiUI server 保持纯 Node。
   - 我们在 worker 中实现一个完整的 RPC client 驱动（协议协商、请求关联、事件转发、子代理订阅）——这层就是"包装好的 OMP SDK"。
2. **子代理数据源：OMP 原生子代理帧。**
   - `set_subagent_subscription level=events` → `subagent_lifecycle` / `subagent_progress` / `subagent_event`
   - `get_subagents` 快照、`get_subagent_messages`（支持 `fromByte` 增量读取子代理会话转录）
   - UI 按 OpenCodeUI 的 TaskRenderer / SubSessionView / ToolBadge 设计实现。
3. **UI 资产 100% 来自 PiUI**：packages/app 全量保留（session 列表、聊天视图、markdown 渲染、设置页），仅把数据源从 Pi 换成 OMP。
4. **模型/凭据**：OMP 读取 `~/.omp/agent/models.yml`（provider baseUrl/apiKey/models）。OMPiUI 的设置页直接对接 OMP RPC 的 `get_available_models` / `set_model`；provider 配置文件管理后续迭代。

## 包结构（npm workspaces）

```
packages/
  app/        React 前端（来自 PiUI @piui/app，UI 资产保留）
  server/     Node HTTP+WS 服务（来自 PiUI @piui/server）
  omp-worker/ 替代 @piui/pi-worker：spawn `omp --mode rpc`，桥接 WS <-> RPC
  protocol/   前后端消息协议（来自 PiUI @piui/protocol，扩展子代理帧）
```

## 里程碑（执行结果）

- [x] M0 探索：确认 OMP RPC 协议可用（端到端冒烟：set_model → prompt → prompt_result → session_settled）
- [x] M0 git init、PLAN.md
- [x] M1 项目骨架：复制 PiUI 四包为 OMPiUI 基底
- [x] M2 omp-worker：OmpRpcSession/OmpCatalog/OmpProviderAuth/OmpExtensionUiBridge（协议 v2、rpc_chunk 重组、事件适配、子代理订阅、扩展 UI 桥）
- [x] M3 前端接通：session 流、聊天流、模型选择全走 OMP（磁盘目录 + 控制进程）
- [x] M4 子代理 UI：TaskRenderer 内联 SubSessionView（进度/token/工具徽标/转录流）+ omp.subagent 通道
- [x] M5 构建 + 浏览器实测（真实对话×2 模型、子代理×2、模型切换、新会话）并修复
       - 修复：omp.exe 解析、React #185（store 快照缓存）、wbtest 网关 wait 工具 0-token 兼容层
- [x] M6 README、推 GitHub、发 issues

## 实测结论（2026-09-25）

- wbtest 网关（http://154.9.227.164:3000/v1，[wb]deepseek-v4-flash）：纯文本对话 OK；原生 function calling 被上游拒绝（invalid function call parameters / 0-token 空响应），DSML 内联方言被翻译层损坏 —— 网关缺陷，已做 compat 覆盖层 + 记录 issue
- 子代理实测改用用户配置的 f_grok/grok-4.7：task 工具真实启动子代理（BananaReply/MangoSum），omp.subagent 帧全程到达前端，内联实时转录工作正常
