#!/usr/bin/env bash
# Install the handoff daemon as a managed per-user service (slice 3b deploy gate).
# macOS  -> launchd LaunchAgent, KeepAlive.
# Linux  -> systemd user service, Restart=always.
# Idempotent: re-running reinstalls and restarts. Safe to read before running.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="$REPO_DIR/handoff-daemon.js"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
[ -f "$DAEMON" ] || { echo "daemon not found at $DAEMON"; exit 1; }
mkdir -p "$HOME/.claude-handoff"

subst() { sed -e "s#@NODE@#$NODE#g" -e "s#@DAEMON@#$DAEMON#g" -e "s#@HOME@#$HOME#g" "$1"; }

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.handoff.daemon.plist"
    subst "$REPO_DIR/deploy/com.handoff.daemon.plist.template" > "$PLIST"
    launchctl bootout "gui/$(id -u)/com.handoff.daemon" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    launchctl kickstart -k "gui/$(id -u)/com.handoff.daemon"
    echo "Installed launchd agent. Status: launchctl print gui/$(id -u)/com.handoff.daemon | grep state"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    subst "$REPO_DIR/deploy/handoff-daemon.service.template" > "$UNIT_DIR/handoff-daemon.service"
    systemctl --user daemon-reload
    systemctl --user enable --now handoff-daemon.service
    echo "Installed systemd user service. Status: systemctl --user status handoff-daemon"
    ;;
  *)
    echo "Unsupported OS: $(uname -s). Native cross-session messaging (and this daemon) run on macOS + Linux/WSL2 only."; exit 1 ;;
esac
echo "Daemon socket: ${HANDOFF_HOME:-$HOME/.claude-handoff}/daemon.sock"
