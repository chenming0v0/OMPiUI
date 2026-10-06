# OMPiUI 服务器管理平面计划

状态：已交付（2026-10-06）；同批附带修复 issue #24（内置 Local 服务器条目可编辑）。

## 目标与边界

OMPiUI 编程前端继续保持在 `packages/app`，只负责会话、模型、工具和工作区。新增的管理平面负责服务器生命周期、凭证、分享链接、隧道状态和无桌面部署；两者通过现有 HTTP API 连接，不把管理功能塞进编程聊天界面。

管理平面不复制 OMP provider 配置，也不读取或写入 `~/.omp/agent` 的凭证；它只管理 OMPiUI 服务自身的访问令牌、管理令牌、监听/公网/中转配置和进程生命周期。

## 分阶段执行

1. **基线与安全边界**（本次先做）
   - 保留现有服务 API token 鉴权和 `~/.ompiui` 状态目录。
   - 为服务器管理建立独立入口：TUI + 独立管理 Web UI。
   - 管理入口默认只监听回环地址；公开绑定必须显式配置并使用独立管理令牌。
2. **可运行管理器**（本次交付）
   - 新增 `@ompiui/admin`，统一管理后端子进程的 start/stop/restart/status。
   - TUI 展示健康状态、服务地址、访问凭证、分享链接和隧道状态，并提供生命周期操作。
   - 管理 Web UI 使用同一套管理 API，路径和静态资源独立于 `packages/app`。
   - 配置持久化到 `~/.ompiui/admin.json`，文件权限限制为仅所有者。
3. **VPS / Docker 安装**（本次交付）
   - Linux 一键安装脚本：安装依赖、构建、生成管理令牌、创建 systemd 服务并输出管理地址。
   - Dockerfile/entrypoint：前台运行管理器，适合 VPS 和容器，不依赖桌面或 systemd。
4. **验证与维护**（本次交付）
   - 增加管理器的生命周期和鉴权测试。
   - 跑管理器 smoke、服务器相关测试和构建。
   - 修复验证中发现的真实 bug；根目录 `CHANGELOG.md` 记录变更。

## 后续明确不混入本次切片

- 不在管理平面重新实现 OMP provider 登录；继续由 OMP 原生配置负责。
- 不把管理令牌通过 URL 传递；访问凭证页面只在管理令牌鉴权后返回。
- 不自动替用户开放公网端口；监听地址、反代和中转仍需显式配置。
- 更完整的用户/多租户 RBAC、审计日志、证书自动签发属于后续阶段，不用伪实现冒充完成。

## 验收标准

- 无桌面 Linux 环境可以通过一个安装命令得到可启动的管理器和后端服务。
- `ompiui-admin tui` 可在纯终端中查看并控制后端。
- 管理 Web UI 不依赖 `packages/app`，可查看 token、浏览器链接和隧道状态，并控制服务生命周期。
- 管理接口无令牌返回 401，错误管理令牌不会泄露状态或凭证。
- OMPiUI 原有编程前端和现有服务 API 行为不变。

## 交付记录（2026-10-06）

- `@ompiui/admin`：config/manager/server/tui/cli + 管理静态页；生命周期（start/stop/restart/status）与鉴权测试接入根 `npm test`。
- 修掉的管理器缺陷：省略命令字的 flag 调用（`ompiui-admin --port N`）误判为未知命令；管理令牌无条件打进服务日志；后端探测失败污染服务错误状态；主动 stop 显示为 exited；退出 TUI 后遗留无主后端进程（现在退出时确认停止/提示接管，且 start 检测到外部后端时给出明确错误）；Web UI 保存配置会清空中转密钥；缺后端监听地址/端口字段。
- 部署：`scripts/install-server.sh` 支持裸 VPS 引导克隆、精确 Node >=22.19 检查、`loginctl enable-linger`；`deploy/Dockerfile` 加 HEALTHCHECK，新增 `deploy/docker-compose.yml`、根 `.dockerignore` 与 `deploy/README.md`。
- issue #24：设置 → 服务器里内置 Local 条目开放编辑（仍不可删除）；`resolveHealthBaseUrl` 与 `getApiBase` 在默认条目被改过地址后直连保存值，选中的远程服务器不再被构建期 `VITE_OMPIUI_API` 钉死。
