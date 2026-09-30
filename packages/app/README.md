# @ompiui/app

OMPiUI 的前端包：React 19 + Vite 单页应用，外加 Tauri 桌面/移动壳（`src-tauri/`）。

视觉外壳来自 [PiUI](https://github.com/lehhair/PiUI)（lehhair 的开源客户端），OMPiUI 在其上把数据源换成 OMP RPC。项目说明、架构和运行方式见[仓库根 README](../../README.md)。

## 目录

- `src/` — 前端源码：`features/chat`（聊天流、模型选择）、`features/settings`（设置中心）、`components`（通用组件）、`api`（server HTTP/WS 客户端）、`pi/vendor`（按 Pi SDK 0.84.2 内联的类型声明）
- `src-tauri/` — Tauri 壳：托管 server 子进程（`src/service/`）、应用图标、打包配置
- `public/` — PWA 静态资源（manifest、图标）
- `scripts/` — 构建辅助（material icons 复制、release 准备）

## 常用命令

```bash
npm run dev          # Vite 开发服务器（HMR），配合根目录 npm run dev:server:omp 使用
npm run typecheck    # tsc -b
npm run lint         # eslint
npm run test:run     # vitest
npm run build        # 类型检查 + vite build
npm run tauri:dev    # Tauri 桌面壳开发模式
npm run tauri:build  # Tauri 桌面打包
```

## License

GPL-3.0-only（继承 PiUI），许可证正文见[仓库根 LICENSE](../../LICENSE)。
