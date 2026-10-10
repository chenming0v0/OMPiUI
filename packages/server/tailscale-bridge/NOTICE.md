# Tailscale 网络组件

OMPiUI 的内嵌网络组件使用 Tailscale `tsnet`，固定版本见 `go.mod`。
该组件不是 Tailscale 官方客户端，也不是 Tailscale 公司发布或支持的产品。
默认连接官方协调和 DERP 服务；账号使用仍受官方服务条款及网络策略约束。

Tailscale 源码使用 BSD-3-Clause 许可证；依赖各自保留其许可证。
构建时生成的 `third-party-licenses.txt` 随桌面包发布，Android 放入 assets。
对应源码与依赖版本记录于本目录的 `go.mod`、`go.sum`。

Tailscale source: https://github.com/tailscale/tailscale
