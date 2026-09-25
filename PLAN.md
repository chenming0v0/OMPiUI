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

## 里程碑

- [x] M0 探索：确认 OMP RPC 协议可用（已完成端到端冒烟测试：set_model → prompt → prompt_result → session_settled）
- [x] M0 git init、PLAN.md
- [ ] M1 项目骨架：复制 PiUI 四包为 OMPiUI 基底，剥离 Pi SDK 依赖
- [ ] M2 omp-worker：RPC 子进程驱动（协议 v2、事件转发、子代理订阅、会话列表/恢复）
- [ ] M3 前端接通：session 流、聊天流、模型选择全走 OMP
- [ ] M4 子代理 UI：TaskRenderer 风格（状态徽章、展开实时转录、ToolBadge、todo 列表）
- [ ] M5 构建 + 浏览器实测（真实对话、子代理启动、模型切换）并修复
- [ ] M6 README、推 GitHub、发 issues

## 测试凭据（临时，2 天后过期）

- baseUrl `http://154.9.227.164:3000/v1`，模型 `[wb]deepseek-v4-flash`（已写入 `~/.omp/agent/models.yml` 的 `wbtest` provider）
