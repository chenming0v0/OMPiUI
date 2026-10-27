---
name: ompiui-tool-rendering
description: 在 OMPiUI 里新增或修改工具调用的显示时使用：给新工具加图标/标题/自定义 renderer、调整工具行布局或时间线连线、把非 toolCall 的条目（后台任务 async-result、系统消息等）显示成工具行。动手前先读，避免自绘卡片、补线开关、工具组被劈开这些已经踩过的坑。
---

# OMPiUI 工具调用渲染

工具行的外观（图标列、竖线、header、耗时、折叠）**只有一套**，由 `ToolGroup` / `ToolPartView` 负责。新工具只往这套框架里填数据，不另起炉灶。

## 渲染链路

```
时间线条目 PiTimelineItem[]
  → buildVisibleTimelineEntries          features/chat/chatAreaVisibility.ts
      相邻的「以工具结尾 / 以工具开头」助手消息合并成一条；后台任务投递也在这里并入
  → MessageRenderer                      features/message/MessageRenderer.tsx
      → groupBlocksForRender             连续 toolCall 块 → 一个 tool-group
      → ToolGroup                        features/message/parts/ToolGroup.tsx
          「N/N steps」头、批量 task 拆行、选布局
          → ToolPartView                 features/message/parts/ToolPartView.tsx
              descriptive | compact（单工具）| timeline（多工具，w-8 图标列 + 连线）
              → ToolBody → 注册表 renderer 或 DefaultRenderer
  非对话条目 → PiSystemItemView           features/message/parts/PiSystemItemViews.tsx
```

时间线竖线**只在同一个 ToolGroup 内**由 `isFirst` / `isLast` 决定画不画。跨条目、跨组永远不连。**想让两行连起来，就把它们放进同一个组**，别去画线。

## 新增一个工具：清单

1. **注册表** `features/message/tools/registry.tsx` 的 `toolRegistry`：加 `{ match, icon, extractData?, renderer? }`。
   - 首个匹配的配置生效：精确名用 `exact()` 放前面；`includes()` 容易误伤（`todo` 必须在 `write` 前面，否则 TodoWrite 会命中 write）。
   - 图标放 `tools/icons.tsx`，没有匹配时会回退成 `WrenchIcon`。
2. **数据提取** `extractData`：在 `defaultExtractData(execution)` 的结果上改，不要从零写。默认实现已经处理好错误、截断 notice、`fullOutputPath`、图片、diff、diagnostics，自己重写一定会漏。
3. **行内标题**：在 `ToolPartView.tsx` 的 `extractToolTitle` 里加一个 case（命令 / 路径 / 模式这类真正有信息量的内容）。默认取 `args.description`。
4. **行首名**：默认是 `formatToolName(name)`。要显示非工具名的文字（例如「后台任务」），在**执行记录**上打标记，让 `ToolPartView` 按标记选 i18n 文案（参考 `PiToolExecutionState.backgroundJob`）。**不要**给 `ToolGroup` / `ToolPartView` 加 `nameOverride` 这类 prop。
5. **步骤摘要分类**：`ToolGroup.tsx` 的 `getToolSummaryCategory` 决定描述型 steps（如「Ran 2 commands, read 3 files」）把它算进哪一类，不加就归为 other。
6. **自定义 renderer**（可选，放 `tools/renderers/`，并从 `renderers/index.ts` 导出）：只负责 body。header、图标、耗时、折叠全部由外壳负责。失败时 `ToolBody` 会自动改用 `DefaultRenderer` 显示原始错误（task 除外），renderer 里不要再画一套失败样式。
7. **i18n**：`src/locales/zh-CN/message.json` 和 `src/locales/en/message.json` 两份都要加。
8. **测试与验证**：见文末。

## 不是 toolCall 但要显示成工具行

例如 async-result 后台任务投递、其他 custom_message。正确做法（参考 `parts/backgroundJobExecution.ts` 与 `chatAreaVisibility.ts`）：

1. **合成 `PiToolExecution`**：`call`（name 决定图标和 renderer，没有对应 renderer 的类型用通用名，别冒用 `bash`，BashRenderer 依赖 FullscreenProvider）、`result`、`startedAt` / `completedAt`。
2. **call id 全局唯一**（例如 `job:<entryId>:<jobId>:<index>`）：合并后所有执行共用一个 `toolResults` / `toolExecutions` map，id 重复会互相覆盖。
3. **按条目引用缓存**合成结果（`WeakMap`）：时间线合并缓存和 `memo` 都比较引用，每次都新建对象会让整列历史行跟着重渲染。
4. **在 `buildVisibleTimelineEntries` 里并入相邻工具链**：这种条目可以续接工具链，但不能自己起头。前面是正文时它保持独立条目，由 `PiSystemItemView` 用普通 `<ToolGroup executions={…} plain />` 渲染。
5. 合并后的 `message` / `isStreaming` 取链上**最后一条真实的助手消息**，因为合成条目没有模型状态。

## 禁止（都踩过）

- **自绘卡片外壳**：自己写 header、边框、状态徽标（完成 / 失败 / 运行中）、折叠箭头、结果预览小字。状态只通过行名颜色和耗时表达，和其他工具一致。
- **用布局开关补线**：`forceTimeline`、`standaloneConnectors`、负 margin 把连线探出组外、改连线高度去盖住组间距。独立条目上下补的线什么也连不上，只会悬在那里。要连就并组。
- **为了对齐强改单工具布局**：单工具组用 compact（14px 列）是全局约定。和邻居对不齐，说明它本该和邻居在同一组。
- **在 PiSystemItemView 里给每个 job / 子项单独套一个 ToolGroup**：同一次投递的多个子项放进同一个组，才会有组内连线和「N/N steps」。
- **特化 renderer 吞掉失败、截断 notice 或图片**：用 `ToolBody` 的 `specialized()` 包装，别绕开它。

## 测试

- 注册表 / 提取：`tools/registry.test.ts`。
- 时间线合并、steps 计数、组内连线：`message/ContiguousToolGroups.test.tsx`（用 `buildVisibleTimelineEntries` + `MessageRenderer` 断言「N/N steps」和 `sourceIds`）。
- renderer：同目录的 `*.test.tsx`。渲染 bash 要包 `FullscreenProvider`。
- 数据尽量用真实会话脱敏后的片段，放 `tools/__fixtures__/`，参考 `xdTaskAsyncDispatch.ts`。

## 验证

```bash
node node_modules/typescript/bin/tsc -p packages/app/tsconfig.json --noEmit
cd packages/app && npx vitest run src/features/message src/features/chat
cd packages/app && npm run build   # tsc -b 会报未使用的 import / 变量，--noEmit 不报
```

然后在预览（8799）里强制刷新，打开一条真实会话，核对：

- 新工具行的图标和上下行在同一列，竖线连续，不悬空。
- 单工具、多工具、夹在两段工具之间、跟在正文之后，这四种位置都正常。
- 运行中、排队、完成、失败四种状态都正常。
- 「设置 → 描述型步骤」开、关两种模式都看一遍。
