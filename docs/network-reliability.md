# 网络问题修复与验证

本轮对应 GitHub #84 至 #91。修改不改变官方 OMP 会话目录，不在浏览、
刷新或重连时启动写入 runtime，也不通过复制私有会话降低同步成本。

## 修复对应

| Issue | 处理 | 主要回归测试 |
| --- | --- | --- |
| #84 | RPC 重组限制 32 个在途条目、64 MiB 总字节、4096 个分片及单片 256 KiB；流式解析兼容官方大帧，不再拼接整帧 Buffer | `rpc-chunks.test.ts` |
| #85 | 三条命令路由统一使用 24 MiB `MAX_PROMPT_BODY_BYTES`，保留超限后 413 和关闭连接的语义 | `network-limits.test.ts` |
| #86 | relay 上下行同时限制字节和帧，升级连接也计费；超限清理对应连接，保留原有慢消费者隔离 | `data-rate-limit.test.ts`、`backpressure.test.ts`、`integration.test.ts` |
| #87 | 订阅差异重放、128 个 WS 连接上限、1024 个 hub listener 上限；历史限制每流 2 MiB、总计 32 MiB；活动状态 200ms 合并并发送 delta，首次订阅包含空全量基线 | `network-limits.test.ts`、`start.test.ts`、`networkRecovery.test.ts` |
| #88 | WS 指数退避及抖动，最多 10 次自动重试、最长 30s；在线/重新可见可恢复。磁盘轮询与命令查询自适应降频，健康失败退避，支持 Web Locks 的可见标签页共享探测 | `networkRecovery.test.ts`、`controller.test.ts` |
| #89 | IPC 8 MiB 字节水位含在途发送，快照 1 MiB 刷新预算，子代理文本按 UTF-8 字节切片，恢复尾窗不随普通增量重复发送；磁盘 JSONL 与图片附件按 256 KiB 分页 | `network-buffers.test.ts`、`omp-catalog-child-messages.test.ts`、`transport/index.test.ts` |
| #90 | pending 1 MiB/1024 条上限，激活超限明确报告过期；回放窗口按字节限制，标题只在变化时广播，1013 时立即清空队列并 detach | `terminal-buffers.test.ts`、`network-limits.test.ts` |
| #91 | 有缓存的 resync 走增量，首次才 preview；pane 关闭保留游标，合并同会话请求并保留失败/状态先返回情况下的末次补刷；协商 gzip | `networkRecovery.test.ts`、`recoveryOrdering.test.ts`、`controllers/index.test.ts` |

relay 默认每个方向每秒 16 MiB，突发 32 MiB，帧速率 2000/s、突发 4000。
上传连接另有每秒 4 MiB、突发 8 MiB 的配额。ResponseSink 原有的
`abort → dispose` 已经释放队列，本轮未重复改动该正确逻辑。

增量同步基线失效、会话分支改变或服务端重新播种时仍允许一次有界全量页，
不能为了减少流量而丢失历史。活动状态采用全量初始化加后续 delta；
本轮前后端应配套部署。附件响应包含 `nextOffset`、`totalChars` 和 `hasMore`，
调用者需使用 `offset` 续读并拼接 base64 后解码。

## 官方会话互通

显式启用 `network-native-interop.test.ts`，用安装的官方 `omp`、隔离临时目录
及本机假模型 HTTP 端点验证：终端创建后 UI 恢复续写，UI 创建后官方
`--continue` 发现并续写，以及带同步游标的预览不改变文件。测试不使用真实
模型凭据，也不会访问生产任务。

```powershell
$env:OMPIUI_TEST_NATIVE_OMP='1'
node --import tsx --test packages/omp-worker/src/omp/network-native-interop.test.ts
```

`branch-traffic.test.ts` 的固定业务样本包含 60 个初始工具输出、17 次追加、
35 次刷新。保持全部 77 个条目时，总传输从 10,327,334 B 降至 348,610 B
（96.62%）。这是受控回归样本，不代表所有真实网络场景都具有相同收益。

## 验证范围

Node 专项测试覆盖真实 HTTP、WS、终端和 relay 转发，以及刷新乱序、
弱网络失败、中文/emoji、大转录与官方会话互通。Bun 已验证 gzip、
三路 413 与解析库加载；Bun 自带 `ws` 测试客户端不支持
`unexpected-response`，其客户端兼容性超时不能作为服务端行为的验证结果。
移动设备切网、长时间锁屏和线上负载仍应在配套部署后结合诊断时间线验收。
