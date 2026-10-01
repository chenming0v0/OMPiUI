# OMPiUI 代码审查 — 待提交的 GitHub Issues

> 审查范围：全仓库（packages/app、packages/server、packages/omp-worker、packages/protocol、src-tauri、scripts、.github）。
> 审查日期：2026-10-02。按第一性原则：半实现的功能、没清理的旧代码、不该出现的东西、该拆没拆、该复用没复用。
> 每条的标题可直接用于 GitHub issue；正文含证据（文件:行号）与建议修法。

---

## Issue 1（高）桌面壳仍查找 `pi-worker(.exe)`，但打包产物已改名为 `omp-worker(.exe)` —— 桌面版无法启动内嵌 server

- **证据**
  - `packages/app/src-tauri/src/service/process.rs:68-72`：`server_binary()` 回退名仍是 `"pi-worker.exe"` / `"pi-worker"`。
  - `scripts/prepare-tauri-resources.mjs:14` 与 `scripts/package-desktop.mjs:63` 产出的都是 `omp-worker(.exe)`。
  - `.github/workflows/desktop-release.yml` 只跑 `prepare-tauri-resources.mjs`，不设置 `OMPIUI_SERVER_BIN`。
- **影响**：桌面壳 spawn 内嵌 server 时必然命中 `"OMPiUI server binary was not bundled in ..."` 报错。v0.1.1 的 rebrand 改了二进制名但漏改了 Rust 查找逻辑；此后没有任何 release 真正发布过（v0.1.1 因 Android 签名 secrets 缺失静默失败），所以这个回归一直没暴露。属发布阻断级问题。
- **建议**：`process.rs` 回退名改为 `omp-worker(.exe)`，最好与打包脚本共享同一个命名常量，避免再次失同步。

---

## Issue 2（中）"使用宿主机 Pi SDK" 开关是死设置：`OMPIUI_USE_SYSTEM_PI` / `OMPIUI_SDK_PATH` 没有任何消费方

- **证据**
  - UI 开关：`packages/app/src/features/settings/components/ServiceSettings.tsx:244-248`（Toggle + 文案）。
  - store：`packages/app/src/store/serviceStore.ts:82-116`（`useSystemPiSdk` 读写 `OMPIUI_USE_SYSTEM_PI`），`:17` 默认 env 里还有假路径 `{ key: 'OMPIUI_SDK_PATH', value: '/path/to/pi-coding-agent' }`。
  - 文案：`packages/app/src/locales/{zh-CN,en}/settings.json:92-93`（"从全局安装的 Pi 加载 SDK，而不是使用随 OMPiUI 打包的版本"）。
  - Rust 透传：`packages/app/src-tauri/src/service/mod.rs:884,901`。
  - **server 与 omp-worker 全仓搜索 `OMPIUI_SDK_PATH` / `OMPIUI_USE_SYSTEM_PI` / `sdkPath` / `systemPi` 均无任何读取方**。
- **影响**：v0.1.0 已把打包的 Pi SDK 依赖移除（只保留 vendored 类型），"随 OMPiUI 打包的 SDK" 已不存在；该开关只是往环境变量里写一个没人读的值，纯死功能 + 误导文案。还出现在设置搜索目录里（`settingsSearchCatalog.ts:31`）。
- **建议**：删除开关、`useSystemPiSdk` store 字段、相关 locale、Rust 测试里的透传断言与默认 env 里的假 `OMPIUI_SDK_PATH`。

---

## Issue 3（中）`packages/app/src-router/` 是名为 `opencodeui-router` 的遗留 Rust crate，全仓库零引用

- **证据**
  - `packages/app/src-router/Cargo.toml`：`name = "opencodeui-router"`，独立于 npm workspace 与 Tauri 的 Cargo 工程。
  - `packages/app/src-router/src/main.rs:23`：绑定 `0.0.0.0:7070` 起 HTTP 服务（axum），包含 `caddy.rs` / `router.rs` / `scanner.rs` / `state.rs` / `router.html`。
  - 全仓库（scripts、package.json、.github workflows、src-tauri 的 Cargo.toml/build.rs、tauri.conf.json）搜索 `src-router` / `opencodeui-router` 无任何引用，不在任何构建链上。
- **影响**：疑似早期实验/上游遗留，带着自己的 Cargo.lock 躺在 app 包里，既不构建也不运行，纯死重量；若有人在 app 目录跑 `cargo build` 还会误编一个无关的 7070 端口服务。
- **建议**：删除；如果是想保留的实验代码，移到已被 `.gitignore` 覆盖的 `scratch/` 目录。

---

## Issue 4（中）UI 把 OMP 运行时版本显示成 `Pi v{version}`，协议字段名也仍是 `piSdkVersion`

- **证据**
  - `packages/app/src/features/settings/components/ServersSettings.tsx:88`：`· Pi v${health.version}`。
  - `packages/omp-worker/src/entry.ts:577`：`piSdkVersion: detectedOmpVersion(...)` —— 填的其实是 **OMP** 版本。
  - `packages/protocol/src/index.ts:22-24`：`HealthResponse` 的 `piSdkVersion` / `piSdkVerified` / `piSdkFallback`；`packages/protocol/src/version.ts:4`：`PI_PARITY_SDK_VERSION = "18.3.1"`。
  - `packages/app/src/store/serverStore.ts:573`：`version: data.piSdkVersion`。
- **影响**：rebrand 没做完的残留。设置页服务器列表显示 "Pi v18.3.1"（实际是 OMP 版本），语义误导用户以为在跑 Pi SDK；协议字段命名与新运行时（OMP）不符，后续接入方会困惑。
- **建议**：字段重命名为 `ompVersion`/`ompVerified` 等，UI 显示 `OMP v{version}`；`PI_PARITY_SDK_VERSION` 同时更名（如 `OMP_PARITY_VERSION`）。

---

## Issue 5（中）rebrand 未完成：运行中的代码大量保留 Pi 前缀命名

- **证据**（都是当前活跃代码，非死代码）
  - `packages/app/src/features/pi-chat/PiChatPane.tsx`（`App.tsx:510` 使用）、`features/settings/components/PiManagementSettings.tsx` / `PiSessionManagement.tsx` / `PiResourceManagement.tsx`。
  - `packages/app/src/omp/controllers/index.ts:396,499`：`sendPiSteer` / `sendPiFollowUp` / `forkPiSession`。
  - `packages/app/src/omp/state/`：`piCommandStore` / `piSessionInfoStore` / `piBranchStore` / `piSessionStateStore` / `piModelsStore`（被 `omp/hooks/index.ts`、`omp/transport/index.ts` 运行时使用）。
  - 协议 capability source 默认值 `"pi-sdk"`（`packages/protocol/src/pi-command-specs.ts:44`），WS 事件通道名 `pi.event`（`packages/omp-worker/src/entry.ts`），README 架构图 `packages/app/README.md` 也仍画 `pi.event`。
- **影响**：不影响功能，但新开发者会被 "Pi" 命名误导（以为还有 Pi 运行时）；OMPiUI 对外文档与内部符号不一致。
- **建议**：一次性纯重命名（`PiChatPane→ChatPane`、store 去掉 `pi` 前缀、`sendPi*→send*`、source `pi-sdk→omp`、通道 `pi.event→omp.event` 并同步协议/README），行为不变，可分 PR 做。

---

## Issue 6（低）根 `package.json` 的 `dev:server:pi` 是 rebrand 残留，且与实际入口、README 不一致

- **证据**
  - `package.json:16`：`"dev:server:pi": "node scripts/dev-server-omp.mjs"` —— 脚本名带 pi，执行的却是 omp 脚本。
  - `package.json:42` 已存在同义脚本 `"dev:server:omp"`。
  - `scripts/dev.mjs:46`（`npm run dev` 入口）实际调用的是 `dev:server:pi`；而 `README.md:53` 文档写的是 `dev:server:omp`。
- **影响**：文档与真实启动路径不一致，两个脚本并存易混淆。
- **建议**：删除 `dev:server:pi`，`dev.mjs` 改调 `dev:server:omp`。

---

## Issue 7（低）app `package.json` 的 `test:pi` 指向已不存在的 `src/pi`

- **证据**
  - `packages/app/package.json:18`：`"test:pi": "vitest run src/pi"` —— 目录 v0.1.1 已整体改名 `src/omp`，`src/pi` 不存在。
  - `packages/app/package.json:4`：`"description": "Pi coding agent client UI"` 也未更新。
- **建议**：删除 `test:pi` 或改为 `vitest run src/omp`；description 改为 OMPiUI 描述。

---

## Issue 8（低）根 `.gitignore` 引用不存在的 `assets/build/pi.ico` / `pi-256.png`

- **证据**
  - `.gitignore:5-8`：`!packages/app/assets/build/`、`packages/app/assets/build/*`、`!.../pi.ico`、`!.../pi-256.png`。
  - `packages/app/assets/` 下只有 `app-icons/`，`assets/build/` 已不存在；图标来源已改为 `src-tauri/app-icon.manifest.json` + `tauri icon`。
- **建议**：删除这几行死条目。

---

## Issue 9（低）无人引用的脚手架/脚本残留

- **证据**
  - `scripts/make-android-icons.ps1`：全仓库（package.json、.github workflows）无引用。
  - `packages/app/public/vite.svg`、`packages/app/src/assets/react.svg`：Vite 脚手架残留，`index.html` 实际用 `ompiui.svg`，全仓搜索无引用。
  - `packages/app/LICENSE`：与根 `LICENSE`（权威副本，v0.1.1 起移到根）重复。
- **建议**：删除以上文件。

---

## Issue 10（低）超大组件文件（继承自 PiUI），可考虑拆分

- **证据**（行数）：`FileExplorer.tsx` 1943、`DiffViewer.tsx` 1886、`InputBox.tsx` 1861、`PiChatPane.tsx` 1779、`MarkdownRenderer.tsx` 1557、`SidePanel.tsx` 1391、`omp-session.ts` 1222、`ChatArea.tsx` 1242。
- **说明**：多数为上游 PiUI 资产继承而来，功能正常，拆分优先级低；但 `omp-session.ts`（1222 行，OMP RPC 会话适配）是本仓库自己的核心文件，建议优先拆（如事件适配 / 历史构建 / 子代理回退分模块）。
- **建议**：作为后续可维护性 refactor 项，非阻断。

---

## 备注（未列为 issue 的观察项）

- `packages/app/src-tauri/gen/android/` 连同 gradle-wrapper.jar 等生成物已入库，与 `icons/android/` 图标重复 —— Tauri 官方建议提交 gen/android 以便可复现构建，故不列 issue，仅提示可清理重复图标目录。
- `protocol/src/pi-command-specs.ts` 虽带 Pi 前缀，但确实是 omp-worker `command-table.ts` 的单一事实源，功能在用，归入 Issue 5 的命名清理范围。
- `OMPIUI_USE_SYSTEM_PI` 的 Rust 测试（`service/mod.rs:884`）与 app 测试里的断言会随 Issue 2 一并删除。
