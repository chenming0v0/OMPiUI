# 内嵌 Tailscale 实施计划

## 目标

Windows、Linux/WSL 后端和 Android App 自带 Tailscale 网络核心。用户通过官方网页授权两个独立节点加入同一个 Tailnet，再使用 OMPiUI 一次性配对码建立访问权限。不安装官方客户端、不创建 Android `VpnService`，不需要自建协调或中转服务器。

Tailscale 节点身份和 OMPiUI 访问令牌分别保存。Tailnet 内流量仍经过 OMPiUI 现有鉴权；不使用 Funnel，不公开后端。

## 实施顺序

1. 已完成：确认现有安装器、配对协议、HTTP/WebSocket 和打包边界，保留工作区其他改动。
2. 已实现：Go `tsnet` 电脑网关、Node 生命周期管理、官方登录链接、私有监听入口和自动恢复。
3. 已实现：Android 内嵌 Go AAR、异步原生桥、手机独立登录与按目标转发 HTTP/WebSocket。
4. 已实现：电脑设置面板、手机离线可用登录入口和完整配对链接导入。手机登录直接打开官方授权页，不显示手机自身的登录二维码。
5. 已接入：Windows/Linux 网关、Android AAR、桌面资源与发布工作流；本地已成功构建 arm64 调试 APK，正式发行包由 GitHub Actions 生成。
6. 已完成针对性测试：状态恢复、授权失败、配对鉴权、HTTP/WebSocket 转发和桌面/手机布局。跨公网连接、真实账号授权、Android 后台回收与网络切换交给测试人员实机验收。

## 连接设计

- 电脑：`tsnet.Listen` 接受 Tailnet 请求，反向代理到当前 Node 后端；保留远端 Host 和现有鉴权。
- 手机：`tsnet.Dial` 建立到所选电脑的连接，本地回环反向代理供 Tauri HTTP 和 WebSocket 桥使用；服务地址仍保存为真实 Tailnet 地址。
- 两端默认使用官方控制平面和官方 DERP；首次授权、设备审批及密钥过期仍遵循 Tailscale 规则。
- 内嵌组件只在用户启用后运行。恢复已授权身份不需要重新登录。
- 普通手机浏览器没有内嵌核心，不能作为免客户端 Tailnet 连接入口。

## 验收边界

本地测试覆盖编译、反向代理、鉴权、状态机、配对和连接地址转换。跨公网直连/DERP、手机后台回收、真实账号授权和网络切换，需要真实设备及用户授权后验证。构建成功不等于这部分已实机验收。
