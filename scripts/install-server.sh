#!/usr/bin/env bash
set -Eeuo pipefail

# One-command OMPiUI server install for a headless Linux box (VPS / container host).
# Installs dependencies, builds, generates the management token, and registers a
# systemd user service that runs the `ompiui-admin` manager (Web UI + TUI).
#
# Usage:
#   bash scripts/install-server.sh [repo-directory]
#   curl -fsSL https://raw.githubusercontent.com/chenming0v0/OMPiUI/dev/scripts/install-server.sh | bash
#
# Environment overrides:
#   OMPIUI_ADMIN_HOST  management bind address (default 127.0.0.1; use 0.0.0.0 only behind HTTPS)
#   OMPIUI_ADMIN_PORT  management port (default 9898)
#   OMPIUI_DATA_DIR    state directory (default ~/.ompiui)
#   OMPIUI_REPO        git URL used when bootstrapping without a local checkout

DATA_DIR="${OMPIUI_DATA_DIR:-$HOME/.ompiui}"
ADMIN_HOST="${OMPIUI_ADMIN_HOST:-127.0.0.1}"
ADMIN_PORT="${OMPIUI_ADMIN_PORT:-9898}"

ROOT=""
if [ -n "${1:-}" ]; then
  ROOT="$(cd "$1" && pwd)"
elif [ -f "$(dirname "${BASH_SOURCE[0]}")/../package.json" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Piped over curl (or run outside a checkout): clone the repo first.
if [ -z "$ROOT" ]; then
  ROOT="$DATA_DIR/app"
  REPO="${OMPIUI_REPO:-https://github.com/chenming0v0/OMPiUI.git}"
  mkdir -p "$DATA_DIR"
  if [ -d "$ROOT/.git" ]; then
    echo "Updating existing checkout in $ROOT"
    git -C "$ROOT" fetch --depth 1 origin dev
    git -C "$ROOT" reset --hard FETCH_HEAD
  else
    echo "No local checkout found; cloning $REPO (branch dev) into $ROOT"
    git clone --depth 1 -b dev "$REPO" "$ROOT"
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js >= 22.19 and npm are required (https://nodejs.org or nvm)" >&2
  exit 1
fi
NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  echo "Node.js >= 22.19 is required; found v$NODE_VERSION" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

cd "$ROOT"
npm install --include=dev
npm run build
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/ompiui-admin.service"
mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OMPiUI headless server manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=OMPIUI_DATA_DIR=$DATA_DIR
Environment=OMPIUI_ADMIN_DATA_DIR=$DATA_DIR
Environment=OMPIUI_SERVER_ENTRY=$ROOT/packages/server/dist/bundle-entry.js
ExecStart=$(command -v node) $ROOT/packages/admin/dist/cli.js web --host $ADMIN_HOST --port $ADMIN_PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
chmod 600 "$SERVICE_FILE"

if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  systemctl --user enable --now ompiui-admin.service
  # Without linger the user manager (and the service) dies on logout.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || \
      echo "note: could not enable linger automatically; run 'sudo loginctl enable-linger $USER' so the service survives logout" >&2
  fi
  echo
  echo "OMPiUI manager installed: http://$ADMIN_HOST:$ADMIN_PORT/"
  if [ "$ADMIN_HOST" = "127.0.0.1" ] || [ "$ADMIN_HOST" = "localhost" ]; then
    echo "Open it through an SSH tunnel:  ssh -L $ADMIN_PORT:127.0.0.1:$ADMIN_PORT <user>@<server>"
  fi
  echo "Management token:"
  if [ -n "${OMPIUI_ADMIN_TOKEN:-}" ]; then
    echo "  (from the OMPIUI_ADMIN_TOKEN environment variable)"
  else
    cat "$DATA_DIR/admin-token"
  fi
  echo "Manage from a terminal anytime:  $ROOT/packages/admin/dist/cli.js tui"
else
  echo "Created $SERVICE_FILE but systemd user services are unavailable (or not running as a real user)."
  echo "Start manually: $(command -v node) $ROOT/packages/admin/dist/cli.js web --host $ADMIN_HOST --port $ADMIN_PORT"
  echo "Or use the TUI:  $(command -v node) $ROOT/packages/admin/dist/cli.js tui"
  echo "Management token:"
  if [ -z "${OMPIUI_ADMIN_TOKEN:-}" ]; then
    cat "$DATA_DIR/admin-token" 2>/dev/null || true
  fi
fi
