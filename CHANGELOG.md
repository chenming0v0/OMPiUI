# Changelog

OMPiUI 自己的版本从 0.1.0 起算。`packages/app/CHANGELOG.md` 是上游 PiUI 历史，不参与本仓库发版。

## [Unreleased]

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
