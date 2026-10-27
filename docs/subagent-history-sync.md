# 子代理历史条件同步 v1

`subagent.messages` 在带有 `sync.version: 1` 时使用分块条件同步；不带
`sync` 时保持原有 `messages/fromByte/nextByte` 响应。只读 catalog 路由和
已附加 runtime 路由使用同一个读取器，不启动 Agent，不修改原生会话文件。

## 请求

```json
{
  "sessionFile": "/native/sessions/parent/child.jsonl",
  "fromByte": 0,
  "sync": {
    "version": 1,
    "knownBlocks": [
      { "fromByte": 0, "nextByte": 262500, "hash": "sha256:..." }
    ]
  }
}
```

`knownBlocks` 最多 32 项，必须对应客户端实际持有、且重新校验哈希成功的
完整正文块。首次读取和完整缓存的重新校验从零开始；加载更多携带前一页
的 `snapshot` 和 `nextByte`。已淘汰前段的阅读窗口可以携带同一快照从窗口
起点校验；快照过期必须从零重建。凭据摘要仅用于本地缓存隔离，不随请求提交。

## 响应

```json
{
  "syncVersion": 1,
  "snapshot": "sha256:...",
  "projection": "subagent-preview-v1:thinking-off",
  "blocks": [
    {
      "kind": "reuse",
      "fromByte": 0,
      "nextByte": 262500,
      "hash": "sha256:...",
      "previewTruncated": false
    }
  ],
  "fromByte": 0,
  "nextByte": 262500,
  "hasMore": false,
  "reset": false
}
```

`data` 块另带 `messages`；`reuse` 块不得带正文。客户端按响应顺序重建
结果，不把重新校验的历史盲目追加到旧列表。块区间必须连续，游标必须推进。
服务端可在一页中混合两类块，最多 32 块，正文预算约 256 KiB。

分块以完整 JSONL 行为边界，原始区间约 256 KiB；预览正文达到 256 KiB
或 200 条消息时也结束块。未完成尾行不消费，末尾小块追加后可以改变。
哈希采用 SHA-256，输入是键排序的规范化 JSON，包含版本、projection、
字节区间、投影后的 messages 和 previewTruncated，忽略 undefined 对象
字段，不包含快照或时间戳。浏览器与 worker 共用实现。

## 失效与缓存

快照绑定文件路径、大小、修改时间、变更时间、inode 和 projection。
分页期间文件状态改变返回 `SYNC_SNAPSHOT_EXPIRED`；客户端最多重试两次，
携带已持有的块从头重新校验，不能混合两份快照。思考显示开关改变
projection，旧块不能命中。缺失 reuse 正文时撤销该声明并补取当前页；
网络 data 块哈希不匹配时拒绝结果。

UI 使用 IndexedDB 保存完整正文与元信息，总上限 64 MiB / 64 份历史，
按最近保存顺序淘汰。单次阅读窗口为约 8 MiB / 2000 条消息，继续加载时
从已保存游标续读并淘汰旧块。内存保留最近 8 份历史；禁用持久存储时
退回内存，不影响网络读取。服务器切换清空内存，不清空隔离的持久记录。
缓存命名空间包含服务器配置 ID、实际地址、凭据摘要和会话文件。

旧服务端不支持 sync 时退回原来的增量读取。实时子代理消息仍使用现有
message_patch 和 progressDelta，不增加逐 token 哈希或额外探测请求。

## 会话身份替换与镜像隔离

成功 new/switch/消息 fork 后，worker 更新事件 epoch 并清空旧身份的 Goal、
子代理和缓冲消息镜像，再读取目标自身的原生 Goal、运行中子代理、队列、
模型和扩展命令。清理只发生在 UI 镜像，不向官方发送 goal drop 或资源 clear。
取消和原生操作拒绝不重置原身份。同身份树导航只失效历史投影；同 ID 的
目录迁移保留资源，通过独立的 `ompiui:session-relocated` 事件更新元信息。

旧 epoch 的 state/get_subagents 读取返回 `SESSION_REPLACED`，不能把目标状态
作为旧身份的响应返回。Goal 快照还绑定 Goal 更新代次，不能覆盖读取期间
到达的新原生事件。pane 的异步提交绑定身份 epoch，切走再切回相同 ID 也
不能使旧提交重新有效。成功替换取消源身份的延迟刷新/重同步，并失效目标
旧 runtime 的在飞读取，但不删除目标自身的历史与资源。

OMP 18.12.6 隔离原生 smoke 已观察到真实任务子代理、两个会话自身的暂停
Goal、new/switch/fork、原生取消/拒绝和同文件非 no-op 树导航；延迟交付真实
state、运行中子代理注册表及 Goal 快照后替换，旧结果与缓冲子代理帧未进入
目标。只读 catalog 列表/预览/状态读取保持源文件字节和 mtime，官方 RPC
按原生 ID 恢复后继续写入，同一文件随后由 GUI runtime 恢复原 Goal 并续写。
这些是原生 runtime 与 worker 边界证据，不替代集成后的所有源 pane GUI、
服务端身份/租约迁移及原生延迟 settle/Goal continuation 全矩阵验收。

