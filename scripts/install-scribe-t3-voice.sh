#!/bin/bash
# Manages the LaunchAgent that bridges Scribe live voice commands to T3 Code (Custom)
# and records triggered commands inline in Scribe.
#
#   scripts/install-scribe-t3-voice.sh --install
#   scripts/install-scribe-t3-voice.sh --status | --restart | --uninstall
set -euo pipefail

LABEL="com.t3code.scribe-voice"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHER="$SCRIPT_DIR/scribe-t3-voice.mjs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/T3Code"
LOG_FILE="$LOG_DIR/scribe-t3-voice.log"
DOMAIN="gui/$(id -u)"
NODE_BIN="$(command -v node)"
INLINE_MODE="${T3_SCRIBE_INLINE_MODE:-reply}"
ACTION="dry-run"

while [ $# -gt 0 ]; do
  case "$1" in
    --install|--status|--uninstall|--restart) ACTION="${1#--}"; shift ;;
    --inline-mode) INLINE_MODE="$2"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "install-scribe-t3-voice: unknown argument $1" >&2; exit 64 ;;
  esac
done

plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/taskpolicy</string>
    <string>-a</string>
    <string>$NODE_BIN</string>
    <string>$WATCHER</string>
    <string>--inline-mode</string>
    <string>$INLINE_MODE</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string>
    <key>SCRIBE_AGENT</key>
    <string>t3-voice</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
PLIST
}

status() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E '^[[:space:]]*(state|pid|last exit code|runs) =' | sed -E 's/^[[:space:]]+/launchd: /' | head -4
  else
    echo "launchd: $LABEL is not loaded"
  fi
  [ -f "$LOG_FILE" ] && tail -5 "$LOG_FILE" | sed 's/^/log: /' || true
}

case "$ACTION" in
  dry-run)
    echo "install-scribe-t3-voice: dry run (pass --install to write and load $PLIST)"
    echo
    plist
    ;;
  install)
    chmod +x "$WATCHER" "$SCRIPT_DIR/t3-control.mjs"
    mkdir -p "$HOME/.local/bin" "$LOG_DIR" "$(dirname "$PLIST")"
    ln -sf "$SCRIPT_DIR/t3-control.mjs" "$HOME/.local/bin/t3-ctl"
    ln -sf "$WATCHER" "$HOME/.local/bin/scribe-t3-voice"
    plist > "$PLIST.tmp" && mv "$PLIST.tmp" "$PLIST"
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.25; done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 1
    status
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    sleep 1
    status
    ;;
  status)
    status
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
esac
