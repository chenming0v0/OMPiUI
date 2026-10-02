# Changelog

OMPiUI 自己的版本从 0.1.0 起算。`packages/app/CHANGELOG.md` 是上游 PiUI 历史，不参与本仓库发版。

## [Unreleased]

- feat: session goal bar（会话目标栏）— 输入框上方常驻目标状态入口：无目标时显示"设定目标"，点击弹出编辑器（桌面为锚在输入框上方的浮层卡片，移动端为底部弹层 sheet + 文本域），保存即设定；有目标时显示状态（进行中/已暂停/预算受限/已完成）+ 目标内容 + 已用时长，并提供暂停/恢复、编辑、放弃三个操作。因为 OMP 的 `--mode rpc` 不注册 goal 隐藏工具、也没有 goal RPC 命令（实测 18.3.x，`/goal` 走 prompt 只会变成普通消息发给模型），目标注册表由 OMPiUI worker 自己维护：新增 `goal` 会话命令（set/pause/resume/drop，确定性变更、不经过模型），worker 在 active 目标下每次会话 settle 后自动发送一条续跑 prompt（上限 50 轮，模型以行尾 `GOAL_COMPLETE` 标记完成），abort 自动暂停目标（对齐 OMP goal 模式语义）；状态经 `state.get` 的 `goal` 字段 + 合成 `goal_updated` 事件到达前端，前端目标栏经 piSessionStateStore 订阅渲染。目标只随 worker 进程存活（RPC 无自定义条目可持久化），worker 重启后等下一次目标操作恢复
- fix: chat virtualizer 偶发崩溃（"Cannot read properties of undefined (reading 'index'/'start')"）— virtual-core 3.17 的 `getVirtualItems()` 在 measurementsCache 有空洞时会产出 undefined 项（ChatArea 的 overrides 用到 `measurementsCache: (VirtualItem | undefined)[]`），渲染 map 与 Outline 视口行扫描现在跳过空洞项，不再让整个聊天区撞上错误边界
- fix: OMP 会话时间线不再显示"未支持的条目：mode_change" — OMP 18.x 在 Pi 条目联合之外扩展的 agent 模式切换标记（goal/plan，`mode: "none"` 表示退出；目标栏设定目标时会写入该条目）现渲染为一条模式分隔条（如"已切换到目标模式"）；同时把同批扩展的记账/元数据条目（`title_change` 自动标题、`service_tier_change`/`ttsr_injection`/`credential_pin`/`reset_boundary`）与 `model_change` 等元数据一致处理：`title_change` 在 worker 两条路径（RPC adaptEntry + 磁盘预览）丢弃为 `omp.dropped` 占位，其余在时间线静默跳过、session 树过滤并补齐展示名，时间线与树都不再出现"未支持的条目"

## [v0.2.0] - 2026-10-01

- feat: OMP subagent (child) sessions now nest under their parent session in the sidebar — selecting a session lists its `session.children` (OMP writes subagent transcripts to `<parent>.jsonl/<agentId>.jsonl`), child rows render indented like OpenCodeUI children, clicking opens the child session (resolved by id through the catalog deep scan), the rows stay put while a child session itself is selected, and the list refetches when the sessions-changed event fires so freshly landed child sessions appear on their own. Disk session preview also replaces `session_init`/`title`/`session`/`model_usage` metadata entries with `omp.dropped` placeholders like the RPC path already did, so opening a child session no longer shows an "Unsupported entry: session_init" divider at the top of its timeline
- feat: the Task tool's inline Subtask view survives reopens — OMP's RPC subagent registry is in-process and drops terminal runs, so after a worker restart / page reload / opening the session from another instance the panel used to show an eternal "waiting for response"; the renderer now rebuilds a read-only completed run from the persisted task result `details.results[]` (id/agent/task/exit code), derives the child transcript file (`<outputPath 目录>/<id>.jsonl`, falling back to the parent session's sibling directory), and the worker's `subagent.messages` command falls back to reading the child session jsonl from disk (realpath-locked to `~/.omp/agent/sessions`) when a fresh omp process rejects the session file — transcripts are fully disk-backed
- feat: public sharing for the web panel (#8) — a configurable public base URL (`OMPIUI_PUBLIC_BASE_URL` env / `--public-base-url` flag / 设置 → 服务 → 网络监听 input) becomes the source of truth for share links, the startup log and the Origin allowlist once set, instead of guessing the first non-loopback IPv4 which is unreachable from the public internet; the share panel now shows a browser-openable URL (with an open-in-tab action) next to the `ompiui://connect` deep link, picks its hint by exposure mode (loopback / LAN / public), and the public path documents the reverse-proxy/tunnel requirement with HTTPS advice plus an explicit warning that anyone holding the link can read the workspace, open terminals, run commands and drive the agent. The Origin check accepts the configured public origin even when the proxy rewrites the Host header; invalid public base URLs are ignored with a warning at startup
- fix: the web model list now picks up `~/.omp/agent/models.yml` edits without a restart (#11) — the worker watches the file (directory watch + content-hash dedupe, so atomic editor saves are caught) and on change recycles the provider-auth bound client, because the long-lived `omp --mode rpc` control process only reads models.yml at startup and `modelRuntime.refresh`/`reload` were just re-querying the same stale process; the worker also broadcasts a new `models.updated` event over the server stream, and the web app responds by refetching the model selector list and bumping the provider revision for the settings page. Settings 刷新/重新加载 now recycle the process too, and an in-flight OAuth login flow defers the recycle so it is not killed mid-flow
- refactor: drop the model quick-config section in favor of OMP model roles — the roles list with its DEFAULT role is now the single place to assign models (`ModelQuickConfig` → `ModelRolesSettings`), the preferred-model-changed listener goes away with it, and the composer keeps remembering the last model picked in chat; also exports the `MoreVerticalIcon` the roles section uses
- fix: worker `tree.get` returns the SDK's nested `{ entry, children, label }` shape instead of a flat `{ id, parentId }` array, so the session tree panel no longer crashes on `node.entry.id` (#10)
- ci: the release workflow skips the Android APK when the `ANDROID_KEYSTORE_*` signing secrets are not configured (they never were, which is why v0.1.1 published nothing) — desktop/portable assets ship without Android until the keystore secrets are set, and the release body only advertises the Mobile line when APKs are actually attached

## [0.1.1] - 2026-09-30

- chore: finish the PiUI → OMPiUI rebrand across the desktop shell, service and protocol names. Desktop/mobile identity becomes `OMPiUI` with Tauri identifier `com.ompiui.app` (was `com.piui.app`), Rust crate/binary `ompiui`/`ompiui_lib` (was `piui`/`piui_lib`), Android package `com.ompiui.app` with the Java package moved to `com/ompiui`, and the Windows right-click "Open with OMPiUI" registry keys (uninstall also removes the legacy PiUI keys). The bundled server binary is renamed `pi-worker.exe` → `omp-worker.exe` with the `--omp-worker` flag and `@ompiui/omp-worker` package name, and `packages/server/src/pi` / `packages/app/src/pi` move to `src/omp` (`dev-server-pi.mjs` → `dev-server-omp.mjs`)
- chore: rename the service protocol identifiers — WS subprotocol `piui.events.v1` → `ompiui.events.v1`, share links generate `ompiui://connect` (parser still accepts legacy `piui://connect`), `piui-service.json` service marker → `ompiui-service.json`, server logs and temp/backup file prefixes → `ompiui-*`, and every `PIUI_*` environment variable (`PIUI_DRIVER`, `PIUI_PORT`, `PIUI_HOST`, `PIUI_AUTH_TOKEN`, `PIUI_DATA_DIR`, `PIUI_SDK_PATH`, `PIUI_NATIVE_MODULES`, `PIUI_SERVER_BIN`, `PIUI_CURSOR_SECRET`, `PIUI_FIXTURE_*`…) → `OMPIUI_*`; `PIUI_EMBEDDED` is untouched because it is part of the contract with the external `omp` CLI
- feat: one-time local data migration on boot — localStorage keys `piui:`/`piui-` (including per-server `srv:{id}:piui-*`) rename to their `ompiui` equivalents, the custom-sound IndexedDB database `piui-sounds` copies over to `ompiui-sounds`, stored service env var names get the same `PIUI_` → `OMPIUI_` rename, server settings and update-check caches keep read-once legacy fallbacks, and settings backup files exported by the old version still import (new exports use `ompiui-settings-backup-*.json`)
- breaking: the Tauri identifier change moves the WebView profile and app-data directory (`%APPDATA%\com.piui.app` → `com.ompiui.app`), so browser-view settings do not carry over between old and new installs; server-side data in `~/.ompiui` and legacy `~/.piui` tokens still migrate automatically
- fix: OMP sessions no longer hang ~150s on old OMP CLIs — the worker probes `omp --version` at startup and fails session open fast below 18.2.11 with an upgrade hint (`OMP_TOO_OLD`); id-less error responses from older omp are matched to in-flight requests by command name and rejected immediately; about/registry now show the detected real version instead of the hardcoded 18.3.1, and the README documents the minimum OMP version (#5)
- fix: subagent transcripts no longer render the session header as "Unsupported entry" — the OMP worker drops `session`/`session_init` metadata entries like `title`/`model_usage`, and the timeline selector skips the `omp.dropped` placeholders those drops leave behind to keep the branch chain intact (#6)

- fix: unify on-disk state under `~/.ompiui` — auth token/cursor secret/workspace locks move from `~/.piui`, server file logs leave `%APPDATA%\com.piui.desktop` for `com.ompiui.desktop`, and the standalone exe native-module fallback prefers `com.ompiui.desktop`; the PiUI-era locations get a one-time read migration so existing tokens stay valid and the legacy dir is never written
- chore: GPL-3.0 `LICENSE` now sits at the repo root (text inherited from packages/app) so GitHub's license API detects it
- docs: replace the leftover upstream OpenCodeUI README in packages/app with an OMPiUI package readme pointing at the root README
- fix: model selector dropdowns in settings now render above the dialog — ModelSelector forwards a zIndex prop, quick config passes 400 like SettingsSelect
- feat: quick model config in settings — default model + thinking level (client prefs, applied to new sessions) and OMP model-role assignments (all 15 roles, persisted via `omp config` CLI into modelRoles, hot-reloaded by running OMP processes)
- fix: settings 管理 tab no longer white-screens — OMP worker returns contract-complete provider/runtime snapshots, UI reads optional fields defensively, and error boundaries now contain panel crashes
- fix: about-page update check ignores cached PiUI releases

## [v0.1.0] - 2026-09-26

- ci: add validate, desktop release, and main-from-dev policy (f659469)
- fix: point release checks and version bump at OMPiUI (667ee6f)
- chore: update piui → ompiui references in service checks and tests (f3c4b1c)
- chore: ignore detached server logs (636d43c)
- fix: fail fast on missing session cwd, include omp stderr in crash logs (3a88fac)
- refactor(app): drop @earendil-works SDK dependency, vendor Pi SDK types (3d95604)
- refactor: rename workspace scope @piui/* to @ompiui/* (b7a6cdd)
- fix: regenerate node-pty patch for 1.2.0-beta.15 (3a510ad)
- feat: replace sidebar logo with OMPiUI gradient mark (7ea8e9b)
- fix: dynamic document title brand (a3219f7)
- docs: README + PLAN results; rebrand user-visible strings to OMPiUI (689cd5b)
- fix: subagent store snapshot caching (React #185), toolSteps i18n keys (03a3c8c)
- feat: OMP RPC worker runtime (omp --mode rpc), subagent channel, OMP catalog (b0f29cb)
- docs: add project plan (5ad6e47)
- chore: init repo with gitignore (91c4087)
